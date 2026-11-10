import "./scraper/background";
import { registerScraperAgent } from "./scraper/agent-background";
import { Authentication } from "./auth/lifecycle";
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
const auth = new Authentication();
registerScraperAgent(auth);
let notice = "";
let catalog: { id: string; name: string }[] = [];
let requesting = false;
let resetting: Promise<void> | undefined;
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
    const active = (await auth.status()).account;
    const registrations = [
      ...(active ? [active] : []),
      ...(Array.isArray(saved.registrations)
        ? saved.registrations.filter(validRegistration)
        : []),
    ];
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
    await auth.accept(registration, tokens, p.controller.signal);
    catalog = [];
    notice = tokens.scopes.includes("chatgpt.tokens.use.direct")
      ? "Signed in. Sign-in is saved and protected by your PIN."
      : "Signed in, but ChatGPT plan access was not granted.";
    return { ok: true, message: notice };
  } finally {
    await cleanup(p);
  }
}
async function signOut() {
  // Invalidate background work immediately; cleanup completes before revocation.
  const clearing = auth.clear();
  catalog = [];
  const [old] = await Promise.all([clearing, cancelLogin()]);
  // A login cancelled during initialization may have written its host ID after
  // the first clear. Wait for initialization and remove that metadata as well.
  await browser.storage.local.remove(["hostId", "registrations"]);
  notice =
    "All local authentication data was removed. If sign-in was locked, disconnect Scraper in ChatGPT Settings to revoke it remotely.";
  if (old?.refreshToken) {
    try {
      await request("https://auth.openai.com/api/accounts/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: old.refreshToken,
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
  if (
    sender.id !== browser.runtime.id ||
    sender.tab?.incognito ||
    !record(message)
  )
    return;
  const settings = browser.runtime.getURL("settings.html");
  const callback = browser.runtime.getURL("callback.html");
  try {
    if (
      sender.url === callback &&
      message.type === "callback" &&
      typeof message.url === "string" &&
      Object.keys(message).every((key) => key === "type" || key === "url")
    ) {
      return await completeLogin(message.url, sender);
    }
    if (
      sender.url !== settings ||
      (sender.frameId !== undefined && sender.frameId !== 0)
    )
      return;
    const fields: Record<string, string[]> = {
      status: ["type"],
      login: ["type", "clientId"],
      unlock: ["type", "pin"],
      cancel: ["type"],
      logout: ["type"],
      models: ["type"],
      test: ["type", "model"],
    };
    if (
      typeof message.type !== "string" ||
      !Object.hasOwn(fields, message.type) ||
      Object.keys(message).some(
        (key) => !fields[message.type as string].includes(key),
      )
    )
      throw new AuthError("Invalid request.");
    if (message.type === "status") {
      const state = await auth.status();
      const saved = await browser.storage.local.get("registrations");
      return {
        ok: true,
        ...state,
        pending: !!pending,
        notice:
          notice ||
          (state.locked
            ? "Enter your PIN to unlock saved sign-in."
            : state.configured
              ? "Unlocked for this Firefox session."
              : "Set a four-digit PIN to protect saved sign-in."),
        registrations: [
          ...(state.account ? [state.account] : []),
          ...(Array.isArray(saved.registrations)
            ? saved.registrations
                .filter(validRegistration)
                .filter((r) => r.clientId !== state.account?.clientId)
            : []),
        ],
      };
    }
    if (resetting && message.type !== "logout")
      throw new AuthError("Local sign-in reset is in progress.");
    if (message.type === "unlock") {
      if (typeof message.pin !== "string")
        throw new AuthError("Enter exactly four digits.");
      await auth.unlock(message.pin);
      notice = "Unlocked for this Firefox session.";
      return { ok: true };
    }
    if (message.type === "login") {
      await ready;
      const state = await auth.status();
      if (!state.configured || state.locked)
        throw new AuthError("Set or enter your PIN first.");
      if (
        message.clientId !== undefined &&
        (typeof message.clientId !== "string" ||
          !message.clientId ||
          message.clientId.length > 1024)
      )
        throw new AuthError("Invalid account selection.");
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
    } else if (message.type === "logout") {
      resetting ??= signOut().finally(() => {
        resetting = undefined;
      });
      await resetting;
    } else if (message.type === "models" || message.type === "test") {
      if (message.type === "test" && requesting)
        throw new AuthError("An AI request is already running.");
      if (
        message.type === "test" &&
        (typeof message.model !== "string" ||
          !catalog.some((m) => m.id === message.model))
      )
        throw new AuthError("Load and select an available model first.");
      if (message.type === "test") requesting = true;
      const signal = auth.signal;
      try {
        const tokens = await auth.credentials();
        signal.throwIfAborted();
        if (message.type === "models") {
          let choices;
          try {
            choices = await models(tokens, signal);
          } catch (error) {
            if (!(error instanceof AuthError) || error.status !== 401)
              throw error;
            auth.invalidateAccess(tokens);
            choices = await models(await auth.credentials(), signal);
          }
          signal.throwIfAborted();
          catalog = choices;
          return { ok: true, models: choices };
        }
        if (
          typeof message.model !== "string" ||
          !catalog.some((m) => m.id === message.model)
        )
          throw new AuthError("Load and select an available model first.");
        const text = await testModel(tokens, message.model, signal).catch(
          (error: unknown) => {
            if (error instanceof AuthError && error.status === 401)
              auth.invalidateAccess(tokens);
            throw error;
          },
        );
        signal.throwIfAborted();
        return { ok: true, text };
      } finally {
        if (message.type === "test") requesting = false;
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
browser.runtime.onMessage.addListener((message, sender) => {
  // Do not claim scraper messages: Firefox uses only one listener response.
  if (
    sender.url !== browser.runtime.getURL("settings.html") &&
    sender.url !== browser.runtime.getURL("callback.html")
  )
    return;
  return handle(message, sender);
});
browser.tabs.onRemoved.addListener((tabId) => {
  if (pending?.tabId === tabId)
    void cancelLogin().catch(() => {
      notice = "Could not clean up sign-in. Reload the extension.";
    });
});
browser.action.onClicked.addListener((tab) => {
  void browser.tabs.create({
    url: browser.runtime.getURL(`scraper.html?tab=${tab.id ?? ""}`),
  });
});
