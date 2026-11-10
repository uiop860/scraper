import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { build } from "esbuild";

// Synthetic pages only. No marketplace traffic, OAuth, or saved Firefox profile.
let blockedHits = 0;
const external = createServer((_req, res) => {
  blockedHits++;
  res.end("must not load");
});
const server = createServer((req, res) => {
  if (req.url === "/redirect") {
    res.writeHead(302, {
      Location: `http://127.0.0.1:${external.address().port}/blocked`,
    });
    res.end();
    return;
  }
  res.setHeader("Content-Type", "text/html");
  if (req.url.startsWith("/detail/")) {
    res.end(`<p class="description">Detail ${req.url.at(-1)}</p>`);
    return;
  }
  const second = req.url.includes("page=2");
  res.end(`<!doctype html><main></main><aside></aside><script>
    setInterval(() => document.querySelector("aside").textContent = String(Date.now()), 50);
    setTimeout(() => document.querySelector('main').innerHTML = '<article><h2>Machine ${second ? 2 : 1}</h2><a href="/detail/${second ? 2 : 1}">View</a></article>${second ? "" : '<a rel="next" href="/list?page=2">Next</a>'}', 100);
  </script>`);
});
await Promise.all([
  new Promise((r) => external.listen(0, "127.0.0.1", r)),
  new Promise((r) => server.listen(0, "127.0.0.1", r)),
]);
const origin = `http://127.0.0.1:${server.address().port}`;
const directory = await mkdtemp(join(tmpdir(), "scraper-engine-firefox-"));
let child;
try {
  await cp("build", directory, { recursive: true });
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
  manifest.host_permissions.push(`${origin}/*`);
  manifest.background.scripts = ["smoke-background.js"];
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  async function compile(contents, name) {
    const result = await build({
      stdin: { contents, resolveDir: process.cwd(), loader: "ts" },
      bundle: true,
      format: "iife",
      platform: "browser",
      write: false,
    });
    await writeFile(join(directory, name), result.outputFiles[0].contents);
  }
  await compile(
    `
    import './extension/background';
    browser.runtime.onMessage.addListener((message) => {
      if (message.type === 'smoke.result') dump('SCRAPER_ENGINE_' + message.result + '\\n');
    });
    browser.tabs.create({url: browser.runtime.getURL('scraper.html')});
  `,
    "smoke-background.js",
  );
  await compile(
    `
    import { runScraper } from './extension/scraper/runner';
    import { browserDriver } from './extension/scraper/browser';
    const origin = ${JSON.stringify(origin)};
    const spec = {version:1, name:'Firefox fixture', list:{itemSelector:'article', fields:{
      title:{selector:'h2',value:'text'}, url:{selector:'a',value:'attribute',attribute:'href',resolveUrl:true}}},
      detail:{linkField:'url', fields:{description:{selector:'.description',value:'text'}}},
      pagination:{type:'next',selector:'a[rel=next]'}};
    async function open(url) {
      const source = await browser.tabs.create({url:'about:blank',active:false});
      await new Promise((resolve,reject) => {
        const timer=setTimeout(()=>{browser.tabs.onUpdated.removeListener(updated);reject(new Error('Source load timeout'));},5000);
        const updated=(id,change,tab)=>{if(id===source.id && change.status==='complete' && tab.url===url){clearTimeout(timer);browser.tabs.onUpdated.removeListener(updated);resolve();}};
        browser.tabs.onUpdated.addListener(updated);
        browser.tabs.update(source.id,{url}).catch(reject);
      });
      const before = await browser.tabs.get(source.id);
      if (!before.url) throw new Error('Source inaccessible: ' + JSON.stringify(before) + ' permissions: ' + JSON.stringify(await browser.permissions.getAll()));
      const worker = await browser.runtime.sendMessage({type:'scraper.worker.open', sourceTab:source.id});
      if (!worker?.ok) throw new Error(worker?.error ?? 'No worker response');
      return {worker, source};
    }
    (async () => {
      const {worker,source} = await open(origin + '/list');
      const result = await runScraper(spec,origin+'/list',browserDriver(worker.tab,origin),new AbortController().signal);
      if (result.status !== 'completed' || result.items.length !== 2 || result.pages.length !== 4 || result.items[1].detail.description !== 'Detail 2') throw new Error(JSON.stringify(result));
      await browser.tabs.remove(source.id);
      const redirected = await open(origin + '/list');
      const blocked = await runScraper(spec,origin+'/redirect',browserDriver(redirected.worker.tab,origin),new AbortController().signal);
      if (blocked.status !== 'failed' || blocked.items.length) throw new Error('Redirect was not blocked');
      await browser.tabs.remove(redirected.source.id);
      const rules = await browser.declarativeNetRequest.getSessionRules();
      if (rules.some(r => r.id >= 1000)) throw new Error('Worker rules leaked');
      await browser.runtime.sendMessage({type:'smoke.result',result:'PASS'});
    })().catch(async error => { console.error(error); await browser.runtime.sendMessage({type:'smoke.result',result:'FAIL ' + error.message}); });
  `,
    "scraper.js",
  );
  child = spawn(
    "web-ext",
    [
      "run",
      "--source-dir",
      directory,
      "--no-reload",
      "--no-input",
      "--verbose",
      "--args=-headless",
      "--pref=browser.dom.window.dump.enabled=true",
    ],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const outcome = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () =>
        reject(
          new Error(`Firefox scraper smoke timed out. ${output.slice(-4000)}`),
        ),
      40_000,
    );
    const observe = (chunk) => {
      output = (output + chunk.toString()).slice(-20_000);
      if (output.includes("SCRAPER_ENGINE_PASS")) {
        clearTimeout(timer);
        resolve(true);
      }
      if (output.includes("SCRAPER_ENGINE_FAIL")) {
        clearTimeout(timer);
        reject(new Error(output.slice(-5000)));
      }
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Firefox exited. ${output.slice(-2000)}`));
    });
  });
  if (!outcome || blockedHits)
    throw new Error(`Off-origin destination received ${blockedHits} requests.`);
  console.log(
    "Firefox scraper passed: rendered dynamic content, two listing pages, two detail pages, exact-origin redirect blocking before the destination received a request, and worker/rule cleanup.",
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGINT");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(() => {
        child.kill("SIGTERM");
        resolve();
      }, 3000).unref();
    });
  }
  await Promise.all([
    new Promise((r) => server.close(r)),
    new Promise((r) => external.close(r)),
  ]);
  await rm(directory, { recursive: true, force: true });
}
