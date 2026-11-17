import { assert, test } from "vitest";
import {
  createScraperStore,
  scraperControls,
} from "../extension/state/scraper.ts";
import { createSettingsStore } from "../extension/state/settings.ts";

test("editing invalidates validation; model loading excludes scraping and generation", () => {
  const store = createScraperStore("spec");
  store.setState({
    startUrl: "https://example.test/",
    model: "model",
    validated: "spec",
  });
  assert.strictEqual(scraperControls(store.getState()).run, false);
  assert.strictEqual(store.begin("models"), true);
  assert.strictEqual(store.begin("scraping"), false);
  assert.strictEqual(scraperControls(store.getState()).run, true);
  assert.strictEqual(scraperControls(store.getState()).generate, true);
  store.finish();
  store.editSpec("changed");
  assert.strictEqual(scraperControls(store.getState()).run, true);
  assert.strictEqual(store.getState().validated, "");
  assert.strictEqual(
    createScraperStore("other tab").getState().spec,
    "other tab",
  );
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
  assert.strictEqual(store.begin("test"), true);
  assert.strictEqual(store.begin("test"), false);
  store.receiveStatus({ configured: true, locked: true, signedIn: false });
  assert.deepStrictEqual(store.getState().models, []);
  assert.strictEqual(store.getState().model, "m");
  assert.strictEqual(store.getState().account, undefined);
  store.finish("test");
  assert.strictEqual(store.begin("test"), true);
});
