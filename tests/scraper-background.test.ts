import type { MockData, MockCallback } from "./mock-types.ts";
import { assert, test } from "vitest";
import { bundle } from "./helpers.ts";
const module = await bundle("extension/scraper/background.ts");
async function harness() {
  const previous = globalThis.browser;
  let listener!: MockCallback,
    onRemoved!: MockCallback,
    onUpdated!: MockCallback,
    onConnect!: MockCallback,
    failRule = false,
    failClose = false;
  const session: MockData = {};
  const rules = new Map();
  const events: string[] = [];
  const tabs = new Map([
    [1, { id: 1, url: "moz-extension://test/scraper.html?tab=2" }],
    [2, { id: 2, url: "https://market.test/search" }],
  ]);
  globalThis.browser = {
    runtime: {
      onConnect: {
        addListener(fn: MockCallback) {
          onConnect = fn;
        },
      },
      id: "test",
      getURL: (p: string) => `moz-extension://test/${p}`,
      onMessage: {
        addListener(fn: MockCallback) {
          listener = fn;
        },
      },
    },
    storage: {
      session: {
        async get(key: string) {
          return { [key]: structuredClone(session[key]) };
        },
        async set(data: MockData) {
          Object.assign(session, structuredClone(data));
        },
      },
    },
    scripting: {
      async executeScript({ target }: MockData) {
        events.push(`stop:${target.tabId}`);
      },
    },
    permissions: {
      async contains() {
        return true;
      },
    },
    tabs: {
      async get(id: number) {
        if (!tabs.has(id)) throw new Error("Tab gone");
        return tabs.get(id);
      },
      async create() {
        tabs.set(3, { id: 3, url: "about:blank" });
        return tabs.get(3);
      },
      async remove(id: number) {
        if (failClose) throw new Error("Tab close denied");
        events.push(`close:${id}`);
        tabs.delete(id);
      },
      onRemoved: {
        addListener(fn: MockCallback) {
          onRemoved = fn;
        },
      },
      onUpdated: {
        addListener(fn: MockCallback) {
          onUpdated = fn;
        },
      },
    },
    declarativeNetRequest: {
      async updateSessionRules({
        addRules = [],
        removeRuleIds = [],
      }: browser.declarativeNetRequest._UpdateSessionRulesOptions) {
        if (addRules.length && failRule)
          throw new Error("Rule installation failed");
        for (const rule of addRules) {
          rules.set(rule.id, rule);
          events.push(`add:${rule.id}`);
        }
        for (const id of removeRuleIds) {
          rules.delete(id);
          events.push(`release:${id}`);
        }
      },
    },
  } as unknown as typeof browser;
  (
    await import(`${module}#${crypto.randomUUID()}`)
  ).registerScraperBackground();
  const sender = {
    id: "test",
    url: tabs.get(1)!.url,
    frameId: 0,
    tab: { id: 1 },
  };
  return {
    connect(window: number) {
      const sender = {
        id: "test",
        url: `moz-extension://test/scraper.html?window=${window}`,
      };
      let disconnect!: MockCallback;
      onConnect({
        name: "scraper.sidebar",
        sender,
        onDisconnect: {
          addListener(fn: MockCallback) {
            disconnect = fn;
          },
        },
      });
      return { sender, disconnect: () => disconnect() };
    },
    tabs,
    rules,
    session,
    events,
    send(task: MockData, from: MockData = sender) {
      return listener(task, from);
    },
    open() {
      return listener({ type: "scraper.worker.open", sourceTab: 2 }, sender);
    },
    async flush() {
      await listener({ type: "scraper.worker.noop" }, sender);
    },
    removeOwner() {
      tabs.delete(1);
      onRemoved(1);
    },
    navigateOwner() {
      tabs.get(1)!.url = "https://elsewhere.test/";
      onUpdated(1, { url: tabs.get(1)!.url });
    },
    denyClose(value: boolean) {
      failClose = value;
    },
    failRules() {
      failRule = true;
    },
    close() {
      globalThis.browser = previous;
    },
  };
}
test("worker lifecycle isolates senders and stops the current tab before releasing origin guards", async () => {
  const h = await harness();
  try {
    for (const sender of [
      {
        id: "other",
        url: "moz-extension://test/scraper.html",
        frameId: 0,
        tab: { id: 1 },
      },
      {
        id: "test",
        url: "https://market.test/search",
        frameId: 0,
        tab: { id: 2 },
      },
      {
        id: "test",
        url: "moz-extension://test/scraper.html",
        frameId: 1,
        tab: { id: 1 },
      },
      {
        id: "test",
        url: "moz-extension://test/scraper.html",
        frameId: 0,
        tab: { id: 1, incognito: true },
      },
    ])
      assert.strictEqual(
        h.send({ type: "scraper.worker.open", sourceTab: 2 }, sender),
        undefined,
      );
    const worker = await h.open();
    assert.strictEqual(worker.ok, true);
    assert.strictEqual(worker.tab, 2);
    assert.strictEqual(h.tabs.size, 2);
    assert.strictEqual(h.rules.size, 2);
    assert.strictEqual(h.session.scraperWorkers.length, 1);
    h.removeOwner();
    await h.flush();
    assert.strictEqual(h.tabs.has(2), true);
    assert.strictEqual(h.rules.size, 0);
    assert.strictEqual(h.session.scraperWorkers.length, 0);
    assert.ok(h.events.indexOf("stop:2") < h.events.indexOf("release:1004"));
  } finally {
    h.close();
  }
});
test("failed guard installation and navigating the UI away release the current tab", async () => {
  const h = await harness();
  try {
    h.failRules();
    assert.strictEqual((await h.open()).ok, false);
    assert.strictEqual(h.tabs.has(2), true);
    assert.strictEqual(h.session.scraperWorkers.length, 0);
  } finally {
    h.close();
  }
  const next = await harness();
  try {
    assert.strictEqual((await next.open()).ok, true);
    next.navigateOwner();
    await next.flush();
    assert.strictEqual(next.tabs.has(2), true);
    assert.strictEqual(next.rules.size, 0);
  } finally {
    next.close();
  }
});

