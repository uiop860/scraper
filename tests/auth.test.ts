import { assert, expect, test } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Stream } from "openai/core/streaming";
import * as p from "../extension/auth/protocol.ts";
const attempt = { state: "state", nonce: "nonce", verifier: "verifier" };
const callback = (params: Record<string, string> = {}) =>
  `${p.REDIRECT}?${new URLSearchParams({ state: "state", code: "code", client_id: "oaiapp_test", ...params })}`;

test("PKCE matches RFC 7636 S256 test vector", async () => {
  assert.strictEqual(
    await p.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});
test("new and returning authorization use documented loopback contract", async () => {
  const url = new URL(await p.authorizationUrl(attempt, "urn:uuid:test"));
  assert.strictEqual(
    url.origin + url.pathname,
    `${p.ISSUER}/api/accounts/authorize`,
  );
  assert.strictEqual(url.searchParams.get("client_id"), "dynamic_agent_client");
  assert.strictEqual(url.searchParams.get("redirect_uri"), p.REDIRECT);
  assert.strictEqual(url.searchParams.get("resource"), p.RESOURCE);
  assert.strictEqual(url.searchParams.get("nonce"), "nonce");
  assert.ok(
    url.searchParams.get("scope")!.includes("chatgpt.tokens.use.direct"),
  );
  const returning = new URL(
    await p.authorizationUrl(
      { ...attempt, registration: { clientId: "saved", subject: "user" } },
      "host",
    ),
  );
  assert.strictEqual(returning.searchParams.get("client_id"), "saved");
  assert.strictEqual(returning.searchParams.has("agent_name_hint"), false);
});
test("callback rejects wrong state, duplicate parameters, alternate destinations and client substitution", () => {
  assert.deepStrictEqual(p.parseCallback(callback({}), attempt), {
    code: "code",
    clientId: "oaiapp_test",
  });
  for (const value of [
    callback({ state: "wrong" }),
    callback({}) + "&state=state",
    callback({ error: "access_denied" }),
    callback({ client_id: "dynamic_agent_client" }),
    callback({}).replace("127.0.0.1", "localhost"),
    callback({}).replace("1455", "1456"),
    callback({}) + "#fragment",
    callback({}).replace("/auth/callback", "/auth/callback/extra"),
  ]) {
    assert.throws(() => p.parseCallback(value, attempt), p.AuthError);
  }
  assert.throws(() =>
    p.parseCallback(callback({}), {
      ...attempt,
      registration: { clientId: "different", subject: "user" },
    }),
  );
});
test("rule only targets the exact callback and login tab", () => {
  const rule = p.callbackRule(42, "moz-extension://test/callback.html");
  assert.deepStrictEqual(rule.condition.tabIds, [42]);
  assert.deepStrictEqual(rule.condition.resourceTypes, ["main_frame"]);
  const pattern = new RegExp(rule.condition.regexFilter!);
  assert.ok(pattern.test(callback({})));
  for (const url of [
    "http://localhost:1455/auth/callback",
    "http://127.0.0.1:14550/auth/callback",
    "http://127.0.0.1:1455/auth/callback/extra",
    "https://evil.test/" + p.REDIRECT,
  ])
    assert.strictEqual(pattern.test(url), false);
});
test("ID tokens require trusted signature, issuer, audience, expiry, nonce and matching identity", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const keys = {
    keys: [{ ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" }],
  };
  const sign = (claims: import("jose").JWTPayload = {}, key = privateKey) =>
    new SignJWT({ nonce: "nonce", email: "test@example.test", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(p.ISSUER)
      .setAudience("client")
      .setSubject("user")
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? "5m")
      .sign(key);
  const token = await sign();
  assert.strictEqual(
    (await p.verifyIdentity(token, keys, "client", "nonce")).subject,
    "user",
  );
  await expect(
    p.verifyIdentity(token, keys, "wrong", "nonce"),
  ).rejects.toThrow();
  await expect(
    p.verifyIdentity(token, keys, "client", "wrong"),
  ).rejects.toThrow();
  await expect(
    p.verifyIdentity(token, keys, "client", "nonce", "other"),
  ).rejects.toThrow();
  await expect(
    p.verifyIdentity(await sign({ exp: 1 }), keys, "client", "nonce"),
  ).rejects.toThrow();
  const other = await generateKeyPair("RS256");
  await expect(
    p.verifyIdentity(await sign({}, other.privateKey), keys, "client", "nonce"),
  ).rejects.toThrow();
});
test("token parsing rotates refresh tokens and preserves omitted refresh grant scopes", () => {
  const first = p.parseTokens({
    access_token: "a",
    refresh_token: "r",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "openid chatgpt.tokens.use.direct",
  });
  const refreshed = p.parseTokens(
    {
      access_token: "b",
      refresh_token: "r2",
      token_type: "Bearer",
      expires_in: 3600,
    },
    first,
  );
  assert.strictEqual(refreshed.refreshToken, "r2");
  assert.deepStrictEqual(refreshed.scopes, first.scopes);
  assert.strictEqual(
    p.parseTokens(
      { access_token: "c", token_type: "Bearer", expires_in: 1 },
      refreshed,
    ).refreshToken,
    "r2",
  );
  assert.throws(() =>
    p.parseTokens({
      access_token: "a",
      token_type: "Bearer",
      expires_in: -1,
      scope: "",
    }),
  );
});
function stream(events: unknown[]) {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
  );
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 3)
        controller.enqueue(bytes.slice(i, i + 3));
      controller.close();
    },
  });
}
test("SSE handles split UTF-8 and requires successful terminal completion", async () => {
  assert.strictEqual(
    await readResponse(
      stream([
        { type: "response.output_text.delta", delta: "Héllo" },
        { type: "response.completed", response: { status: "completed" } },
      ]),
    ),
    "Héllo",
  );
  for (const type of ["response.failed", "response.incomplete", "error"])
    await expect(readResponse(stream([{ type }]))).rejects.toThrow();
  await expect(
    readResponse(
      stream([{ type: "response.output_text.delta", delta: "partial" }]),
    ),
  ).rejects.toThrow();
});

function readResponse(body: ReadableStream<Uint8Array>) {
  return p.collectResponse(
    Stream.fromSSEResponse(new Response(body), new AbortController()),
  );
}
