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
  if (req.url === "/scroll") {
    res.end(`<div style="height:200vh"></div><article>First</article>
      <script>addEventListener('scroll', () => {
        document.querySelector('article').textContent = 'Second';
      }, {once:true});</script>`);
    return;
  }
  if (req.url.startsWith("/detail/")) {
    res.end(`<podium-layout></podium-layout><script>
      setTimeout(() => {
        const root = document.querySelector('podium-layout').attachShadow({mode:'open'});
        root.innerHTML = '<section data-testid="description"><p class="description" dir="auto">Preview<button>Se mere</button></p></section>';
        root.querySelector('button').onclick = () => root.querySelector('p').textContent = 'Detail ${req.url.at(-1)}';
      }, 150);
    </script>`);
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
  await cp(".output/firefox-mv3", directory, { recursive: true });
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
  manifest.host_permissions.push(`${origin}/*`);
  // This fixture replaces scraper.html with its own runner, not the sidebar UI.
  delete manifest.sidebar_action;
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
    import { registerBackground } from './extension/background';
    registerBackground();
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
    import { generateScraper } from './extension/scraper/agent';
    import { browserDriver } from './extension/scraper/browser';
    const origin = ${JSON.stringify(origin)};
    const spec = {version:1, name:'Firefox fixture', list:{itemSelector:'article', fields:{
      title:{selector:'h2',value:'text'}, url:{selector:'a',value:'attribute',attribute:'href',resolveUrl:true}}},
      detail:{linkField:'url', waitFor:{selector:'podium-layout >>> .description'}, fields:{description:{selector:'podium-layout >>> .description',value:'text',expandDescription:true}}},
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
      const generated = await open(origin + '/list');
      let turn = 0;
      const agentSpec = await generateScraper('Extract titles and descriptions across pages', origin+'/list', browserDriver(generated.worker.tab,origin), async (input) => {
        turn++;
        const name = turn <= 2 ? 'inspect_page' : turn === 3 ? 'test_scraper' : 'finish_scraper';
        if (turn === 2) {
          const inspected = JSON.parse(input.at(-1).output);
          if (!inspected.textRegions?.some(region => region.text.includes('Machine 1'))) throw new Error('Ordinary DOM text regions missing');
          if (!inspected.samples?.some(html => html.includes('Machine 1'))) throw new Error('Agent inspection missed rendered content: '+JSON.stringify(inspected));
        }
        if (turn === 3) {
          const inspected = JSON.parse(input.at(-1).output);
          if (!inspected.textRegions?.some(region => region.text.includes('Preview') && region.selector.includes('>>>'))) throw new Error('Deep text regions unavailable: '+JSON.stringify(inspected));
          if (!inspected.shadowRoots?.some(context => context.regions.some(region => region.text.includes('Preview')))) throw new Error('Shadow DOM was not discoverable: '+JSON.stringify(inspected));
        }
        if (turn === 4) {
          const tested = JSON.parse(input.at(-1).output);
          if (!tested.passed || tested.pages.length !== 3 || tested.pages[1].samples[0].description !== 'Detail 1') throw new Error('Agent test failed: '+JSON.stringify(tested));
        }
        const args = turn <= 2 ? {url:origin+(turn === 1 ? '/list' : '/detail/1'),selector:'body'} : {spec:JSON.stringify(spec)};
        return {output:[{type:'function_call',name,arguments:JSON.stringify(args),call_id:'call'+turn,id:'fc'+turn,status:'completed'}],text:''};
      }, new AbortController().signal);
      if (JSON.stringify(agentSpec) !== JSON.stringify(spec)) throw new Error('Agent JSON changed');
      await browser.tabs.remove(generated.source.id);
      const probing = await open(origin + '/detail/1');
      const probe = browserDriver(probing.worker.tab,origin);
      const itemUrl = origin + '/detail/1';
      const ready = await probe.probe(itemUrl,'wait_for_content',{url:itemUrl,selector:'podium-layout >>> .description',text:'Preview',absentSelector:''},new AbortController().signal);
      if (ready.matches !== 1) throw new Error('Content wait failed');
      const found = await probe.probe(itemUrl,'search_text',{url:itemUrl,text:'Preview'},new AbortController().signal);
      if (found.matches.length !== 1) throw new Error('Text search failed');
      const surroundings = await probe.probe(itemUrl,'inspect_element',{url:itemUrl,selector:found.matches[0].element.selector},new AbortController().signal);
      if (!surroundings.samples[0].children.length) throw new Error('Element inspection failed');
      const expanded = await probe.probe(itemUrl,'expand_disclosure',{url:itemUrl,selector:'podium-layout >>> button'},new AbortController().signal);
      const compared = await probe.probe(itemUrl,'compare_fields',{url:itemUrl,itemSelector:'podium-layout >>> .description',fields:[{name:'description',selector:':scope',attribute:''}]},new AbortController().signal);
      if (compared.samples[0][0].sources[0].value !== 'Detail 1') throw new Error('Disclosure/field comparison failed');
      let refused = false;
      try { await probe.probe(itemUrl,'expand_disclosure',{url:itemUrl,selector:'podium-layout >>> .description'},new AbortController().signal); } catch { refused = true; }
      if (!refused) throw new Error('Non-disclosure click accepted');
      await probe.close();
      await browser.tabs.remove(probing.source.id);
      const {worker,source} = await open(origin + '/list');
      await browserDriver(worker.tab,origin).probe(origin+'/list','wait_for_content',{url:origin+'/list',selector:'h2',text:'Machine 1',absentSelector:''},new AbortController().signal);
      const ordinary = await browserDriver(worker.tab,origin).probe(origin+'/list','search_text',{url:origin+'/list',text:'Machine 1'},new AbortController().signal);
      if (!ordinary.matches.length) throw new Error('Ordinary DOM text search missing');
      const result = await runScraper(spec,origin+'/list',browserDriver(worker.tab,origin),new AbortController().signal);
      if (result.status !== 'completed' || result.items.length !== 2 || result.pages.length !== 4 || result.items[1].detail.description !== 'Detail 2') throw new Error(JSON.stringify(result));
      await browser.tabs.remove(source.id);
      const scrolling = await open(origin + '/scroll');
      const scrollSpec = {version:1,name:'Scroll',identityField:'title',list:{itemSelector:'article',scrollToItems:2,fields:{title:{selector:':scope',value:'text'}}}};
      const collected = await runScraper(scrollSpec,origin+'/scroll',browserDriver(scrolling.worker.tab,origin),new AbortController().signal);
      if (collected.items.map(item => item.data.title).join(',') !== 'First,Second') throw new Error(JSON.stringify(collected));
      await browser.tabs.remove(scrolling.source.id);
      const redirected = await open(origin + '/list');
      const blocked = await runScraper(spec,origin+'/redirect',browserDriver(redirected.worker.tab,origin),new AbortController().signal);
      if (blocked.status !== 'failed' || blocked.items.length) throw new Error('Redirect was not blocked: ' + JSON.stringify(blocked));
      await browser.tabs.remove(redirected.source.id);
      const rules = await browser.declarativeNetRequest.getSessionRules();
      if (rules.some(r => r.id >= 1000)) throw new Error('Worker rules leaked');
      await browser.runtime.sendMessage({type:'smoke.result',result:'PASS'});
    })().catch(async error => { console.error(error); await browser.runtime.sendMessage({type:'smoke.result',result:'FAIL ' + error.message}); });
  `,
    "scraper.js",
  );
  await writeFile(
    join(directory, "scraper.html"),
    '<!doctype html><script src="scraper.js"></script>',
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
      75_000,
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
    "Firefox scraper passed: agent inspection, sample testing and JSON generation, rendered dynamic content, two listing pages, two detail pages, exact-origin redirect blocking before the destination received a request, and worker/rule cleanup.",
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
