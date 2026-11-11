import assert from "node:assert/strict";
import { test } from "node:test";
import { bundle } from "./helpers.mjs";
const module = await bundle("extension/scraper/background.ts");
async function harness() {
  const previous = globalThis.browser;
  let listener,
    onRemoved,
    onUpdated,
    onConnect,
    failRule = false,
    failClose = false;
  const session = {};
  const rules = new Map();
  const events = [];
  const tabs = new Map([
    [1, { id: 1, url: "moz-extension://test/scraper.html?tab=2" }],
    [2, { id: 2, url: "https://market.test/search" }],
  ]);
  globalThis.browser = {
    runtime: {
      onConnect: {
        addListener(fn) {
          onConnect = fn;
        },
      },
      id: "test",
      getURL: (p) => `moz-extension://test/${p}`,
      onMessage: {
        addListener(fn) {
          listener = fn;
        },
      },
    },
    storage: {
      session: {
        async get(key) {
          return { [key]: structuredClone(session[key]) };
        },
        async set(data) {
          Object.assign(session, structuredClone(data));
        },
      },
    },
    permissions: {
      async contains() {
        return true;
      },
    },
    tabs: {
      async get(id) {
        if (!tabs.has(id)) throw new Error("Tab gone");
        return tabs.get(id);
      },
      async create() {
        tabs.set(3, { id: 3, url: "about:blank" });
        return tabs.get(3);
      },
      async remove(id) {
        if (failClose) throw new Error("Tab close denied");
        events.push(`close:${id}`);
        tabs.delete(id);
      },
      onRemoved: {
        addListener(fn) {
          onRemoved = fn;
        },
      },
      onUpdated: {
        addListener(fn) {
          onUpdated = fn;
        },
      },
    },
    declarativeNetRequest: {
      async updateSessionRules({ addRules = [], removeRuleIds = [] }) {
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
  };
  await import(`${module}#${crypto.randomUUID()}`);
  const sender = {
    id: "test",
    url: tabs.get(1).url,
    frameId: 0,
    tab: { id: 1 },
  };
  return {
    connect(window) {
      const sender = {
        id: "test",
        url: `moz-extension://test/scraper.html?window=${window}`,
      };
      let disconnect;
      onConnect({
        name: "scraper.sidebar",
        sender,
        onDisconnect: {
          addListener(fn) {
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
    send(task, from = sender) {
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
      tabs.get(1).url = "https://elsewhere.test/";
      onUpdated(1, { url: tabs.get(1).url });
    },
    denyClose(value) {
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
test("worker lifecycle isolates senders and closes before releasing origin guards", async () => {
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
      assert.equal(
        h.send({ type: "scraper.worker.open", sourceTab: 2 }, sender),
        undefined,
      );
    const worker = await h.open();
    assert.equal(worker.ok, true);
    assert.equal(h.rules.size, 2);
    assert.equal(h.session.scraperWorkers.length, 1);
    h.removeOwner();
    await h.flush();
    assert.equal(h.tabs.has(3), false);
    assert.equal(h.rules.size, 0);
    assert.equal(h.session.scraperWorkers.length, 0);
    assert.ok(h.events.indexOf("close:3") < h.events.indexOf("release:1006"));
  } finally {
    h.close();
  }
});
test("failed guard installation and navigating the UI away both clean up worker tabs", async () => {
  const h = await harness();
  try {
    h.failRules();
    assert.equal((await h.open()).ok, false);
    assert.equal(h.tabs.has(3), false);
    assert.equal(h.session.scraperWorkers.length, 0);
  } finally {
    h.close();
  }
  const next = await harness();
  try {
    assert.equal((await next.open()).ok, true);
    next.navigateOwner();
    await next.flush();
    assert.equal(next.tabs.has(3), false);
    assert.equal(next.rules.size, 0);
  } finally {
    next.close();
  }
});

test("failed tab closure retains the navigation guard and reports failure", async () => {
  const h = await harness();
  try {
    await h.open();
    h.denyClose(true);
    const response = await h.send({ type: "scraper.worker.close" });
    assert.equal(response.ok, false);
    assert.equal(h.rules.size, 2);
    assert.equal(h.tabs.has(3), true);
    h.denyClose(false);
    assert.equal((await h.send({ type: "scraper.worker.close" })).ok, true);
    assert.equal(h.rules.size, 0);
  } finally {
    h.close();
  }
});

test("sidebar workers are isolated by window and cleaned up on disconnect", async () => {
  const h = await harness();
  try {
    const sidebar = h.connect(7);
    assert.equal(
      (
        await h.send(
          { type: "scraper.worker.open", sourceTab: 2 },
          sidebar.sender,
        )
      ).ok,
      true,
    );
    assert.equal(h.session.scraperWorkers[0].owner, -8);
    const other = h.connect(8);
    await h.send({ type: "scraper.worker.close" }, other.sender);
    assert.equal(h.tabs.has(3), true);
    sidebar.disconnect();
    await h.flush();
    assert.equal(h.tabs.has(3), false);
    assert.equal(h.rules.size, 0);
    assert.equal(
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
