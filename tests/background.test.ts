import type { MockData, MockCallback } from "./mock-types.ts";
import { IDBFactory } from "fake-indexeddb";
import { assert, test } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { bundle } from "./helpers.ts";
const source = await bundle("extension/background.ts");
const issuer = "https://auth.openai.com";
const pair = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test", alg: "RS256" };

async function harness(initial: MockData = {}) {
  let listener!: MockCallback, removed!: MockCallback, clicked!: MockCallback;
  let sidebarOpens = 0;
  const stored = structuredClone(initial);
  const rules = new Map();
  const updates: MockData[] = [];
  const fetches: { url: RequestInfo | URL; init?: RequestInit }[] = [];
  let authorize!: URL, tokenHook!: MockCallback, ruleHook!: MockCallback;
  let expiresIn = 3600;
  const originalBrowser = globalThis.browser;
  const originalDB = globalThis.indexedDB;
  globalThis.indexedDB = new IDBFactory();
  const sessionData: MockData = {};
  const originalFetch = globalThis.fetch;
  globalThis.browser = {
    runtime: {
      onConnect: { addListener() {} },
      id: "scraper",
      getURL: (p: string) => `moz-extension://scraper/${p}`,
      onMessage: {
        addListener(fn: MockCallback) {
          listener = fn;
        },
      },
    },
    declarativeNetRequest: {
      async updateSessionRules({
        removeRuleIds = [],
        addRules = [],
      }: browser.declarativeNetRequest._UpdateSessionRulesOptions) {
        if (addRules.length && ruleHook) await ruleHook();
        for (const id of removeRuleIds) rules.delete(id);
        for (const r of addRules) rules.set(r.id, r);
      },
    },
    storage: {
      session: {
        async get(key: string) {
          return { [key]: structuredClone(sessionData[key]) };
        },
        async set(value: MockData) {
          Object.assign(sessionData, structuredClone(value));
        },
        async remove(key: string) {
          delete sessionData[key];
        },
      },
      local: {
        async get(keys: string[]) {
          return Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).map((k) => [k, stored[k]]),
          );
        },
        async set(value: MockData) {
          Object.assign(stored, value);
        },
        async remove(keys: string[]) {
          for (const key of keys) delete stored[key];
        },
      },
    },
    tabs: {
      onUpdated: { addListener() {} },
      async create() {
        return { id: 42 };
      },
      async update(id: number, { url }: MockData) {
        updates.push({ id, url });
        authorize = new URL(url);
      },
      async remove(id: number) {
        removed?.(id);
      },
      onRemoved: {
        addListener(fn: MockCallback) {
          removed = fn;
        },
      },
    },
    action: {
      onClicked: {
        addListener(fn: MockCallback) {
          clicked = fn;
        },
      },
    },
    sidebarAction: {
      open() {
        sidebarOpens++;
        return Promise.resolve();
      },
    },
  } as unknown as typeof browser;
  globalThis.fetch = async (url, init) => {
    fetches.push({ url, init });
    if (String(url).endsWith("/token")) {
      if (tokenHook) return tokenHook(url, init);
      const jwt = await new SignJWT({
        nonce: authorize.searchParams.get("nonce"),
        email: "test@example.test",
      })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer(issuer)
        .setSubject("user")
        .setAudience("oaiapp_test")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(pair.privateKey);
      return Response.json({
        access_token: "SECRET_ACCESS",
        refresh_token: "SECRET_REFRESH",
        id_token: jwt,
        token_type: "Bearer",
        expires_in: expiresIn,
        scope: "openid chatgpt.tokens.use.direct",
      });
    }
    if (String(url).endsWith("jwks.json"))
      return Response.json({ keys: [jwk] });
    if (String(url).endsWith("/revoke")) return new Response(null);
    if (String(url).endsWith("/models"))
      return Response.json({
        models: [
          { slug: "allowed", display_name: "Allowed", visibility: "list" },
        ],
      });
    if (String(url).endsWith("/responses"))
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"Hello"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    throw new Error("Unexpected fetch");
  };
  (await import(`${source}#${crypto.randomUUID()}`)).registerBackground();
  const sender = {
    id: "scraper",
    url: "moz-extension://scraper/settings.html",
    tab: { id: 1 },
    frameId: 0,
  };
  const send = (message: MockData, from: MockData = sender) =>
    listener(message, from);
  const complete = (params = {}, tabId = 42, fragment = "") =>
    send(
      {
        type: "callback",
        url: `http://127.0.0.1:1455/auth/callback?${new URLSearchParams({ code: "code", client_id: "oaiapp_test", state: authorize.searchParams.get("state")!, ...params })}`,
      },
      {
        ...sender,
        url: `moz-extension://scraper/callback.html${fragment}`,
        tab: { id: tabId },
      },
    );
  assert.strictEqual((await send({ type: "unlock", pin: "1234" })).ok, true);
  return {
    async restart(browserRestart = false) {
      if (browserRestart)
        for (const key of Object.keys(sessionData)) delete sessionData[key];
      (await import(`${source}#${crypto.randomUUID()}`)).registerBackground();
    },
    stored,
    rules,
    updates,
    fetches,
    send,
    complete,
    clickToolbar() {
      clicked();
      return sidebarOpens;
    },
    setExpiry(value: number) {
      expiresIn = value;
    },
    setRuleHook(fn: MockCallback) {
      ruleHook = fn;
    },
    setTokenHook(fn: MockCallback) {
      tokenHook = fn;
    },
    async close() {
      await send({ type: "logout" });
      globalThis.indexedDB = originalDB;
      globalThis.browser = originalBrowser;
      globalThis.fetch = originalFetch;
    },
  };
}
test("background login, model request, isolation, replay protection, and logout", async () => {
  const h = await harness();
  try {
    assert.strictEqual(h.clickToolbar(), 1);
    assert.strictEqual((await h.send({ type: "login" })).ok, true);
    assert.strictEqual(h.rules.size, 1);
    assert.strictEqual((await h.send({ type: "login" })).ok, false);
    assert.strictEqual((await h.complete({}, 99)).ok, false);
    assert.strictEqual(h.fetches.length, 0);
    assert.strictEqual((await h.complete()).ok, true);
    assert.strictEqual(h.rules.size, 0);
    assert.strictEqual((await h.complete()).ok, false);
    const status = await h.send({ type: "status" });
    assert.strictEqual(status.signedIn, true);
    assert.ok(!JSON.stringify(status).includes("SECRET"));
    assert.ok(!JSON.stringify(h.stored).includes("SECRET"));
    assert.strictEqual(
      await h.send(
        { type: "models" },
        {
          id: "scraper",
          url: "https://www.mozilla.org/",
          tab: { id: 5 },
          frameId: 0,
        },
      ),
      undefined,
    );
    assert.strictEqual(
      await h.send(
        { type: "models" },
        { id: "other", url: "moz-extension://scraper/settings.html" },
      ),
      undefined,
    );
    const choices = await h.send({ type: "models" });
    assert.strictEqual(choices.models[0].id, "allowed");
    assert.strictEqual(
      (await h.send({ type: "test", model: "not-listed" })).ok,
      false,
    );
    assert.strictEqual(
      (await h.send({ type: "test", model: "allowed" })).text,
      "Hello",
    );
    const inference = h.fetches.find((f) =>
      String(f.url).endsWith("/responses"),
    );
    assert.strictEqual(
      new Headers(inference!.init!.headers).get("Authorization"),
      "Bearer SECRET_ACCESS",
    );
    assert.strictEqual(
      JSON.parse(inference!.init!.body as string).store,
      false,
    );
    assert.strictEqual(inference!.init!.credentials, "omit");
    assert.strictEqual((await h.send({ type: "logout" })).ok, true);
    assert.strictEqual((await h.send({ type: "status" })).signedIn, false);
    assert.ok(h.fetches.some((f) => String(f.url).endsWith("/revoke")));
  } finally {
    await h.close();
  }
});
test("cancel, invalid state, failed exchange and permission failure release the callback rule", async () => {
  const h = await harness();
  try {
    await h.send({ type: "login" });
    await h.send({ type: "cancel" });
    assert.strictEqual(h.rules.size, 0);
    await h.send({ type: "login" });
    assert.strictEqual((await h.complete({ state: "spoof" })).ok, false);
    assert.strictEqual(h.rules.size, 0);
    assert.strictEqual(h.fetches.length, 0);
    await h.send({ type: "login" });
    assert.strictEqual(
      (await h.complete({ error: "access_denied" })).ok,
      false,
    );
    assert.strictEqual(h.rules.size, 0);
    await h.send({ type: "login" });
    h.setTokenHook(
      () => new Response("SECRET_TOKEN_DO_NOT_LEAK", { status: 400 }),
    );
    const result = await h.complete();
    assert.strictEqual(result.ok, false);
    assert.ok(!result.error.includes("SECRET"));
    assert.strictEqual(h.rules.size, 0);
    h.setTokenHook(() => {
      throw new TypeError("SECRET network error");
    });
    await h.send({ type: "login" });
    assert.ok(!(await h.complete()).error.includes("SECRET"));
  } finally {
    await h.close();
  }
});
test("logout during code exchange cannot restore credentials", async () => {
  const h = await harness();
  try {
    await h.send({ type: "login" });
    let release!: MockCallback;
    const delayed = new Promise((resolve) => {
      release = resolve;
    });
    h.setTokenHook(() => delayed);
    const completion = h.complete();
    // Let callback processing reach its mocked network request.
    await new Promise((resolve) => setImmediate(resolve));
    await h.send({ type: "logout" });
    release!(
      Response.json({
        access_token: "LATE",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid",
      }),
    );
    assert.strictEqual((await completion).ok, false);
    assert.strictEqual((await h.send({ type: "status" })).signedIn, false);
    assert.strictEqual(h.rules.size, 0);
  } finally {
    await h.close();
  }
});
test("restart retains host and registrations but no credentials", async () => {
  const h = await harness({
    hostId: "urn:uuid:saved",
    registrations: [{ clientId: "oaiapp_saved", subject: "user" }],
  });
  try {
    const status = await h.send({ type: "status" });
    assert.strictEqual(status.signedIn, false);
    assert.strictEqual(status.registrations[0].clientId, "oaiapp_saved");
    await h.send({ type: "login", clientId: "oaiapp_saved" });
    const url = new URL(h.updates[0]!.url);
    assert.strictEqual(
      url.searchParams.get("ext_agent_host_id"),
      "urn:uuid:saved",
    );
    assert.strictEqual(url.searchParams.get("client_id"), "oaiapp_saved");
  } finally {
    await h.close();
  }
});

