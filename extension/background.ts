import {
  AuthError,
  REDIRECT,
  RULE_ID,
  authorizationUrl,
  callbackRule,
  parseCallback,
  randomValue,
  record,
  type Attempt,
  type Registration,
  type Tokens,
} from "./auth/protocol";
import {
  identity,
  models,
  request,
  testModel,
  tokenRequest,
} from "./auth/client";

interface Pending extends Attempt {
  tabId?: number;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  consumed: boolean;
  cleanup?: Promise<void>;
}
let pending: Pending | undefined;
let starting: Promise<void> | undefined;
let session: { registration: Registration; tokens: Tokens } | undefined;
let refreshing: Promise<Tokens> | undefined;
let lifetime = new AbortController();
let notice =
  "Temporary credentials only. Background or browser restart requires sign-in again.";
let catalog: { id: string; name: string }[] = [];
let requesting = false;
// Event pages can restart while session rules survive. Remove stale interception first.
const ready = browser.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [RULE_ID],
});
void ready.catch(() => {
  notice = "Callback interception is unavailable. Check extension permissions.";
});

async function cleanup(p: Pending) {
  p.cleanup ??= (async () => {
    clearTimeout(p.timer);
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [RULE_ID],
    });
    if (pending === p) pending = undefined;
  })();
  await p.cleanup;
}
async function cancelLogin() {
  const p = pending;
  if (!p) return;
  p.controller.abort();
  // Wait for an in-flight rule installation before removing it.
  await starting?.catch(() => {});
  await cleanup(p);
  if (p.tabId !== undefined) await browser.tabs.remove(p.tabId).catch(() => {});
}
async function startLogin(clientId?: string) {
  if (pending) throw new AuthError("A sign-in is already in progress.");
  const p: Pending = {
    state: randomValue(),
    nonce: randomValue(),
    verifier: randomValue(),
    controller: new AbortController(),
    consumed: false,
  };
  pending = p;
  try {
    const saved = await browser.storage.local.get(["hostId", "registrations"]);
    const registrations = Array.isArray(saved.registrations)
      ? saved.registrations.filter(validRegistration)
      : [];
    if (clientId) {
      p.registration = registrations.find((r) => r.clientId === clientId);
      if (!p.registration)
        throw new AuthError("Select a saved account or add a new one.");
    }
    const hostId =
      typeof saved.hostId === "string"
        ? saved.hostId
        : `urn:uuid:${crypto.randomUUID()}`;
    await browser.storage.local.set({ hostId });
    const url = await authorizationUrl(p, hostId);
    p.controller.signal.throwIfAborted();
    const tab = await browser.tabs.create({ url: "about:blank" });
    p.tabId = tab.id;
    if (p.tabId === undefined)
      throw new AuthError("Could not open the sign-in tab.");
    p.controller.signal.throwIfAborted();
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [RULE_ID],
      addRules: [
        callbackRule(p.tabId, browser.runtime.getURL("callback.html")),
      ],
    });
    p.controller.signal.throwIfAborted();
    await browser.tabs.update(p.tabId, { url });
    p.controller.signal.throwIfAborted();
    p.timer = setTimeout(() => {
      notice = "Sign-in timed out. Start again.";
      void cancelLogin().catch(() => {
        notice = "Could not clean up sign-in. Reload the extension.";
      });
    }, 5 * 60_000);
    notice = "Complete sign-in in the OpenAI tab.";
  } catch (error) {
    p.controller.abort();
    await cleanup(p);
    if (p.tabId !== undefined)
      await browser.tabs.remove(p.tabId).catch(() => {});
    throw error;
  }
}
function validRegistration(value: unknown): value is Registration {
  return (
    record(value) &&
    typeof value.clientId === "string" &&
    typeof value.subject === "string" &&
    (value.email === undefined || typeof value.email === "string")
  );
}
async function completeLogin(
  value: string,
  sender: browser.runtime.MessageSender,
) {
  const p = pending;
  if (!p || p.consumed || sender.tab?.id !== p.tabId || sender.frameId !== 0)
    throw new AuthError("This sign-in attempt expired. Start again.");
  p.consumed = true;
  try {
    const result = parseCallback(value, p);
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [RULE_ID],
    });
    const tokens = await tokenRequest(
      {
        grant_type: "authorization_code",
        code: result.code,
        code_verifier: p.verifier,
        redirect_uri: REDIRECT,
        client_id: result.clientId,
      },
      p.controller.signal,
    );
    if (!tokens.idToken)
      throw new AuthError("OpenAI did not return an ID token.");
    const verified = await identity(
      tokens.idToken,
      result.clientId,
      p.controller.signal,
      p.nonce,
      p.registration?.subject,
    );
    p.controller.signal.throwIfAborted();
    const registration = { clientId: result.clientId, ...verified };
    const saved = await browser.storage.local.get("registrations");
    const registrations = Array.isArray(saved.registrations)
      ? saved.registrations.filter(validRegistration)
      : [];
    await browser.storage.local.set({
      registrations: [
        ...registrations.filter((r) => r.clientId !== registration.clientId),
        registration,
      ],
    });
    p.controller.signal.throwIfAborted();
    lifetime.abort();
    lifetime = new AbortController();
    refreshing = undefined;
    session = { registration, tokens };
    catalog = [];
    notice = tokens.scopes.includes("chatgpt.tokens.use.direct")
      ? "Signed in. Credentials are temporary."
      : "Signed in, but ChatGPT plan access was not granted.";
    return { ok: true, message: notice };
  } finally {
    await cleanup(p);
  }
}
async function credentials(): Promise<Tokens> {
  const current = session;
  if (!current) throw new AuthError("Sign in first.");
  if (!current.tokens.scopes.includes("chatgpt.tokens.use.direct"))
    throw new AuthError(
      "Authorize ChatGPT plan access before making AI requests.",
    );
  if (current.tokens.expiresAt > Date.now() + 60_000) return current.tokens;
  if (refreshing) return refreshing;
  const signal = lifetime.signal;
  const work = (async () => {
    if (!current.tokens.refreshToken)
      throw new AuthError("Credentials expired. Sign in again.");
    const tokens = await tokenRequest(
      {
        grant_type: "refresh_token",
        client_id: current.registration.clientId,
        refresh_token: current.tokens.refreshToken,
      },
      signal,
      current.tokens,
    );
    if (tokens.idToken)
      await identity(
        tokens.idToken,
        current.registration.clientId,
        signal,
        undefined,
        current.registration.subject,
      );
    signal.throwIfAborted();
    if (session !== current)
      throw new AuthError("Account changed. Retry your request.");
    current.tokens = tokens;
    if (!tokens.scopes.includes("chatgpt.tokens.use.direct"))
      throw new AuthError("ChatGPT plan access is no longer granted.");
    return tokens;
  })();
  refreshing = work;
  try {
    return await work;
  } finally {
    if (refreshing === work) refreshing = undefined;
  }
}
async function signOut() {
  lifetime.abort();
  lifetime = new AbortController();
  refreshing = undefined;
  const old = session;
  session = undefined;
  catalog = [];
  await cancelLogin();
  notice = "Signed out locally.";
  if (old?.tokens.refreshToken) {
    try {
      await request("https://auth.openai.com/api/accounts/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: old.tokens.refreshToken,
          token_type_hint: "refresh_token",
          client_id: old.registration.clientId,
        }),
      });
      notice = "Signed out and renewable session revoked.";
    } catch {
      notice =
        "Signed out locally. Remote revocation was not confirmed; disconnect Scraper in ChatGPT Settings.";
    }
  }
}
async function handle(message: unknown, sender: browser.runtime.MessageSender) {
  if (sender.id !== browser.runtime.id || !record(message)) return;
  const settings = browser.runtime.getURL("settings.html");
  const callback = browser.runtime.getURL("callback.html");
  try {
    if (
      sender.url === callback &&
      message.type === "callback" &&
      typeof message.url === "string"
    ) {
      return await completeLogin(message.url, sender);
    }
    if (
      sender.url !== settings ||
      (sender.frameId !== undefined && sender.frameId !== 0)
    )
      return;
    if (message.type === "status") {
      const saved = await browser.storage.local.get("registrations");
      return {
        ok: true,
        signedIn: !!session,
        account: session?.registration,
        pending: !!pending,
        notice,
        registrations: Array.isArray(saved.registrations)
          ? saved.registrations.filter(validRegistration)
          : [],
      };
    }
    if (message.type === "login") {
      await ready;
      if (starting || pending)
        throw new AuthError("A sign-in is already in progress.");
      const work = startLogin(
        typeof message.clientId === "string" ? message.clientId : undefined,
      );
      starting = work;
      try {
        await work;
      } finally {
        if (starting === work) starting = undefined;
      }
    } else if (message.type === "cancel") {
      await cancelLogin();
      notice = "Sign-in cancelled.";
    } else if (message.type === "logout") await signOut();
    else if (message.type === "models" || message.type === "test") {
      if (requesting) throw new AuthError("An AI request is already running.");
      requesting = true;
      const signal = lifetime.signal;
      try {
        const tokens = await credentials();
        signal.throwIfAborted();
        if (message.type === "models") {
          const choices = await models(tokens, signal);
          signal.throwIfAborted();
          catalog = choices;
          return { ok: true, models: choices };
        }
        if (
          typeof message.model !== "string" ||
          !catalog.some((m) => m.id === message.model)
        )
          throw new AuthError("Load and select an available model first.");
        const text = await testModel(tokens, message.model, signal);
        signal.throwIfAborted();
        return { ok: true, text };
      } finally {
        requesting = false;
      }
    } else throw new AuthError("Unknown request.");
    return { ok: true };
  } catch (error) {
    const text =
      error instanceof AuthError
        ? error.message
        : "The operation could not complete. Start again or check extension permissions.";
    notice = text;
    return { ok: false, error: text };
  }
}
browser.runtime.onMessage.addListener(handle);
browser.tabs.onRemoved.addListener((tabId) => {
  if (pending?.tabId === tabId)
    void cancelLogin().catch(() => {
      notice = "Could not clean up sign-in. Reload the extension.";
    });
});
browser.action.onClicked.addListener(() => {
  void browser.runtime.openOptionsPage();
});
