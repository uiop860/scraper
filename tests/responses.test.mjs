import assert from "node:assert/strict";
import { test } from "node:test";
import { bundle } from "./helpers.mjs";
const { testModel } = await import(await bundle("extension/auth/client.ts"));
const tokens = { accessToken: "PRIVATE_TOKEN" };
const event = (value) =>
  `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
// Minimized reproduction of the user's successful response: metadata can appear
// between text deltas and the terminal event. No real account identifiers stored.
const successful =
  event({ type: "response.created", response: { status: "in_progress" } }) +
  event({ type: "response.output_text.delta", delta: "Hello from Scraper." }) +
  event({ type: "response.metadata", metadata: {} }) +
  event({ type: "response.completed", response: { status: "completed" } });

test("SDK consumes valid SSE regardless of missing or mismatched media type", async () => {
  const original = globalThis.fetch;
  try {
    for (const type of [
      null,
      "application/octet-stream",
      "text/plain",
      "text/event-stream",
      "TEXT/EVENT-STREAM; charset=utf-8",
    ]) {
      globalThis.fetch = async (url, init) => {
        assert.equal(String(url), "https://api.openai.com/v1/responses");
        assert.equal(
          new Headers(init.headers).get("authorization"),
          "Bearer PRIVATE_TOKEN",
        );
        assert.equal(init.credentials, "omit");
        assert.equal(init.redirect, "error");
        const body = JSON.parse(init.body);
        assert.equal(body.stream, true);
        assert.equal(body.store, false);
        assert.equal(body.model, "gpt-6-luna");
        return new Response(new TextEncoder().encode(successful), {
          headers: type ? { "content-type": type } : {},
        });
      };
      assert.equal(
        await testModel(tokens, "gpt-6-luna", new AbortController().signal),
        "Hello from Scraper.",
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});
test("unexpected response formats report safe status and format diagnostics", async () => {
  const original = globalThis.fetch;
  try {
    for (const [type, body] of [
      ["application/json", '{"error":{"message":"PRIVATE_TOKEN"}}'],
      ["text/html", "<html>PRIVATE_TOKEN</html>"],
      [
        "text/event-stream",
        'data: {"type":"response.failed","response":{"error":{"message":"PRIVATE_TOKEN"}}}\n\n',
      ],
    ]) {
      globalThis.fetch = async () =>
        new Response(body, { headers: { "content-type": type } });
      await assert.rejects(
        testModel(tokens, "model", new AbortController().signal),
        (error) => {
          assert.ok(error.message.includes("HTTP 200"));
          assert.ok(error.message.includes(type));
          assert.ok(!error.message.includes("PRIVATE_TOKEN"));
          return true;
        },
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});
test("SDK rejects partial streams and bounds response bytes", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        event({ type: "response.output_text.delta", delta: "partial" }),
      );
    await assert.rejects(
      testModel(tokens, "model", new AbortController().signal),
      /before successful completion/,
    );
    globalThis.fetch = async () => new Response("x".repeat(2_000_001));
    await assert.rejects(
      testModel(tokens, "model", new AbortController().signal),
      /exceeded the prototype limit/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
