import assert from "node:assert/strict";
import { test } from "node:test";
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
  assert.equal(store.getState().model, "m");
  assert.equal(store.getState().account, undefined);
  store.finish("test");
  assert.equal(store.begin("test"), true);
});
