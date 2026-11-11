import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { bundle } from "./helpers.mjs";
const { createScraperStore, scraperControls } = await import(
  await bundle("extension/state/scraper.ts")
);
const { createSettingsStore } = await import(
  await bundle("extension/state/settings.ts")
);

test("editing invalidates validation; model loading excludes scraping and generation", () => {
  const store = createScraperStore("spec");
  store.setState({
    startUrl: "https://example.test/",
    model: "model",
    validated: "spec",
  });
  assert.equal(scraperControls(store.getState()).run, false);
  assert.equal(store.begin("models"), true);
  assert.equal(store.begin("scraping"), false);
  assert.equal(scraperControls(store.getState()).run, true);
  assert.equal(scraperControls(store.getState()).generate, true);
  store.finish();
  store.editSpec("changed");
  assert.equal(scraperControls(store.getState()).run, true);
  assert.equal(store.getState().validated, "");
  assert.equal(createScraperStore("other tab").getState().spec, "other tab");
});

test("settings projects public account fields and clears model access on sign-out", () => {
  const store = createSettingsStore();
  store.receiveStatus({
    configured: true,
    signedIn: true,
    account: {
      clientId: "client",
      subject: "user",
      refreshToken: "SECRET",
    },
    tokens: { accessToken: "SECRET" },
    registrations: [
      null,
      { clientId: "client", subject: "user", key: "SECRET" },
    ],
  });
  store.setState({ models: [{ id: "m", name: "Model" }], model: "m" });
  assert.ok(!JSON.stringify(store.getState()).includes("SECRET"));
  assert.equal(store.begin("test"), true);
  assert.equal(store.begin("test"), false);
  store.receiveStatus({ configured: true, locked: true, signedIn: false });
  assert.deepEqual(store.getState().models, []);
  assert.equal(store.getState().model, "");
  assert.equal(store.getState().account, undefined);
  store.finish("test");
  assert.equal(store.begin("test"), true);
});

test("scraper UI keeps permissions in the click gesture and cancels before opening a worker", async () => {
  const { window, document } = parseHTML(
    await readFile("extension/scraper.html", "utf8"),
  );
  const saved = new Map(
    ["window", "document", "location", "browser"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  let allow;
  const messages = [];
  let permissions = 0;
  Object.defineProperty(document.querySelector("#agent-model"), "value", {
    value: "",
    writable: true,
  });
  try {
    Object.assign(globalThis, {
      window,
      document,
      location: { href: "moz-extension://scraper/scraper.html?tab=1" },
      browser: {
        tabs: {
          async get() {
            return { url: "https://example.test/list" };
          },
        },
        permissions: {
          request() {
            permissions++;
            return new Promise((resolve) => {
              allow = resolve;
            });
          },
        },
        runtime: {
          async sendMessage(message) {
            messages.push(message.type);
            return { ok: true };
          },
        },
      },
    });
    await import(await bundle("extension/scraper.ts"));
    await new Promise((resolve) => setImmediate(resolve));
    const click = (id) =>
      document.querySelector(id).dispatchEvent(new window.Event("click"));
    click("#validate");
    assert.equal(document.querySelector("#run").disabled, false);
    click("#run");
    assert.equal(permissions, 1);
    assert.equal(document.querySelector("#run").disabled, true);
    assert.equal(document.querySelector("#load-models").disabled, true);
    assert.equal(document.querySelector("#stop").disabled, false);
    click("#stop");
    allow(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(!messages.includes("scraper.worker.open"));
    assert.equal(document.querySelector("#status").textContent, "Cancelled.");
    assert.equal(document.querySelector("#run").disabled, false);
    document.querySelector("#spec").dispatchEvent(new window.Event("input"));
    assert.equal(document.querySelector("#run").disabled, true);
    window.dispatchEvent(new window.Event("pagehide"));
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