test("expired credentials rotate and subsequent refresh uses the latest token", async () => {
  const h = await harness();
  const now = Date.now;
  try {
    h.setExpiry(1);
    await h.send({ type: "login" });
    assert.strictEqual((await h.complete()).ok, true);
    let count = 0;
    h.setTokenHook((_url: string, init: RequestInit) => {
      const fields = new URLSearchParams(init!.body as string);
      assert.strictEqual(fields.get("grant_type"), "refresh_token");
      assert.strictEqual(
        fields.get("refresh_token"),
        count === 0 ? "SECRET_REFRESH" : "ROTATED",
      );
      count++;
      return Response.json({
        access_token: "RENEWED",
        refresh_token: "ROTATED",
        token_type: "Bearer",
        expires_in: 3600,
      });
    });
    const [first, concurrent] = await Promise.all([
      h.send({ type: "models" }),
      h.send({ type: "models" }),
    ]);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(concurrent.ok, true);
    assert.strictEqual(count, 1);
    assert.strictEqual((await h.send({ type: "models" })).ok, true);
    assert.strictEqual(count, 1);
    Date.now = () => now() + 3_600_000;
    assert.strictEqual((await h.send({ type: "models" })).ok, true);
    assert.strictEqual(count, 2);
    assert.ok(!JSON.stringify(h.stored).includes("ROTATED"));
  } finally {
    Date.now = now;
    await h.close();
  }
});
test("cancel during rule installation waits for installation and removes the rule", async () => {
  const h = await harness();
  try {
    let release!: MockCallback;
    const entered = Promise.withResolvers<void>();
    h.setRuleHook(
      () =>
        new Promise((resolve) => {
          release = resolve;
          entered.resolve();
        }),
    );
    const login = h.send({ type: "login" });
    await entered.promise;
    const cancelled = h.send({ type: "cancel" });
    release!();
    assert.strictEqual((await login).ok, false);
    assert.strictEqual((await cancelled).ok, true);
    assert.strictEqual(h.rules.size, 0);
    assert.strictEqual(h.updates.length, 0);
    assert.strictEqual((await h.send({ type: "status" })).pending, false);
    h.setRuleHook(() => {
      throw new Error("Permission denied");
    });
    assert.strictEqual((await h.send({ type: "login" })).ok, false);
    assert.strictEqual(h.rules.size, 0);
  } finally {
    await h.close();
  }
});