test("legacy disposable tabs retain their guard when closure fails", async () => {
  const h = await harness();
  try {
    await h.open();
    h.session.scraperWorkers[0].ownsTab = true;
    h.denyClose(true);
    const response = await h.send({ type: "scraper.worker.close" });
    assert.strictEqual(response.ok, false);
    assert.strictEqual(h.rules.size, 2);
    assert.strictEqual(h.tabs.has(2), true);
    h.denyClose(false);
    assert.strictEqual(
      (await h.send({ type: "scraper.worker.close" })).ok,
      true,
    );
    assert.strictEqual(h.rules.size, 0);
  } finally {
    h.close();
  }
});

test("sidebar workers are isolated by window and cleaned up on disconnect", async () => {
  const h = await harness();
  try {
    const sidebar = h.connect(7);
    assert.strictEqual(
      (
        await h.send(
          { type: "scraper.worker.open", sourceTab: 2 },
          sidebar.sender,
        )
      ).ok,
      true,
    );
    assert.strictEqual(h.session.scraperWorkers[0].owner, -8);
    const other = h.connect(8);
    await h.send({ type: "scraper.worker.close" }, other.sender);
    assert.strictEqual(h.tabs.has(2), true);
    sidebar.disconnect();
    await h.flush();
    assert.strictEqual(h.tabs.has(2), true);
    assert.strictEqual(h.rules.size, 0);
    assert.strictEqual(
      (
        await h.send(
          { type: "scraper.worker.open", sourceTab: 2 },
          sidebar.sender,
        )
      ).ok,
      false,
    );
  } finally {
    h.close();
  }
});
