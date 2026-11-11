import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { build } from "esbuild";

// A synthetic callback proves interception without starting a localhost server
// or using an OpenAI account. The fixture is never packaged with the extension.
const directory = await mkdtemp(join(tmpdir(), "scraper-firefox-"));
try {
  await cp(".output/firefox-mv3", directory, { recursive: true });
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
  manifest.background = { scripts: ["smoke.js"] };
  delete manifest.content_scripts;
  delete manifest.options_ui;
  delete manifest.action;
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  const fixture = await build({
    stdin: {
      contents: `
      import { callbackRule, parseCallback, REDIRECT } from "./extension/auth/protocol";
      import { CredentialStore, database, importSessionKey } from "./extension/auth/storage";
      import { testModel } from "./extension/auth/client";
      let tabId;
      const attempt = { state: "synthetic", nonce: "test", verifier: "test" };
      browser.runtime.onMessage.addListener(async (message, sender) => {
        try {
          if (sender.tab?.id !== tabId || sender.url !== browser.runtime.getURL("callback.html")) throw new Error("Wrong callback sender");
          parseCallback(message.url, attempt);
          const originalFetch = globalThis.fetch;
          try {
            const bytes = new TextEncoder().encode(
              'data: {"type":"response.output_text.delta","delta":"Hello from Scraper."}\\n\\n' +
              'data: {"type":"response.completed","response":{"status":"completed"}}\\n\\n');
            globalThis.fetch = async () => new Response(bytes);
            const text = await testModel({ accessToken: "synthetic" }, "synthetic", new AbortController().signal);
            if (text !== "Hello from Scraper.") throw new Error("SDK response mismatch");
          } finally { globalThis.fetch = originalFetch; }
          await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1] });
          dump("SCRAPER_FIREFOX_PASS\\n");
          return { ok: true };
        } catch { dump("SCRAPER_FIREFOX_FAIL\\n"); return { ok: false }; }
      });
      (async () => {
        const store = new CredentialStore();
        await store.unlock("1234");
        await store.save({registration: {clientId: "synthetic", subject: "synthetic"}, refreshToken: "synthetic", scopes: []});
        const persisted = await database();
        if (persisted.key || persisted.iv.length !== 12) throw new Error("Vault format mismatch");
        const resumed = new CredentialStore();
        if (!(await resumed.status()).credential) throw new Error("Session restoration failed");
        // Exercise actual CryptoKey structured cloning independently. The PIN
        // vault deliberately never persists this key.
        const key = await importSessionKey(Array.from(new Uint8Array(32)));
        const cloned = structuredClone(key);
        if (cloned.extractable) throw new Error("Key became extractable");
        await database({...persisted, probeKey: cloned});
        const roundTrip = (await database()).probeKey;
        if (!roundTrip || roundTrip.extractable) throw new Error("IndexedDB key cloning failed");
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt({name: "AES-GCM", iv}, key, new Uint8Array([42]));
        const decrypted = await crypto.subtle.decrypt({name: "AES-GCM", iv}, roundTrip, encrypted);
        if (new Uint8Array(decrypted)[0] !== 42) throw new Error("Persisted key was unusable");
        await database(persisted);
        await browser.storage.session.remove("scraperAuth");
        const restarted = new CredentialStore();
        if (!(await restarted.status()).locked) throw new Error("Session did not lock");
        await restarted.unlock("1234");
        if ((await restarted.status()).credential.refreshToken !== "synthetic") throw new Error("PIN restoration failed");
        await restarted.clear();
        if (await database() !== undefined) throw new Error("Vault cleanup failed");
        const tab = await browser.tabs.create({ url: "about:blank" });
        tabId = tab.id;
        await browser.declarativeNetRequest.updateSessionRules({ addRules: [callbackRule(tabId, browser.runtime.getURL("callback.html"))] });
        await browser.tabs.update(tabId, { url: REDIRECT + "?state=synthetic&code=synthetic&client_id=oaiapp_synthetic" });
      })().catch(() => dump("SCRAPER_FIREFOX_FAIL\\n"));
    `,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
  });
  await writeFile(join(directory, "smoke.js"), fixture.outputFiles[0].contents);
  const child = spawn(
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
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), 25_000);
    let output = "";
    const observe = (chunk) => {
      output = (output + chunk.toString()).slice(-30_000);
      if (output.includes("SCRAPER_FIREFOX_PASS")) {
        clearTimeout(timer);
        resolve(true);
      }
      if (output.includes("SCRAPER_FIREFOX_FAIL")) {
        clearTimeout(timer);
        resolve(false);
      }
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(false);
    });
  }).finally(async () => {
    child.kill("SIGINT");
    if (child.exitCode === null)
      await new Promise((resolve) => {
        child.once("exit", resolve);
        setTimeout(() => {
          child.kill("SIGTERM");
          resolve();
        }, 3000).unref();
      });
  });
  if (!result)
    throw new Error(
      "Firefox synthetic callback was not confirmed. Run the manual checks in docs/authentication.md.",
    );
  console.log(
    "Firefox intercepted the synthetic loopback callback, validated its state in the expected tab, and removed the rule. The SDK also decoded a synthetic response without a Content-Type header. PIN encryption, IndexedDB reopening, session restoration, CryptoKey cloning, and cleanup also passed. No localhost server was used.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
