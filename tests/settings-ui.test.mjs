import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { parseHTML } from "linkedom";

async function mount(
  page,
  api,
  url = "moz-extension://scraper/scraper.html?tab=2",
) {
  const { window } = parseHTML(
    '<html><body><div id="root"></div></body></html>',
  );
  const originals = new Map();
  const intervals = [];
  const pollers = [];
  const interval = globalThis.setInterval;
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    location: new URL(url),
    history: { replaceState() {} },
    browser: api,
    setInterval: (...args) => {
      const id = interval(...args);
      intervals.push(id);
      pollers.push(args[0]);
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
      `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].contents).toString("base64")}#${crypto.randomUUID()}`
    );
    return {
      document: window.document,
      poll() {
        for (const update of pollers) update();
      },
      async until(predicate) {
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
          else delete globalThis[key];
        }
      },
    };
  } catch (error) {
    for (const id of intervals) clearInterval(id);
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    throw error;
  }
}

test("React settings shows locked account state and unlock form", async () => {
  const page = await mount("settings", {
    runtime: {
      async sendMessage(message) {
        assert.equal(message.type, "status");
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
        .querySelector("#status")
        ?.textContent.includes("Saved sign-in locked"),
    );
    assert.equal(page.document.querySelector("#unlock-form").hidden, false);
    assert.equal(page.document.querySelector("#pin-confirm").hidden, true);
    assert.equal(page.document.querySelector("#login").disabled, true);
    assert.equal(page.document.querySelector("#models").disabled, true);
  } finally {
    page.close();
  }
});

test("React callback relays the captured hash and displays completion", async () => {
  const page = await mount(
    "callback",
    {
      runtime: {
        async sendMessage(message) {
          assert.deepEqual(message, {
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
        .querySelector("p")
        ?.textContent.includes("Sign-in complete"),
    );
  } finally {
    page.close();
  }
});

for (const trigger of ["reset", "logout", "poll"]) {
  test(`React settings clears a deleted account selection after ${trigger}`, async () => {
    let configured = true;
    let registrations = [
      { clientId: "saved-client", email: "user@example.com" },
    ];
    const logins = [];
    const page = await mount("settings", {
      runtime: {
        async sendMessage(message) {
          if (message.type === "logout") {
            configured = false;
            registrations = [];
          }
          if (message.type === "login") logins.push(message);
          return {
            ok: true,
            configured,
            locked: false,
            signedIn: false,
            registrations,
          };
        },
      },
    });
    try {
      await page.until(
        () => page.document.querySelectorAll("#accounts option").length === 2,
      );
      const select = page.document.querySelector("#accounts");
      select.querySelectorAll("option")[1].selected = true;
      select.dispatchEvent(
        new globalThis.window.Event("change", { bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      page.document.querySelector("#login").click();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await page.until(
        () =>
          logins.length === 1 &&
          !page.document.querySelector("#login").disabled,
      );
      assert.equal(logins[0].clientId, "saved-client");

      if (trigger === "poll") {
        configured = false;
        registrations = [];
        page.poll();
      } else page.document.querySelector(`#${trigger}`).click();
      await page.until(
        () => page.document.querySelectorAll("#accounts option").length === 1,
      );
      assert.equal(page.document.querySelector("#login").disabled, true);

      // Simulate configuring a new PIN in another settings tab, then polling.
      configured = true;
      page.poll();
      await page.until(() => !page.document.querySelector("#login").disabled);
      page.document.querySelector("#login").click();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await page.until(
        () =>
          logins.length === 2 &&
          !page.document.querySelector("#login").disabled,
      );
      assert.equal(logins[1].clientId, undefined);
    } finally {
      page.close();
    }
  });
}
