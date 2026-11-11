import assert from "node:assert/strict";
import { test } from "node:test";
import { bundle } from "./helpers.mjs";
const { registerScraperAgent } = await import(
  await bundle("extension/scraper/agent-background.ts")
);

test("agent bridge protects credentials, restricts senders and models, replays tool state, and cancels requests", async () => {
  const previous = { browser: globalThis.browser, fetch: globalThis.fetch };
  let listener, removed, updated, fetchHook, connected;
  let credentials = 0;
  let sharing = true;
  const authController = new AbortController();
  globalThis.browser = {
    permissions: {
      contains: async (permissions) => {
        assert.deepEqual(permissions.data_collection, [
          "websiteContent",
          "browsingActivity",
        ]);
        return sharing;
      },
    },
    runtime: {
      onConnect: {
        addListener(fn) {
          connected = fn;
        },
      },
      id: "test",
      getURL: (p) => `moz-extension://test/${p}`,
      onMessage: {
        addListener: (fn) => {
          listener = fn;
        },
      },
    },
    tabs: {
      onRemoved: {
        addListener: (fn) => {
          removed = fn;
        },
      },
      onUpdated: {
        addListener: (fn) => {
          updated = fn;
        },
      },
    },
  };
  globalThis.fetch = async (url, init) => {
    assert.equal(
      new Headers(init.headers).get("authorization"),
      "Bearer PRIVATE",
    );
    if (String(url).endsWith("/models"))
      return Response.json({
        models: [{ slug: "model", display_name: "Model", visibility: "list" }],
      });
    return fetchHook(init);
  };
  registerScraperAgent({
    signal: authController.signal,
    credentials: async () => {
      credentials++;
      return { accessToken: "PRIVATE" };
    },
    invalidateAccess: () => {},
  });
  const sender = {
    id: "test",
    url: "moz-extension://test/scraper.html?tab=2",
    frameId: 0,
    tab: { id: 1 },
  };
  const send = (message, from = sender) => listener(message, from);
  const turn = {
    type: "scraper.agent.turn",
    model: "model",
    input: [{ role: "user", content: "Scrape titles" }],
  };
  try {
    for (const from of [
      { ...sender, id: "other" },
      { ...sender, url: "https://market.test/" },
      { ...sender, frameId: 1 },
      { ...sender, tab: { id: 1, incognito: true } },
    ])
      assert.equal(send({ type: "scraper.agent.models" }, from), undefined);
    assert.equal(credentials, 0);
    const sidebar = {
      id: "test",
      url: "moz-extension://test/scraper.html?window=7",
    };
    let disconnect;
    connected({
      name: "scraper.sidebar",
      sender: sidebar,
      onDisconnect: {
        addListener(fn) {
          disconnect = fn;
        },
      },
    });
    assert.equal(
      (await send({ type: "scraper.agent.models" }, sidebar)).ok,
      true,
    );
    disconnect();
    assert.equal((await send(turn, sidebar)).ok, false);

    assert.equal((await send(turn)).ok, false);
    const catalog = await send({ type: "scraper.agent.models" });
    assert.equal(catalog.ok, true);
    assert.ok(!JSON.stringify(catalog).includes("PRIVATE"));
    assert.equal((await send({ ...turn, model: "unknown" })).ok, false);
    assert.equal((await send({ ...turn, instructions: "override" })).ok, false);
    const output = [
      {
        type: "function_call",
        name: "inspect_page",
        call_id: "call1",
        arguments: '{"selector":"body","url":"https://market.test/"}',
      },
    ];
    fetchHook = (init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.store, false);
      assert.equal(body.parallel_tool_calls, false);
      assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
      assert.deepEqual(
        body.tools.map((tool) => tool.name),
        ["inspect_page", "test_scraper", "finish_scraper"],
      );
      assert.match(body.instructions, /untrusted data/);
      return new Response(
        `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output } })}\n\n`,
      );
    };
    sharing = false;
    const declined = await send(turn);
    assert.equal(declined.ok, false);
    assert.match(declined.error, /sharing/);
    sharing = true;
    const response = await send(turn);
    assert.equal(response.ok, true);
    assert.deepEqual(response.output, output);
    assert.ok(!JSON.stringify(response).includes("PRIVATE"));
    const entered = Promise.withResolvers();
    fetchHook = (init) =>
      new Promise((_, reject) => {
        entered.resolve();
        init.signal.addEventListener(
          "abort",
          () => reject(new Error("PRIVATE")),
          { once: true },
        );
      });
    const pending = send(turn);
    await entered.promise;
    assert.equal((await send(turn)).ok, false);
    await send({ type: "scraper.agent.cancel" });
    const cancelled = await pending;
    assert.equal(cancelled.ok, false);
    assert.ok(!cancelled.error.includes("PRIVATE"));
    updated(1, { url: "https://other.test" });
    assert.equal((await send(turn)).ok, false);
    await send({ type: "scraper.agent.models" });
    removed(1);
    assert.equal((await send(turn)).ok, false);
  } finally {
    globalThis.browser = previous.browser;
    globalThis.fetch = previous.fetch;
  }
});
