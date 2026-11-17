import type { MockData, MockCallback } from "./mock-types.ts";
import { assert, test } from "vitest";
import { registerScraperAgent } from "../extension/scraper/agent-background.ts";

test("agent bridge protects credentials, restricts senders and models, replays tool state, and cancels requests", async () => {
  const previous = { browser: globalThis.browser, fetch: globalThis.fetch };
  let listener!: MockCallback,
    removed!: MockCallback,
    updated!: MockCallback,
    fetchHook!: MockCallback,
    connected!: MockCallback;
  let credentials = 0;
  let sharing = true;
  const authController = new AbortController();
  globalThis.browser = {
    permissions: {
      contains: async (permissions: browser.permissions.AnyPermissions) => {
        assert.deepStrictEqual(permissions.data_collection, [
          "websiteContent",
          "browsingActivity",
        ]);
        return sharing;
      },
    },
    runtime: {
      onConnect: {
        addListener(fn: MockCallback) {
          connected = fn;
        },
      },
      id: "test",
      getURL: (p: string) => `moz-extension://test/${p}`,
      onMessage: {
        addListener: (fn: MockCallback) => {
          listener = fn;
        },
      },
    },
    tabs: {
      onRemoved: {
        addListener: (fn: MockCallback) => {
          removed = fn;
        },
      },
      onUpdated: {
        addListener: (fn: MockCallback) => {
          updated = fn;
        },
      },
    },
  } as unknown as typeof browser;
  globalThis.fetch = async (url, init) => {
    assert.strictEqual(
      new Headers(init!.headers).get("authorization"),
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
      return {
        accessToken: "PRIVATE",
        expiresAt: Date.now() + 3600000,
        scopes: [],
      };
    },
    invalidateAccess: () => {},
  } as unknown as Parameters<typeof registerScraperAgent>[0]);
  const sender = {
    id: "test",
    url: "moz-extension://test/scraper.html?tab=2",
    frameId: 0,
    tab: { id: 1 },
  };
  const send = (message: MockData, from: MockData = sender) =>
    listener(message, from);
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
      assert.strictEqual(
        send({ type: "scraper.agent.models" }, from),
        undefined,
      );
    assert.strictEqual(credentials, 0);
    const sidebar = {
      id: "test",
      url: "moz-extension://test/scraper.html?window=7",
    };
    let disconnect!: MockCallback;
    connected!({
      name: "scraper.sidebar",
      sender: sidebar,
      onDisconnect: {
        addListener(fn: MockCallback) {
          disconnect = fn;
        },
      },
    });
    assert.strictEqual(
      (await send({ type: "scraper.agent.models" }, sidebar)).ok,
      true,
    );
    disconnect!();
    assert.strictEqual((await send(turn, sidebar)).ok, false);

    assert.strictEqual((await send(turn)).ok, false);
    const catalog = await send({ type: "scraper.agent.models" });
    assert.strictEqual(catalog.ok, true);
    assert.ok(!JSON.stringify(catalog).includes("PRIVATE"));
    assert.strictEqual((await send({ ...turn, model: "unknown" })).ok, false);
    assert.strictEqual(
      (await send({ ...turn, instructions: "override" })).ok,
      false,
    );
    const output = [
      {
        type: "function_call",
        name: "inspect_page",
        call_id: "call1",
        arguments: '{"selector":"body","url":"https://market.test/"}',
      },
    ];
    fetchHook = (init: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      assert.strictEqual(body.store, false);
      assert.strictEqual(body.parallel_tool_calls, false);
      assert.deepStrictEqual(body.include, ["reasoning.encrypted_content"]);
      assert.deepStrictEqual(
        body.tools.map((tool: MockData) => tool.name),
        ["inspect_page", "test_scraper", "finish_scraper"],
      );
      assert.match(body.instructions, /untrusted data/);
      return new Response(
        `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output } })}\n\n`,
      );
    };
    sharing = false;
    const declined = await send(turn);
    assert.strictEqual(declined.ok, false);
    assert.match(declined.error, /sharing/);
    sharing = true;
    const response = await send(turn);
    assert.strictEqual(response.ok, true);
    assert.deepStrictEqual(response.output, output);
    assert.ok(!JSON.stringify(response).includes("PRIVATE"));
    const entered = Promise.withResolvers<void>();
    fetchHook = (init: RequestInit) =>
      new Promise((_, reject) => {
        entered.resolve();
        init!.signal!.addEventListener(
          "abort",
          () => reject(new Error("PRIVATE")),
          { once: true },
        );
      });
    const pending = send(turn);
    await entered.promise;
    assert.strictEqual((await send(turn)).ok, false);
    await send({ type: "scraper.agent.cancel" });
    const cancelled = await pending;
    assert.strictEqual(cancelled.ok, false);
    assert.ok(!cancelled.error.includes("PRIVATE"));
    updated!(1, { url: "https://other.test" });
    assert.strictEqual((await send(turn)).ok, false);
    await send({ type: "scraper.agent.models" });
    removed!(1);
    assert.strictEqual((await send(turn)).ok, false);
  } finally {
    globalThis.browser = previous.browser;
    globalThis.fetch = previous.fetch;
  }
});
