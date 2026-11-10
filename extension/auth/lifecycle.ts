import { AuthError, type Registration, type Tokens } from "./protocol";
import { identity, tokenRequest } from "./client";
import { CredentialStore, type Credential } from "./storage";

export class Authentication {
  readonly store = new CredentialStore();
  private current?: {
    credential: Credential;
    tokens?: Tokens;
    pending?: Tokens;
    dirty?: boolean;
  };
  private restoring?: Promise<void>;
  private refreshing?: Promise<Tokens>;
  private generation = 0;
  private controller = new AbortController();
  private retryAt = 0;
  private accepting = false;
  get signal() {
    return this.controller.signal;
  }
  async status() {
    const generation = this.generation;
    const stored = await this.store.status();
    if (generation !== this.generation)
      throw new AuthError("Authentication changed. Retry.");
    if (this.accepting)
      throw new AuthError("Account change is in progress. Retry.");
    if (!this.current && stored.credential)
      this.current = { credential: stored.credential, tokens: stored.tokens };
    return {
      configured: stored.configured,
      locked: stored.locked,
      signedIn: !!this.current,
      account: this.current?.credential.registration,
    };
  }
  async restore() {
    this.restoring ??= this.status()
      .then(() => {})
      .finally(() => {
        this.restoring = undefined;
      });
    await this.restoring;
  }
  async unlock(pin: string) {
    await this.store.unlock(pin);
    await this.restore();
  }
  async accept(
    registration: Registration,
    tokens: Tokens,
    signal: AbortSignal,
  ) {
    if (!tokens.refreshToken)
      throw new AuthError(
        "No renewable credentials were returned. Sign in again.",
      );
    signal.throwIfAborted();
    this.controller.abort();
    this.controller = new AbortController();
    const generation = ++this.generation;
    this.refreshing = undefined;
    this.current = undefined;
    const credential = {
      registration,
      refreshToken: tokens.refreshToken,
      scopes: tokens.scopes,
    };
    signal.throwIfAborted();
    this.accepting = true;
    try {
      await this.store.save(credential, tokens);
      signal.throwIfAborted();
      if (generation !== this.generation)
        throw new AuthError("Authentication changed. Retry.");
      this.current = { credential, tokens };
      this.retryAt = 0;
    } catch (error) {
      // Cancellation can arrive during an IndexedDB commit. Do not let status
      // restoration resurrect that abandoned login from the committed record.
      if (signal.aborted && generation === this.generation) await this.clear();
      throw error;
    } finally {
      this.accepting = false;
    }
  }
  async credentials(): Promise<Tokens> {
    await this.restore();
    if (this.refreshing) return this.refreshing;
    const current = this.current;
    if (!current) throw new AuthError("Unlock or sign in first.");
    if (!current.credential.scopes.includes("chatgpt.tokens.use.direct"))
      throw new AuthError(
        "Authorize ChatGPT plan access before making AI requests.",
      );
    const generation = this.generation;
    const signal = this.signal;
    const work = (async () => {
      if (current.dirty) {
        await this.store.save(current.credential, current.tokens);
        current.dirty = false;
      }
      signal.throwIfAborted();
      if (generation !== this.generation || this.current !== current)
        throw new AuthError("Account changed. Retry.");
      if (current.tokens && current.tokens.expiresAt > Date.now() + 60_000)
        return current.tokens;
      if (Date.now() < this.retryAt)
        throw new AuthError("Refresh temporarily unavailable. Retry shortly.");
      try {
        if (!current.pending) {
          const previous: Tokens = current.tokens ?? {
            accessToken: "",
            refreshToken: current.credential.refreshToken,
            expiresAt: 0,
            scopes: current.credential.scopes,
          };
          const tokens = await tokenRequest(
            {
              grant_type: "refresh_token",
              client_id: current.credential.registration.clientId,
              refresh_token: current.credential.refreshToken,
            },
            signal,
            previous,
          );
          signal.throwIfAborted();
          if (generation !== this.generation || this.current !== current)
            throw new AuthError("Account changed. Retry.");
          // Keep rotated credentials immediately. Retry disk writes with the new
          // token and retain the response until identity verification completes.
          current.credential = {
            ...current.credential,
            refreshToken:
              tokens.refreshToken ?? current.credential.refreshToken,
            scopes: tokens.scopes,
          };
          current.pending = tokens;
          current.tokens = undefined;
          current.dirty = true;
          await this.store.save(current.credential);
          current.dirty = false;
        }
        const tokens = current.pending;
        if (tokens.idToken)
          await identity(
            tokens.idToken,
            current.credential.registration.clientId,
            signal,
            undefined,
            current.credential.registration.subject,
          );
        signal.throwIfAborted();
        if (generation !== this.generation)
          throw new AuthError("Account changed. Retry.");
        current.pending = undefined;
        current.tokens = tokens;
        current.dirty = true;
        await this.store.save(current.credential, tokens);
        current.dirty = false;
        signal.throwIfAborted();
        if (generation !== this.generation || this.current !== current)
          throw new AuthError("Account changed. Retry.");
        if (!tokens.scopes.includes("chatgpt.tokens.use.direct"))
          throw new AuthError("ChatGPT plan access is no longer granted.");
        return tokens;
      } catch (error) {
        if (generation === this.generation) {
          this.retryAt = Date.now() + 5000;
          if (error instanceof AuthError && error.credentialsRejected)
            await this.clear();
        }
        throw error;
      }
    })();
    this.refreshing = work;
    try {
      return await work;
    } finally {
      if (this.refreshing === work) this.refreshing = undefined;
    }
  }
  invalidateAccess(tokens: Tokens) {
    if (this.current?.tokens === tokens) this.current.tokens = undefined;
  }
  async clear() {
    const old = this.current?.credential;
    this.generation++;
    this.controller.abort();
    this.controller = new AbortController();
    this.current = undefined;
    this.refreshing = undefined;
    this.retryAt = 0;
    await this.store.clear();
    return old;
  }
}
