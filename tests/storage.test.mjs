import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { bundle } from "./helpers.mjs";
const { CredentialStore, database, importSessionKey } = await import(
  await bundle("extension/auth/storage.ts")
);
const { Authentication } = await import(
  await bundle("extension/auth/lifecycle.ts")
);
const credential = {
  registration: { clientId: "client", subject: "user" },
  refreshToken: "SECRET_REFRESH",
  scopes: ["chatgpt.tokens.use.direct"],
};
const tokens = {
  accessToken: "SECRET_ACCESS",
  refreshToken: credential.refreshToken,
  idToken: "SECRET_ID",
  expiresAt: Date.now() + 3600000,
  scopes: credential.scopes,
};
function setup() {
  globalThis.indexedDB = new IDBFactory();
  const data = {};
  const local = {
    hostId: "host",
    registrations: ["account"],
    scraperConfig: { name: "keep" },
  };
  globalThis.browser = {
    storage: {
      session: {
        async get(key) {
          return { [key]: structuredClone(data[key]) };
        },
        async set(value) {
          Object.assign(data, structuredClone(value));
        },
        async remove(key) {
          delete data[key];
        },
      },
      local: {
        async remove(keys) {
          for (const key of keys) delete local[key];
        },
      },
    },
  };
  return { data, local };
}
test("AES-GCM persistence, nonextractable key, random IVs, PIN unlock and complete cleanup", async () => {
  const { data, local } = setup();
  let store = new CredentialStore();
  await assert.rejects(store.unlock("abc"), /four digits/);
  await store.unlock("1234");
  await store.save(credential, tokens);
  const first = await database();
  assert.ok(!JSON.stringify(first).includes("SECRET"));
  assert.equal(first.iv.length, 12);
  assert.equal(first.salt.length, 16);
  assert.equal(first.key, undefined);
  const key = await importSessionKey(data.scraperAuth.bytes);
  assert.equal(key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("raw", key));
  const clone = structuredClone(key);
  assert.equal(clone.extractable, false);
  await store.save({ ...credential, refreshToken: "ROTATED" }, tokens);
  assert.notDeepEqual((await database()).iv, first.iv);
  store = new CredentialStore();
  assert.equal((await store.status()).tokens.accessToken, "SECRET_ACCESS");
  assert.equal(data.scraperAuth.tokens.idToken, undefined);
  assert.equal(data.scraperAuth.tokens.refreshToken, undefined);
  delete data.scraperAuth;
  store = new CredentialStore();
  assert.equal((await store.status()).locked, true);
  await assert.rejects(store.unlock("9999"), /Incorrect PIN/);
  await assert.rejects(store.unlock("1234"), /Wait/);
  store = new CredentialStore();
  await store.unlock("1234");
  assert.equal((await store.status()).credential.refreshToken, "ROTATED");
  await store.clear();
  assert.equal(await database(), undefined);
  assert.deepEqual(data, {});
  assert.deepEqual(local, { scraperConfig: { name: "keep" } });
});
test("corrupted ciphertext and invalid envelopes fail closed and remain resettable", async () => {
  const { data } = setup();
  const store = new CredentialStore();
  await store.unlock("1234");
  await store.save(credential, tokens);
  const envelope = await database();
  new Uint8Array(envelope.ciphertext)[0] ^= 1;
  await database(envelope);
  delete data.scraperAuth;
  const restarted = new CredentialStore();
  await assert.rejects(restarted.unlock("1234"), /damaged/);
  await database({ ...envelope, version: 42 });
  await assert.rejects(restarted.status(), /damaged/);
  await restarted.clear();
  assert.equal((await restarted.status()).configured, false);
});
test("concurrent refresh, rotation, network retry, invalid grant and logout race", async () => {
  setup();
  const auth = new Authentication();
  await auth.unlock("1234");
  await auth.accept(
    credential.registration,
    { ...tokens, expiresAt: 0 },
    new AbortController().signal,
  );
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(
      new URLSearchParams(init.body).get("refresh_token"),
      "SECRET_REFRESH",
    );
    return Response.json({
      access_token: "NEW",
      refresh_token: "ROTATED",
      expires_in: 3600,
      token_type: "Bearer",
    });
  };
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => auth.credentials()),
    );
    assert.equal(calls, 1);
    assert.ok(results.every((t) => t.accessToken === "NEW"));
    assert.equal(
      (await auth.store.status()).credential.refreshToken,
      "ROTATED",
    );
    auth.invalidateAccess(results[0]);
    globalThis.fetch = async () => {
      calls++;
      throw new TypeError("SECRET network failure");
    };
    await assert.rejects(auth.credentials(), /Request cancelled/);
    assert.equal((await auth.status()).signedIn, true);
    await assert.rejects(auth.credentials(), /Retry shortly/);
    assert.equal(calls, 2);
    // Restart discards transient backoff but retains current refresh credentials.
    await globalThis.browser.storage.session.remove("scraperAuth");
    const restarted = new Authentication();
    await restarted.unlock("1234");
    globalThis.fetch = async () =>
      new Response("SECRET invalid grant", { status: 400 });
    await assert.rejects(restarted.credentials(), /HTTP 400/);
    assert.equal((await restarted.status()).configured, false);
    await restarted.unlock("4321");
    await restarted.accept(
      credential.registration,
      { ...tokens, expiresAt: 0 },
      new AbortController().signal,
    );
    const entered = Promise.withResolvers();
    const delayed = Promise.withResolvers();
    globalThis.fetch = async () => {
      entered.resolve();
      return delayed.promise;
    };
    const refresh = restarted.credentials();
    await entered.promise;
    await restarted.clear();
    delayed.resolve(
      Response.json({
        access_token: "LATE",
        refresh_token: "LATE",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    );
    await assert.rejects(refresh);
    assert.equal((await restarted.status()).configured, false);
    assert.equal(await database(), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("failed persistence retries saving rotated token without a duplicate exchange", async () => {
  setup();
  const auth = new Authentication();
  await auth.unlock("1234");
  await auth.accept(
    credential.registration,
    { ...tokens, expiresAt: 0 },
    new AbortController().signal,
  );
  const originalFetch = globalThis.fetch;
  const save = auth.store.save.bind(auth.store);
  let calls = 0,
    failed = false;
  auth.store.save = async (...args) => {
    if (!failed) {
      failed = true;
      throw new Error("disk failure");
    }
    return save(...args);
  };
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      access_token: "NEW",
      refresh_token: "ROTATED",
      expires_in: 3600,
      token_type: "Bearer",
    });
  };
  try {
    await assert.rejects(auth.credentials(), /disk failure/);
    // Save ROTATED before retrying validation of the retained token response.
    await assert.rejects(auth.credentials(), /Retry shortly/);
    assert.equal(
      (await auth.store.status()).credential.refreshToken,
      "ROTATED",
    );
    assert.equal(calls, 1);
    const now = Date.now;
    try {
      Date.now = () => now() + 6000;
      assert.equal((await auth.credentials()).accessToken, "NEW");
      assert.equal(calls, 1);
    } finally {
      Date.now = now;
    }
  } finally {
    globalThis.fetch = originalFetch;
    await auth.clear();
  }
});

