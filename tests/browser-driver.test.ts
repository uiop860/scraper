import { afterEach, expect, test, vi } from "vitest";
import { browserDriver } from "../extension/scraper/browser";
import type { Spec } from "../extension/scraper/spec";

afterEach(() => vi.unstubAllGlobals());

test("same-URL replacement documents receive a fresh worker before extraction", async () => {
  const url = "https://market.test/list";
  let connected = false;
  const inject = vi.fn(async () => {
    connected = true;
  });
  const sendMessage = vi.fn(async (_tab: number, message: { type: string }) => {
    if (!connected) throw new Error("Receiving end does not exist.");
    return message.type === "scraper.inspect"
      ? { ok: true, inspection: { url, samples: [], shadowRoots: [] } }
      : { ok: true, snapshot: { url, items: [], diagnostics: [], next: null } };
  });
  vi.stubGlobal("browser", {
    tabs: { get: async () => ({ url, status: "complete" }), sendMessage },
    scripting: { executeScript: inject },
  });
  const driver = browserDriver(1, "https://market.test");
  const signal = new AbortController().signal;
  await driver.inspect(url, "body", signal);
  // A reload destroys the content script without changing the URL.
  connected = false;
  const spec: Spec = {
    version: 1,
    name: "Test",
    list: {
      itemSelector: "article",
      fields: { title: { selector: "h2", value: "text" } },
    },
  };
  await expect(driver.visit(url, "list", spec, signal)).resolves.toMatchObject({
    url,
  });
  expect(inject).toHaveBeenCalledTimes(2);
});

test("reinjecting into one document registers only one listener", async () => {
  const { registerContent } = await import("../extension/content");
  const addListener = vi.fn();
  vi.stubGlobal("browser", { runtime: { onMessage: { addListener } } });
  vi.stubGlobal("scraperWorkerRegistered", undefined);
  registerContent();
  registerContent();
  expect(addListener).toHaveBeenCalledTimes(1);
});
