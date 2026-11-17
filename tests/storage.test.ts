import type { MockData } from "./mock-types.ts";
import { assert, expect, test } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  CredentialStore,
  database,
  importSessionKey,
} from "../extension/auth/storage.ts";
import { Authentication } from "../extension/auth/lifecycle.ts";
type Envelope = NonNullable<Parameters<typeof database>[0]>;
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
  const data: MockData = {};
  const local: MockData = {
    hostId: "host",
    registrations: ["account"],
    scraperConfig: { name: "keep" },
  };
  globalThis.browser = {
    storage: {
      session: {
        async get(key: string) {
          return { [key]: structuredClone(data[key]) };
        },
        async set(value: MockData) {
          Object.assign(data, structuredClone(value));
        },
        async remove(key: string) {
          delete data[key];
        },
      },
      local: {
        async remove(keys: string[]) {
          for (const key of keys) delete local[key];
        },
      },
    },
  } as unknown as typeof browser;
  return { data, local };
}
test("AES-GCM persistence, nonextractable key, random IVs, PIN unlock and complete cleanup", async () => {
  const { data, local } = setup();
  let store = new CredentialStore();
  await expect(store.unlock("abc")).rejects.toThrow(/four digits/);
  await store.unlock("1234");
  await store.save(credential, tokens);
  const first = (await database()) as Envelope;
  assert.ok(!JSON.stringify(first).includes("SECRET"));
  assert.strictEqual(first.iv.length, 12);
  assert.strictEqual(first.salt.length, 16);
  assert.strictEqual("key" in first ? first.key : undefined, undefined);
  const key = await importSessionKey(data.scraperAuth.bytes);
  assert.strictEqual(key.extractable, false);
  await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  const clone = structuredClone(key);
  assert.strictEqual(clone.extractable, false);
  await store.save({ ...credential, refreshToken: "ROTATED" }, tokens);
  assert.notDeepEqual(((await database()) as Envelope).iv, first.iv);
  store = new CredentialStore();
  assert.strictEqual(
    (await store.status()).tokens!.accessToken,
    "SECRET_ACCESS",
  );
  assert.strictEqual(data.scraperAuth.tokens.idToken, undefined);
  assert.strictEqual(data.scraperAuth.tokens.refreshToken, undefined);
  delete data.scraperAuth;
  store = new CredentialStore();
  assert.strictEqual((await store.status()).locked, true);
  await expect(store.unlock("9999")).rejects.toThrow(/Incorrect PIN/);
  await expect(store.unlock("1234")).rejects.toThrow(/Wait/);
  store = new CredentialStore();
  await store.unlock("1234");
  assert.strictEqual(
    (await store.status()).credential!.refreshToken,
    "ROTATED",
  );
  await store.clear();
  assert.strictEqual(await database(), undefined);
  assert.deepStrictEqual(data, {});
  assert.deepStrictEqual(local, { scraperConfig: { name: "keep" } });
});
test("corrupted ciphertext and invalid envelopes fail closed and remain resettable", async () => {
  const { data } = setup();
  const store = new CredentialStore();
  await store.unlock("1234");
  await store.save(credential, tokens);
  const envelope = (await database()) as Envelope;
  new Uint8Array(envelope.ciphertext)[0]! ^= 1;
  await database(envelope);
  delete data.scraperAuth;
  const restarted = new CredentialStore();
  await expect(restarted.unlock("1234")).rejects.toThrow(/damaged/);
  await database({ ...envelope, version: 42 } as unknown as Envelope);
  await expect(restarted.status()).rejects.toThrow(/damaged/);
  await restarted.clear();
  assert.strictEqual((await restarted.status()).configured, false);
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
    assert.strictEqual(
      new URLSearchParams(init!.body as string).get("refresh_token"),
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
    assert.strictEqual(calls, 1);
    assert.ok(results.every((t) => t.accessToken === "NEW"));
    assert.strictEqual(
      (await auth.store.status()).credential!.refreshToken,
      "ROTATED",
    );
    auth.invalidateAccess(results[0]!);
    globalThis.fetch = async () => {
      calls++;
      throw new TypeError("SECRET network failure");
    };
    await expect(auth.credentials()).rejects.toThrow(/Request cancelled/);
    assert.strictEqual((await auth.status()).signedIn, true);
    await expect(auth.credentials()).rejects.toThrow(/Retry shortly/);
    assert.strictEqual(calls, 2);
    // Restart discards transient backoff but retains current refresh credentials.
    await globalThis.browser.storage.session.remove("scraperAuth");
    const restarted = new Authentication();
    await restarted.unlock("1234");
    globalThis.fetch = async () =>
      new Response("SECRET invalid grant", { status: 400 });
    await expect(restarted.credentials()).rejects.toThrow(/HTTP 400/);
    assert.strictEqual((await restarted.status()).configured, false);
    await restarted.unlock("4321");
    await restarted.accept(
      credential.registration,
      { ...tokens, expiresAt: 0 },
      new AbortController().signal,
    );
    const entered = Promise.withResolvers<void>();
    const delayed = Promise.withResolvers<Response>();
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
    await expect(refresh).rejects.toThrow();
    assert.strictEqual((await restarted.status()).configured, false);
    assert.strictEqual(await database(), undefined);
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
    await expect(auth.credentials()).rejects.toThrow(/disk failure/);
    // Save ROTATED before retrying validation of the retained token response.
    await expect(auth.credentials()).rejects.toThrow(/Retry shortly/);
    assert.strictEqual(
      (await auth.store.status()).credential!.refreshToken,
      "ROTATED",
    );
    assert.strictEqual(calls, 1);
    const now = Date.now;
    try {
      Date.now = () => now() + 6000;
      assert.strictEqual((await auth.credentials()).accessToken, "NEW");
      assert.strictEqual(calls, 1);
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
  await expect(
    store.save(
      { ...credential, refreshToken: "ROTATED" },
      { ...tokens, accessToken: "NEW" },
    ),
  ).rejects.toThrow();
  globalThis.browser.storage.session.set = set;
  const restored = await new CredentialStore().status();
  assert.strictEqual(restored.locked, false);
  assert.strictEqual(restored.credential!.refreshToken, "ROTATED");
  assert.strictEqual(restored.tokens, undefined); // old cache cannot override durable rotation
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
  assert.strictEqual(await database(), undefined);
  assert.strictEqual((await store.status()).configured, false);
  assert.deepStrictEqual(
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
  const entered = Promise.withResolvers<void>();
  const delayed = Promise.withResolvers<Response>();
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
    await expect(refreshing).rejects.toThrow();
    assert.strictEqual((await auth.status()).account!.subject, "other");
    assert.strictEqual(
      (await auth.store.status()).credential!.refreshToken,
      "OTHER",
    );
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
  const saved = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
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
  await expect(accepting).rejects.toThrow();
  assert.strictEqual((await auth.status()).signedIn, false);
  assert.strictEqual(await database(), undefined);
});
