import OpenAI from "openai";
import {
  AuthError,
  ISSUER,
  RESOURCE,
  parseTokens,
  collectResponse,
  record,
  verifyIdentity,
  type Tokens,
} from "./protocol";
import type { JSONWebKeySet } from "jose";

export async function request(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    const response = await fetch(url, {
      ...init,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AuthError(
        `OpenAI request failed (HTTP ${response.status}). Check permissions, account access, or sign in again.`,
      );
    }
    return response;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(
      "Request cancelled, timed out, or blocked. Check the extension's site permissions and connection.",
    );
  }
}
export async function identity(
  token: string,
  clientId: string,
  signal: AbortSignal,
  nonce?: string,
  subject?: string,
) {
  const response = await request(`${ISSUER}/.well-known/jwks.json`, {}, signal);
  const keys: unknown = await response.json();
  if (!record(keys) || !Array.isArray(keys.keys))
    throw new AuthError("OpenAI identity keys were unavailable.");
  return verifyIdentity(
    token,
    keys as unknown as JSONWebKeySet,
    clientId,
    nonce,
    subject,
  );
}
export async function tokenRequest(
  fields: Record<string, string>,
  signal: AbortSignal,
  previous?: Tokens,
) {
  const response = await request(
    `${ISSUER}/api/accounts/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...fields, resource: RESOURCE }),
    },
    signal,
  );
  return parseTokens(await response.json(), previous);
}
export async function models(tokens: Tokens, signal: AbortSignal) {
  const response = await request(
    `${RESOURCE}/models`,
    { headers: { Authorization: `Bearer ${tokens.accessToken}` } },
    signal,
  );
  const data: unknown = await response.json();
  if (!record(data) || !Array.isArray(data.models))
    throw new AuthError("OpenAI returned an unexpected model catalog.");
  return data.models
    .filter(record)
    .filter((m) => m.visibility === "list" && typeof m.slug === "string")
    .slice(0, 100)
    .map((m) => ({
      id: m.slug as string,
      name:
        typeof m.display_name === "string"
          ? m.display_name
          : (m.slug as string),
    }));
}
export async function testModel(
  tokens: Tokens,
  model: string,
  signal: AbortSignal,
) {
  let details = "no response headers received";
  let bodyFailure: AuthError | undefined;
  let transportFailure: AuthError | undefined;
  const client = new OpenAI({
    apiKey: tokens.accessToken,
    baseURL: RESOURCE,
    // Only the trusted extension background constructs this client. These are
    // temporary OAuth tokens, never a bundled API key or a webpage credential.
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    timeout: 60_000,
    logLevel: "off",
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== `${RESOURCE}/responses`)
        throw new AuthError("Unexpected AI request destination.");
      let response: Response;
      try {
        response = await request(url, init ?? {}, signal);
      } catch (error) {
        if (error instanceof AuthError) transportFailure = error;
        throw error;
      }
      const mediaType = response.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase();
      // Only known media types are shown; never include arbitrary response data.
      const format = !mediaType
        ? "Content-Type missing"
        : [
              "text/event-stream",
              "application/json",
              "application/octet-stream",
              "text/plain",
              "text/html",
            ].includes(mediaType)
          ? mediaType
          : "other Content-Type";
      details = `HTTP ${response.status}; ${format}`;
      if (!response.body)
        throw new AuthError(`OpenAI returned an empty response (${details}).`);
      let bytes = 0;
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength;
            if (bytes > 2_000_000) {
              bodyFailure = new AuthError(
                "AI response exceeded the prototype limit.",
              );
              controller.error(bodyFailure);
            } else controller.enqueue(chunk);
          },
        }),
      );
      // The SDK selects SSE decoding from stream:true, without rejecting valid
      // event bytes when an intermediary omits or changes the media-type header.
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      });
    },
  });
  try {
    const events = await client.responses.create(
      {
        model,
        input: [{ role: "user", content: "Say exactly: Hello from Scraper." }],
        store: false,
        stream: true,
      },
      { signal },
    );
    return await collectResponse(events);
  } catch (error) {
    if (bodyFailure) throw bodyFailure;
    if (transportFailure) throw transportFailure;
    if (error instanceof AuthError)
      throw new AuthError(`${error.message} (${details})`);
    // SDK exceptions can contain server bodies/headers. Keep those private.
    throw new AuthError(
      `The AI response could not be read (${details}). Retry or check account access.`,
    );
  }
}
