import type { MockData, MockCallback } from "./mock-types.ts";
import { assert, test } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parseHTML } from "linkedom";

async function waitFor(check: () => unknown) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("UI did not reach the expected state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function eventSource() {
  const listeners = new Set<MockCallback>();
  return {
    addListener: (listener: MockCallback) => listeners.add(listener),
    removeListener: (listener: MockCallback) => listeners.delete(listener),
    emit: (...args: unknown[]) =>
      listeners.forEach((listener) => listener(...args)),
    get size() {
      return listeners.size;
    },
  };
}
async function mount(
  entry: string,
  browser: MockData,
  url = "moz-extension://test/settings.html",
) {
  browser.storage ??= {
    local: { get: async () => ({}), set: async () => {} },
    onChanged: { addListener() {}, removeListener() {} },
  };
  const { window, document } = parseHTML(
    '<html><body><div id="root"></div></body></html>',
  );
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const location = new URL(url);
  const globals = {
    window,
    document,
    browser,
    location,
    history: {
      replaceState(_state: unknown, _unused: string, path: string) {
        location.href = new URL(path, location).href;
      },
    },
    Node: window.Node,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    MutationObserver: window.MutationObserver,
    getComputedStyle: () => ({ getPropertyValue: () => "", overflowY: "auto" }),
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  };
  Object.assign(window, {
    getComputedStyle: globals.getComputedStyle,
    requestAnimationFrame: globals.requestAnimationFrame,
    cancelAnimationFrame: globals.cancelAnimationFrame,
    ResizeObserver: globals.ResizeObserver,
  });

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
  await writeFile(modulePath, result.outputFiles[0]!.contents);
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
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("React settings load account state, load models, test the selection, and sign out", async () => {
  let signedIn = true;
  const requests: MockData[] = [];
  const saved: Record<string, string> = {};
  const h = await mount("extension/entrypoints/settings/main.tsx", {
    storage: {
      local: {
        get: async () => ({ ...saved }),
        set: async (data: MockData) => Object.assign(saved, data),
      },
      onChanged: eventSource(),
    },
    runtime: {
      async sendMessage(message: MockData) {
        requests.push(message);
        if (message.type === "status")
          return {
            ok: true,
            configured: true,
            signedIn,
            locked: !signedIn,
            notice: "Ready.",
            registrations: [
              {
                clientId: "saved",
                subject: "user",
                email: "saved@example.test",
              },
            ],
            account: {
              clientId: "saved",
              subject: "user",
              email: "saved@example.test",
            },
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
      h.document
        .querySelector<HTMLElement>("#status")
        ?.textContent.includes("Signed in"),
    );
    assert.strictEqual(
      h.document.querySelector<HTMLElement>("#unlock-form")!.hidden,
      true,
    );
    h.document.querySelector<HTMLButtonElement>("#models")!.click();
    await waitFor(
      () =>
        h.document.querySelector<HTMLOptionElement>("#model option")?.value ===
        "selected-model",
    );
    await waitFor(
      () => !h.document.querySelector<HTMLButtonElement>("#test")!.disabled,
    );
    assert.strictEqual(saved.selectedModel, "selected-model");
    h.document.querySelector<HTMLButtonElement>("#test")!.click();
    await waitFor(
      () =>
        h.document.querySelector<HTMLElement>("#output")!.textContent ===
        "Hello from the model",
    );
    assert.deepStrictEqual(
      requests.find((request) => request.type === "test"),
      { type: "test", model: "selected-model" },
    );
    h.document.querySelector<HTMLButtonElement>("#logout")!.click();
    await waitFor(() =>
      h.document
        .querySelector<HTMLElement>("#status")!
        .textContent.includes("locked"),
    );
    assert.strictEqual(
      h.document.querySelector<HTMLElement>("#unlock-form")!.hidden,
      false,
    );
    assert.strictEqual(
      h.document.querySelector<HTMLButtonElement>("#test")!.disabled,
      true,
    );
    assert.strictEqual(
      h.document.querySelector<HTMLOptionElement>("#model option")!.value,
      "selected-model",
    );
  } finally {
    await h.close();
  }
});

test("React callback removes the secret fragment and relays it exactly once", async () => {
  const requests: MockData[] = [];
  const response = Promise.withResolvers<MockData>();
  const h = await mount(
    "extension/entrypoints/callback/main.tsx",
    {
      runtime: {
        sendMessage(message: MockData) {
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
        h.document.querySelector<HTMLElement>("p")?.textContent ===
        "Completing sign-in…",
    );
    assert.strictEqual(h.location.hash, "");
    await waitFor(() => requests.length === 1);
    assert.deepStrictEqual(requests, [
      { type: "callback", url: "private-callback" },
    ]);
    response.resolve({ ok: true });
    await waitFor(() =>
      h.document
        .querySelector<HTMLElement>("p")!
        .textContent.includes("Sign-in complete"),
    );
    assert.strictEqual(requests.length, 1);
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
  const requests: MockData[] = [];
  const h = await mount(
    "extension/entrypoints/scraper/main.tsx",
    {
      windows: { getCurrent: async () => ({ id: 7 }) },
      tabs: { onActivated, onUpdated, onRemoved, query: async () => [tab] },
      runtime: {
        getURL: (path: string) => `moz-extension://test/${path}`,
        connect: () => ({
          disconnect() {
            disconnects++;
          },
        }),
        openOptionsPage: async () => {
          settingsOpened++;
        },
        sendMessage: async (message: MockData) => {
          requests.push(message);
          return { ok: true };
        },
      },
    },
    "moz-extension://test/scraper.html?window=7",
  );
  try {
    await waitFor(
      () =>
        h.document.querySelector<HTMLElement>("#source")?.textContent ===
        tab.url,
    );
    h.document.querySelector<HTMLButtonElement>("#settings")!.click();
    assert.strictEqual(settingsOpened, 1);
    assert.strictEqual(h.document.querySelector<HTMLElement>("#spec"), null);
    assert.strictEqual(
      h.document.querySelector<HTMLElement>("#validate"),
      null,
    );
    assert.strictEqual(
      h.document.querySelector<HTMLButtonElement>("#run")!.disabled,
      true,
    );
    tab = { id: 3, url: "https://another.test/list" };
    onActivated.emit({ tabId: 3, windowId: 7 });
    await waitFor(
      () =>
        h.document.querySelector<HTMLElement>("#source")!.textContent ===
        tab.url,
    );
    tab = { id: 3, url: "about:config" };
    onUpdated.emit(3, { url: tab.url });
    await waitFor(
      () => h.document.querySelector<HTMLButtonElement>("#run")!.disabled,
    );
  } finally {
    await h.close();
  }
  assert.strictEqual(onActivated.size + onUpdated.size + onRemoved.size, 0);
  assert.strictEqual(disconnects, 1);
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
        .querySelector<HTMLElement>("p")
        ?.textContent.includes("extension restarted"),
    );
    assert.strictEqual(h.location.hash, "");
  } finally {
    await h.close();
  }
});

test("sidebar covers its content until auth status resolves, then shows the PIN screen", async () => {
  const status = Promise.withResolvers<MockData>();
  const h = await mount(
    "extension/entrypoints/scraper/main.tsx",
    {
      windows: { getCurrent: async () => ({ id: 7 }) },
      tabs: {
        onActivated: eventSource(),
        onUpdated: eventSource(),
        onRemoved: eventSource(),
        query: async () => [{ id: 2, url: "https://example.test/" }],
      },
      runtime: {
        getURL: (path: string) => `moz-extension://test/${path}`,
        connect: () => ({ disconnect() {} }),
        sendMessage: async (message: MockData) =>
          message.type === "status" ? status.promise : { ok: true },
      },
    },
    "moz-extension://test/scraper.html?window=7",
  );
  try {
    await waitFor(() => h.document.querySelector<HTMLElement>(".pin-screen"));
    assert.strictEqual(
      h.document
        .querySelector<HTMLElement>(".pin-screen")!
        .getAttribute("aria-busy"),
      "true",
    );
    assert.strictEqual(
      h.document.querySelector<HTMLInputElement>("#sidebar-pin"),
      null,
    );
    status.resolve({ ok: true, configured: true, locked: true });
    await waitFor(() =>
      h.document.querySelector<HTMLInputElement>("#sidebar-pin"),
    );
    assert.strictEqual(h.document.querySelectorAll(".pin-screen").length, 1);
    assert.strictEqual(h.document.querySelectorAll(".pin-box").length, 4);
    assert.strictEqual(
      h.document.querySelector<HTMLInputElement>("#sidebar-pin")!.type,
      "password",
    );
  } finally {
    await h.close();
  }
});
