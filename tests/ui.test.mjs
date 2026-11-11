import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parseHTML } from "linkedom";

async function waitFor(check) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("UI did not reach the expected state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function eventSource() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emit: (...args) => listeners.forEach((listener) => listener(...args)),
    get size() {
      return listeners.size;
    },
  };
}
async function mount(
  entry,
  browser,
  url = "moz-extension://test/settings.html",
) {
  const { window, document } = parseHTML(
    '<html><body><div id="root"></div></body></html>',
  );
  const previous = new Map();
  const location = new URL(url);
  const globals = {
    window,
    document,
    browser,
    location,
    history: {
      replaceState(_state, _unused, path) {
        location.href = new URL(path, location).href;
      },
    },
    Node: window.Node,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    MutationObserver: window.MutationObserver,
    getComputedStyle: () => ({ getPropertyValue: () => "", overflowY: "auto" }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  };
  window.getComputedStyle = globals.getComputedStyle;
  window.requestAnimationFrame = globals.requestAnimationFrame;
  window.cancelAnimationFrame = globals.cancelAnimationFrame;
  window.ResizeObserver = globals.ResizeObserver;
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty" },
    write: false,
  });
  const temporary = await mkdtemp(join(tmpdir(), "scraper-react-ui-"));
  const modulePath = join(temporary, "page.mjs");
  await writeFile(modulePath, result.outputFiles[0].contents);
  await import(pathToFileURL(modulePath).href);
  return {
    document,
    window,
    location,
    async close() {
      window.dispatchEvent(new window.Event("pagehide"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await rm(temporary, { recursive: true, force: true });
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

test("React settings load account state, load models, test the selection, and sign out", async () => {
  let signedIn = true;
  const requests = [];
  const h = await mount("extension/entrypoints/settings/main.tsx", {
    runtime: {
      async sendMessage(message) {
        requests.push(message);
        if (message.type === "status")
          return {
            ok: true,
            configured: true,
            signedIn,
            locked: !signedIn,
            notice: "Ready.",
            registrations: [{ clientId: "saved", email: "saved@example.test" }],
            account: { email: "saved@example.test" },
          };
        if (message.type === "models")
          return {
            ok: true,
            models: [{ id: "selected-model", name: "Selected model" }],
          };
        if (message.type === "test")
          return { ok: true, text: "Hello from the model" };
        if (message.type === "logout") signedIn = false;
        return { ok: true };
      },
    },
  });
  try {
    await waitFor(() =>
      h.document.querySelector("#status")?.textContent.includes("Signed in"),
    );
    assert.equal(h.document.querySelector("#unlock-form").hidden, true);
    h.document.querySelector("#models").click();
    await waitFor(
      () =>
        h.document.querySelector("#model option")?.value === "selected-model",
    );
    await waitFor(() => !h.document.querySelector("#test").disabled);
    h.document.querySelector("#test").click();
    await waitFor(
      () =>
        h.document.querySelector("#output").textContent ===
        "Hello from the model",
    );
    assert.deepEqual(
      requests.find((request) => request.type === "test"),
      { type: "test", model: "selected-model" },
    );
    h.document.querySelector("#logout").click();
    await waitFor(() =>
      h.document.querySelector("#status").textContent.includes("locked"),
    );
    assert.equal(h.document.querySelector("#unlock-form").hidden, false);
    assert.equal(h.document.querySelector("#test").disabled, true);
    assert.equal(h.document.querySelectorAll("#model option").length, 0);
  } finally {
    await h.close();
  }
});

test("React callback removes the secret fragment and relays it exactly once", async () => {
  const requests = [];
  const response = Promise.withResolvers();
  const h = await mount(
    "extension/entrypoints/callback/main.tsx",
    {
      runtime: {
        sendMessage(message) {
          requests.push(message);
          return response.promise;
        },
      },
    },
    "moz-extension://test/callback.html#private-callback",
  );
  try {
    await waitFor(
      () =>
        h.document.querySelector("p")?.textContent === "Completing sign-in…",
    );
    assert.equal(h.location.hash, "");
    assert.deepEqual(requests, [{ type: "callback", url: "private-callback" }]);
    response.resolve({ ok: true });
    await waitFor(() =>
      h.document.querySelector("p").textContent.includes("Sign-in complete"),
    );
    assert.equal(requests.length, 1);
  } finally {
    await h.close();
  }
});

test("React sidebar follows active pages and cleans up browser subscriptions", async () => {
  const onActivated = eventSource(),
    onUpdated = eventSource(),
    onRemoved = eventSource();
  let tab = { id: 2, url: "https://market.test/search" };
  let settingsOpened = 0,
    disconnects = 0;
  const requests = [];
  const opening = Promise.withResolvers();
  const permissions = [];
  let allow = false;
  const h = await mount(
    "extension/entrypoints/scraper/main.tsx",
    {
      permissions: {
        request(permission) {
          permissions.push(permission);
          return Promise.resolve(allow);
        },
      },
      windows: { getCurrent: async () => ({ id: 7 }) },
      tabs: { onActivated, onUpdated, onRemoved, query: async () => [tab] },
      runtime: {
        getURL: (path) => `moz-extension://test/${path}`,
        connect: () => ({
          disconnect() {
            disconnects++;
          },
        }),
        openOptionsPage: async () => {
          settingsOpened++;
        },
        sendMessage: async (message) => {
          requests.push(message);
          if (message.type === "scraper.worker.open") return opening.promise;
          return { ok: true };
        },
      },
    },
    "moz-extension://test/scraper.html?window=7",
  );
  try {
    await waitFor(
      () => h.document.querySelector("#source")?.textContent === tab.url,
    );
    h.document.querySelector("#settings").click();
    assert.equal(settingsOpened, 1);
    h.document.querySelector("#validate").click();
    await waitFor(() =>
      h.document.querySelector("#status").textContent.startsWith("Valid:"),
    );
    assert.equal(h.document.querySelector("#run").disabled, false);
    h.document.querySelector("#run").click();
    // The permission request happens in the original event, before any await.
    assert.deepEqual(permissions, [{ origins: ["https://market.test/*"] }]);
    await waitFor(
      () =>
        h.document.querySelector("#status").textContent ===
        "Site access was declined.",
    );
    assert.equal(
      requests.some((message) => message.type === "scraper.worker.open"),
      false,
    );
    await waitFor(() => !h.document.querySelector("#run").disabled);
    allow = true;
    h.document.querySelector("#run").click();
    await waitFor(() =>
      requests.some((message) => message.type === "scraper.worker.open"),
    );
    tab = { id: 4, url: "https://switched-during-run.test/" };
    onActivated.emit({ tabId: 4, windowId: 7 });
    assert.equal(
      h.document.querySelector("#source").textContent,
      "https://market.test/search",
    );
    h.document.querySelector("#stop").click();
    opening.resolve({
      ok: true,
      tab: 99,
      origin: "https://market.test",
      startUrl: "https://market.test/search",
    });
    await waitFor(
      () => h.document.querySelector("#status").textContent === "Cancelled.",
    );
    await waitFor(() => !h.document.querySelector("#run").disabled);
    assert.ok(
      requests.some((message) => message.type === "scraper.worker.close"),
    );
    tab = { id: 3, url: "https://another.test/list" };
    onActivated.emit({ tabId: 3, windowId: 7 });
    await waitFor(
      () => h.document.querySelector("#source").textContent === tab.url,
    );
    tab = { id: 3, url: "about:config" };
    onUpdated.emit(3, { url: tab.url });
    await waitFor(() => h.document.querySelector("#run").disabled);
  } finally {
    await h.close();
  }
  assert.equal(onActivated.size + onUpdated.size + onRemoved.size, 0);
  assert.equal(disconnects, 1);
  assert.ok(
    requests.some((message) => message.type === "scraper.worker.close"),
  );
});

test("React callback handles an immediately rejected background relay", async () => {
  const h = await mount(
    "extension/entrypoints/callback/main.tsx",
    {
      runtime: { sendMessage: () => Promise.reject(new Error("Disconnected")) },
    },
    "moz-extension://test/callback.html#expired",
  );
  try {
    await waitFor(() =>
      h.document
        .querySelector("p")
        ?.textContent.includes("extension restarted"),
    );
    assert.equal(h.location.hash, "");
  } finally {
    await h.close();
  }
});
