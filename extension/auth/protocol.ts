import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
export const REDIRECT = "http://127.0.0.1:1455/auth/callback";
export const RULE_ID = 1;
const SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

export class AuthError extends Error {
  status?: number;
  credentialsRejected = false;
}
export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function randomValue(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export async function challenge(verifier: string): Promise<string> {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
}
export interface Registration {
  clientId: string;
  subject: string;
  email?: string;
}
export interface Attempt {
  state: string;
  nonce: string;
  verifier: string;
  registration?: Registration;
}
export async function authorizationUrl(
  attempt: Attempt,
  hostId: string,
): Promise<string> {
  const url = new URL(`${ISSUER}/api/accounts/authorize`);
  url.search = new URLSearchParams({
    client_id: attempt.registration?.clientId ?? "dynamic_agent_client",
    ext_agent_host_id: hostId,
    response_type: "code",
    redirect_uri: REDIRECT,
    scope: SCOPES,
    resource: RESOURCE,
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge_method: "S256",
    code_challenge: await challenge(attempt.verifier),
  }).toString();
  if (!attempt.registration) url.searchParams.set("agent_name_hint", "Scraper");
  return url.href;
}
export function callbackRule(
  tabId: number,
  callbackPage: string,
): browser.declarativeNetRequest.Rule {
  return {
    id: RULE_ID,
    action: {
      type: "redirect",
      redirect: { regexSubstitution: `${callbackPage}#\\0` },
    },
    condition: {
      regexFilter: "^http://127\\.0\\.0\\.1:1455/auth/callback(\\?.*)?$",
      isUrlFilterCaseSensitive: true,
      resourceTypes: ["main_frame"],
      tabIds: [tabId],
    },
  };
}
export function parseCallback(
  value: string,
  attempt: Attempt,
): { code: string; clientId: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthError("Invalid sign-in callback.");
  }
  if (
    url.origin + url.pathname !== REDIRECT ||
    url.hash ||
    url.username ||
    url.password ||
    value.length > 16384
  ) {
    throw new AuthError("Invalid sign-in callback.");
  }
  for (const key of ["state", "code", "client_id", "error"]) {
    if (url.searchParams.getAll(key).length > 1)
      throw new AuthError("Ambiguous sign-in callback.");
  }
  if (url.searchParams.get("state") !== attempt.state)
    throw new AuthError("Sign-in state did not match. Start again.");
  if (url.searchParams.has("error"))
    throw new AuthError("Sign-in was declined or cancelled.");
  const code = url.searchParams.get("code");
  const clientId =
    url.searchParams.get("client_id") ?? attempt.registration?.clientId;
  if (
    !code ||
    !clientId ||
    clientId === "dynamic_agent_client" ||
    (attempt.registration && clientId !== attempt.registration.clientId)
  ) {
    throw new AuthError(
      "Sign-in did not return the expected client registration.",
    );
  }
  return { code, clientId };
}
export async function verifyIdentity(
  token: string,
  keys: JSONWebKeySet,
  clientId: string,
  nonce?: string,
  subject?: string,
) {
  try {
    const { payload } = await jwtVerify(token, createLocalJWKSet(keys), {
      issuer: ISSUER,
      audience: clientId,
      subject,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat"],
    });
    if (
      !payload.sub ||
      (nonce !== undefined && payload.nonce !== nonce) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== clientId) ||
      (payload.azp !== undefined && payload.azp !== clientId)
    )
      throw new Error();
    return {
      subject: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
    };
  } catch {
    const error = new AuthError(
      "OpenAI identity verification failed. Start sign-in again.",
    );
    error.credentialsRejected = true;
    throw error;
  }
}
export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  scopes: string[];
}
export function parseTokens(value: unknown, previous?: Tokens): Tokens {
  if (
    !record(value) ||
    typeof value.access_token !== "string" ||
    !value.access_token ||
    value.token_type !== "Bearer" ||
    typeof value.expires_in !== "number" ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0 ||
    (!previous && typeof value.scope !== "string")
  )
    throw new AuthError("OpenAI returned invalid credentials.");
  return {
    accessToken: value.access_token,
    refreshToken:
      typeof value.refresh_token === "string" && value.refresh_token
        ? value.refresh_token
        : previous?.refreshToken,
    idToken: typeof value.id_token === "string" ? value.id_token : undefined,
    expiresAt: Date.now() + value.expires_in * 1000,
    scopes:
      typeof value.scope === "string"
        ? value.scope.split(/\s+/).filter(Boolean)
        : (previous?.scopes ?? []),
  };
}
export async function collectResponse(
  events: AsyncIterable<unknown>,
): Promise<string> {
  let output = "";
  for await (const event of events) {
    if (!record(event))
      throw new AuthError("OpenAI returned an invalid event stream.");
    if (
      event.type === "response.output_text.delta" &&
      typeof event.delta === "string"
    )
      output += event.delta;
    if (
      event.type === "response.completed" &&
      record(event.response) &&
      event.response.status === "completed"
    )
      return output;
    if (
      [
        "error",
        "response.failed",
        "response.incomplete",
        "response.cancelled",
        "response.canceled",
      ].includes(String(event.type))
    ) {
      throw new AuthError(
        "The AI request did not complete. Check account access and usage limits.",
      );
    }
  }
  throw new AuthError("The AI stream ended before successful completion.");
}