test("browser restart requires PIN, restores saved sign-in and refreshes only on demand", async () => {
  const h = await harness();
  try {
    await h.send({ type: "login" });
    assert.strictEqual((await h.complete()).ok, true);
    const before = h.fetches.length;
    await h.restart();
    assert.strictEqual((await h.send({ type: "status" })).signedIn, true);
    assert.strictEqual((await h.send({ type: "models" })).ok, true);
    assert.strictEqual(h.fetches.length, before + 1); // cached access token survives event page restart
    await h.restart(true);
    const locked = await h.send({ type: "status" });
    assert.strictEqual(locked.locked, true);
    assert.strictEqual(locked.signedIn, false);
    assert.strictEqual((await h.send({ type: "models" })).ok, false);
    assert.strictEqual(
      (await h.send({ type: "unlock", pin: "1234" })).ok,
      true,
    );
    assert.strictEqual((await h.send({ type: "status" })).signedIn, true);
    assert.strictEqual(h.fetches.length, before + 1); // unlocking does not refresh
    h.setTokenHook(() =>
      Response.json({
        access_token: "RESTORED",
        refresh_token: "ROTATED",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    assert.strictEqual((await h.send({ type: "models" })).ok, true);
    await h.send({ type: "logout" });
    assert.deepStrictEqual(h.stored, {});
    await h.restart(true);
    const cleared = await h.send({ type: "status" });
    assert.strictEqual(cleared.configured, false);
    assert.strictEqual(cleared.signedIn, false);
  } finally {
    await h.close();
  }
});

test("locked reset and strict message/private browsing boundaries", async () => {
  const h = await harness();
  try {
    await h.restart(true);
    assert.strictEqual(
      (await h.send({ type: "unlock", pin: "1234", url: "https://evil.test" }))
        .ok,
      false,
    );
    assert.strictEqual(
      await h.send(
        { type: "unlock", pin: "1234" },
        {
          id: "scraper",
          url: "moz-extension://scraper/settings.html",
          tab: { id: 1, incognito: true },
        },
      ),
      undefined,
    );
    assert.strictEqual(
      (await h.send({ type: "login", clientId: 42 })).ok,
      false,
    );
    assert.strictEqual((await h.send({ type: "logout" })).ok, true);
    assert.strictEqual((await h.send({ type: "status" })).configured, false);
  } finally {
    await h.close();
  }
});

test("callback sender may retain its original fragment after history replacement", async () => {
  const h = await harness();
  try {
    await h.send({ type: "login" });
    assert.strictEqual(
      (await h.complete({}, 42, "#original-callback-fragment")).ok,
      true,
    );
    assert.strictEqual((await h.send({ type: "status" })).signedIn, true);
  } finally {
    await h.close();
  }
});

test("sidebar can inspect and unlock saved auth but cannot manage the account", async () => {
  const h = await harness();
  const sidebar = {
    id: "scraper",
    url: "moz-extension://scraper/scraper.html?window=7",
    frameId: 0,
  };
  try {
    await h.send({ type: "login" });
    assert.strictEqual((await h.complete()).ok, true);
    await h.restart(true);
    const status = await h.send({ type: "status" }, sidebar);
    assert.strictEqual(status.locked, true);
    assert.ok(!JSON.stringify(status).includes("SECRET"));
    for (const type of ["login", "logout", "models", "test"])
      assert.strictEqual(await h.send({ type }, sidebar), undefined);
    assert.strictEqual(
      await h.send({ type: "unlock", pin: "1234" }, { ...sidebar, frameId: 1 }),
      undefined,
    );
    assert.strictEqual(
      await h.send(
        { type: "unlock", pin: "1234" },
        { ...sidebar, tab: { id: 2, incognito: true } },
      ),
      undefined,
    );
    assert.strictEqual(
      (await h.send({ type: "unlock", pin: "1234" }, sidebar)).ok,
      true,
    );
    assert.strictEqual(
      (await h.send({ type: "status" }, sidebar)).signedIn,
      true,
    );
  } finally {
    await h.close();
  }
});