test("rotation committed before interrupted session caching restores latest refresh token", async () => {
  setup();
  const store = new CredentialStore();
  await store.unlock("1234");
  await store.save(credential, tokens);
  const set = globalThis.browser.storage.session.set;
  globalThis.browser.storage.session.set = async () => {
    throw new Error("cache interrupted");
  };
  await assert.rejects(
    store.save(
      { ...credential, refreshToken: "ROTATED" },
      { ...tokens, accessToken: "NEW" },
    ),
  );
  globalThis.browser.storage.session.set = set;
  const restored = await new CredentialStore().status();
  assert.equal(restored.locked, false);
  assert.equal(restored.credential.refreshToken, "ROTATED");
  assert.equal(restored.tokens, undefined); // old cache cannot override durable rotation
  await store.clear();
});

test("logout during PIN derivation clears any late setup write", async () => {
  setup();
  const store = new CredentialStore();
  const unlocking = store.unlock("1234");
  await new Promise((resolve) => setImmediate(resolve));
  const clearing = store.clear();
  await unlocking;
  await clearing;
  assert.equal(await database(), undefined);
  assert.equal((await store.status()).configured, false);
  assert.deepEqual(
    (await globalThis.browser.storage.session.get("scraperAuth")).scraperAuth,
    undefined,
  );
});

test("account switch cannot be overwritten by a late refresh response", async () => {
  setup();
  const auth = new Authentication();
  await auth.unlock("1234");
  await auth.accept(
    credential.registration,
    { ...tokens, expiresAt: 0 },
    new AbortController().signal,
  );
  const originalFetch = globalThis.fetch;
  const entered = Promise.withResolvers();
  const delayed = Promise.withResolvers();
  globalThis.fetch = async () => {
    entered.resolve();
    return delayed.promise;
  };
  try {
    const refreshing = auth.credentials();
    await entered.promise;
    await auth.accept(
      { clientId: "other", subject: "other" },
      { ...tokens, refreshToken: "OTHER" },
      new AbortController().signal,
    );
    delayed.resolve(
      Response.json({
        access_token: "LATE",
        refresh_token: "LATE",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    await assert.rejects(refreshing);
    assert.equal((await auth.status()).account.subject, "other");
    assert.equal((await auth.store.status()).credential.refreshToken, "OTHER");
  } finally {
    globalThis.fetch = originalFetch;
    await auth.clear();
  }
});

test("cancelled login during persistence cannot restore the committed credentials", async () => {
  setup();
  const auth = new Authentication();
  await auth.unlock("1234");
  const save = auth.store.save.bind(auth.store);
  const saved = Promise.withResolvers();
  const finish = Promise.withResolvers();
  auth.store.save = async (...args) => {
    await save(...args);
    saved.resolve();
    await finish.promise;
  };
  const controller = new AbortController();
  const accepting = auth.accept(
    credential.registration,
    tokens,
    controller.signal,
  );
  await saved.promise;
  controller.abort();
  finish.resolve();
  await assert.rejects(accepting);
  assert.equal((await auth.status()).signedIn, false);
  assert.equal(await database(), undefined);
});
