import type { MockData } from "./mock-types.ts";
import { assert, test } from "vitest";
import { build } from "esbuild";
import { parseHTML } from "linkedom";

async function mount(
  page: string,
  api: MockData,
  url = "moz-extension://scraper/scraper.html?tab=2",
) {
  api.storage ??= {
    local: { get: async () => ({}), set: async () => {} },
    onChanged: { addListener() {}, removeListener() {} },
  };
  const { window } = parseHTML(
    '<html><body><div id="root"></div></body></html>',
  );
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const intervals: ReturnType<typeof setInterval>[] = [];
  const pollers: (() => void)[] = [];
  const interval = globalThis.setInterval;
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    location: new URL(url),
    history: { replaceState() {} },
    browser: api,
    setInterval: (...args: Parameters<typeof setInterval>) => {
      const id = interval(...args);
      intervals.push(id);
      pollers.push(args[0] as () => void);
      return id;
    },
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  try {
    const output = await build({
      entryPoints: [`extension/entrypoints/${page}/main.tsx`],
      bundle: true,
      format: "esm",
      platform: "browser",
      jsx: "automatic",
      loader: { ".css": "empty" },
      write: false,
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await import(
      `data:text/javascript;base64,${Buffer.from(output.outputFiles[0]!.contents).toString("base64")}#${crypto.randomUUID()}`
    );
    return {
      document: window.document,
      poll() {
        for (const update of pollers) update();
      },
      async until(predicate: () => unknown) {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.fail(
          `React page did not reach expected state: ${window.document.body.textContent}`,
        );
      },
      close() {
        window.dispatchEvent(new window.Event("pagehide"));
        for (const id of intervals) clearInterval(id);
        for (const [key, descriptor] of originals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
      },
    };
  } catch (error) {
    for (const id of intervals) clearInterval(id);
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    throw error;
  }
}

test("React settings shows locked account state and unlock form", async () => {
  const page = await mount("settings", {
    runtime: {
      async sendMessage(message: MockData) {
        assert.strictEqual(message.type, "status");
        return {
          ok: true,
          configured: true,
          locked: true,
          notice: "Enter your PIN.",
          registrations: [],
        };
      },
    },
  });
  try {
    await page.until(() =>
      page.document
        .querySelector<HTMLElement>("#status")
        ?.textContent.includes("Saved sign-in locked"),
    );
    assert.strictEqual(
      page.document.querySelector<HTMLElement>("#unlock-form")!.hidden,
      false,
    );
    assert.strictEqual(
      page.document.querySelector<HTMLInputElement>("#pin-confirm")!.hidden,
      true,
    );
    assert.strictEqual(
      page.document.querySelector<HTMLButtonElement>("#login")!.disabled,
      true,
    );
    assert.strictEqual(
      page.document.querySelector<HTMLButtonElement>("#models")!.disabled,
      true,
    );
  } finally {
    page.close();
  }
});

test("React callback relays the captured hash and displays completion", async () => {
  const page = await mount(
    "callback",
    {
      runtime: {
        async sendMessage(message: MockData) {
          assert.deepStrictEqual(message, {
            type: "callback",
            url: "synthetic-callback",
          });
          return { ok: true };
        },
      },
    },
    "moz-extension://scraper/callback.html#synthetic-callback",
  );
  try {
    await page.until(() =>
      page.document
        .querySelector<HTMLElement>("p")
        ?.textContent.includes("Sign-in complete"),
    );
  } finally {
    page.close();
  }
});

test("settings offers one account and reconnects the saved account", async () => {
  const logins: MockData[] = [];
  let signedIn = false;
  const page = await mount("settings", {
    runtime: {
      async sendMessage(message: MockData) {
        if (message.type === "login") {
          logins.push(message);
          signedIn = true;
        }
        return {
          ok: true,
          configured: true,
          locked: false,
          signedIn,
          account: { clientId: "saved-client", subject: "user" },
          registrations: [{ clientId: "other-client", subject: "other" }],
        };
      },
    },
  });
  try {
    await page.until(
      () =>
        page.document.querySelector<HTMLButtonElement>("#login")?.disabled ===
        false,
    );
    assert.strictEqual(page.document.querySelector("#accounts"), null);
    page.document.querySelector<HTMLButtonElement>("#login")!.click();
    await page.until(
      () =>
        logins.length === 1 &&
        page.document.querySelector<HTMLButtonElement>("#login")!.disabled,
    );
    assert.strictEqual(logins[0]!.clientId, "saved-client");
    assert.strictEqual(page.document.querySelector("#accounts"), null);
  } finally {
    page.close();
  }
});

test("settings restores the saved model across sessions and keeps it while locked", async () => {
  const saved = { selectedModel: "remembered-model" };
  const api = {
    storage: {
      local: {
        get: async () => ({ ...saved }),
        set: async (data: MockData) => Object.assign(saved, data),
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    runtime: {
      sendMessage: async () => ({
        ok: true,
        configured: true,
        locked: true,
        signedIn: false,
      }),
    },
  };
  for (let session = 0; session < 2; session++) {
    const page = await mount("settings", api);
    try {
      await page.until(
        () =>
          page.document.querySelector<HTMLOptionElement>("#model option")
            ?.value === saved.selectedModel,
      );
      page.poll();
      await page.until(() =>
        page.document
          .querySelector<HTMLElement>("#status")
          ?.textContent.includes("locked"),
      );
      assert.strictEqual(
        page.document.querySelector<HTMLOptionElement>("#model option")!.value,
        "remembered-model",
      );
    } finally {
      page.close();
    }
  }
});
