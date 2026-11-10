import { AuthError, record, type Registration, type Tokens } from "./protocol";

const DATABASE = "scraper-auth";
const SESSION = "scraperAuth";
const ITERATIONS = 600_000;
const aad = new TextEncoder().encode("scraper-auth:v1");
export interface Credential {
  registration: Registration;
  refreshToken: string;
  scopes: string[];
}
interface Envelope {
  version: 1;
  id: string;
  revision: string;
  salt: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}
interface Unlocked {
  envelope: Envelope;
  key: CryptoKey;
  // Only retained in browser.storage.session to survive event-page suspension.
  // WebExtension storage uses JSON, not CryptoKey structured cloning.
  bytes: number[];
  credential: Credential | null;
  tokens?: Tokens;
}
function validCredential(value: unknown): value is Credential | null {
  return (
    value === null ||
    (record(value) &&
      record(value.registration) &&
      typeof value.registration.clientId === "string" &&
      !!value.registration.clientId &&
      typeof value.registration.subject === "string" &&
      !!value.registration.subject &&
      (value.registration.email === undefined ||
        typeof value.registration.email === "string") &&
      typeof value.refreshToken === "string" &&
      !!value.refreshToken &&
      value.refreshToken.length <= 65536 &&
      Array.isArray(value.scopes) &&
      value.scopes.every((s) => typeof s === "string"))
  );
}
function validEnvelope(value: unknown): value is Envelope {
  return (
    record(value) &&
    value.version === 1 &&
    typeof value.id === "string" &&
    typeof value.revision === "string" &&
    value.salt instanceof Uint8Array &&
    value.salt.length === 16 &&
    value.iv instanceof Uint8Array &&
    value.iv.length === 12 &&
    value.ciphertext instanceof ArrayBuffer &&
    value.ciphertext.byteLength >= 16 &&
    value.ciphertext.byteLength <= 131072
  );
}
export async function importSessionKey(bytes: number[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(bytes),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
async function derive(pin: string, salt: Uint8Array<ArrayBuffer>) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
    material,
    256,
  );
  const bytes = Array.from(new Uint8Array(bits));
  new Uint8Array(bits).fill(0);
  return { bytes, key: await importSessionKey(bytes) };
}
async function encrypt(key: CryptoKey, credential: Credential | null) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(credential));
  try {
    return {
      iv,
      ciphertext: await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        key,
        plaintext,
      ),
    };
  } finally {
    plaintext.fill(0);
  }
}
async function decrypt(
  key: CryptoKey,
  envelope: Envelope,
): Promise<Credential | null> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: envelope.iv, additionalData: aad },
    key,
    envelope.ciphertext,
  );
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    if (!validCredential(value)) throw new Error();
    return value;
  } finally {
    new Uint8Array(plaintext).fill(0);
  }
}
// No scraper data or browser.storage.local entries enter this database.
export async function database(write?: Envelope | null): Promise<unknown> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DATABASE, 1);
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new AuthError("Authentication storage is unavailable."));
    }, 5000);
    open.onupgradeneeded = () => open.result.createObjectStore("vault");
    open.onsuccess = () => {
      clearTimeout(timer);
      if (settled) open.result.close();
      else {
        settled = true;
        resolve(open.result);
      }
    };
    open.onerror = open.onblocked = () => {
      clearTimeout(timer);
      settled = true;
      reject(new AuthError("Authentication storage is unavailable."));
    };
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(
        "vault",
        write === undefined ? "readonly" : "readwrite",
        { durability: "strict" },
      );
      const store = tx.objectStore("vault");
      const req =
        write === undefined
          ? store.get("active")
          : write === null
            ? store.clear()
            : store.put(write, "active");
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () =>
        reject(
          new AuthError(
            "Authentication storage could not be saved. Retry or reset local sign-in.",
          ),
        );
    });
  } finally {
    db.close();
  }
}
export class CredentialStore {
  private unlocked?: Unlocked;
  private queue: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private failures = 0;
  private retryAt = 0;
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const result = this.queue.then(() => {
      if (epoch !== this.epoch)
        throw new AuthError("Authentication changed. Retry.");
      return work();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  async status() {
    return this.serial(async () => {
      const envelope = await database();
      if (envelope !== undefined && !validEnvelope(envelope))
        throw new AuthError(
          "Stored credentials are damaged. Reset local sign-in.",
        );
      if (!this.unlocked && envelope) {
        const cached = (await browser.storage.session.get(SESSION))[SESSION];
        if (
          record(cached) &&
          cached.id === envelope.id &&
          Array.isArray(cached.bytes) &&
          cached.bytes.length === 32 &&
          cached.bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
        ) {
          try {
            const key = await importSessionKey(cached.bytes);
            const credential = await decrypt(key, envelope);
            const tokens =
              cached.revision === envelope.revision &&
              record(cached.tokens) &&
              typeof cached.tokens.accessToken === "string" &&
              typeof cached.tokens.expiresAt === "number" &&
              Number.isFinite(cached.tokens.expiresAt) &&
              Array.isArray(cached.tokens.scopes) &&
              cached.tokens.scopes.every((s) => typeof s === "string")
                ? (cached.tokens as unknown as Tokens)
                : undefined;
            this.unlocked = {
              envelope,
              key,
              bytes: cached.bytes,
              credential,
              tokens,
            };
          } catch {
            await browser.storage.session.remove(SESSION);
          }
        }
      }
      return {
        configured: !!envelope,
        locked: !!envelope && !this.unlocked,
        credential: this.unlocked?.credential,
        tokens: this.unlocked?.tokens,
      };
    });
  }
  async unlock(pin: string) {
    if (!/^\d{4}$/.test(pin)) throw new AuthError("Enter exactly four digits.");
    return this.serial(async () => {
      if (Date.now() < this.retryAt)
        throw new AuthError("Wait before trying your PIN again.");
      const saved = await database();
      if (saved !== undefined && !validEnvelope(saved))
        throw new AuthError(
          "Stored credentials are damaged. Reset local sign-in.",
        );
      if (this.unlocked) return;
      const salt = saved?.salt ?? crypto.getRandomValues(new Uint8Array(16));
      const { key, bytes } = await derive(pin, salt);
      let credential: Credential | null;
      try {
        credential = saved ? await decrypt(key, saved) : null;
      } catch {
        bytes.fill(0);
        this.failures++;
        this.retryAt =
          Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5));
        throw new AuthError(
          "Incorrect PIN or damaged credentials. Retry or reset local sign-in.",
        );
      }
      const envelope: Envelope = saved ?? {
        version: 1,
        id: crypto.randomUUID(),
        revision: crypto.randomUUID(),
        salt,
        ...(await encrypt(key, null)),
      };
      if (!saved) await database(envelope);
      this.unlocked = { envelope, key, bytes, credential };
      this.failures = 0;
      this.retryAt = 0;
      await this.cache();
    });
  }
  private async cache() {
    const current = this.unlocked!;
    await browser.storage.session.set({
      [SESSION]: {
        id: current.envelope.id,
        revision: current.envelope.revision,
        bytes: current.bytes,
        tokens: current.tokens,
      },
    });
  }
  async save(credential: Credential, tokens?: Tokens) {
    return this.serial(async () => {
      const current = this.unlocked;
      if (!current) throw new AuthError("Unlock with your PIN first.");
      if (!validCredential(credential))
        throw new AuthError("Invalid renewable credentials. Sign in again.");
      const envelope: Envelope = {
        ...current.envelope,
        revision: crypto.randomUUID(),
        ...(await encrypt(current.key, credential)),
      };
      await database(envelope);
      // Durable refresh-token commit precedes the disposable access-token cache.
      current.envelope = envelope;
      current.credential = credential;
      current.tokens = tokens
        ? {
            accessToken: tokens.accessToken,
            expiresAt: tokens.expiresAt,
            scopes: tokens.scopes,
          }
        : undefined;
      await this.cache();
    });
  }
  async clear() {
    this.epoch++;
    const result = this.queue.then(async () => {
      this.unlocked?.bytes.fill(0);
      this.unlocked = undefined;
      this.failures = 0;
      this.retryAt = 0;
      const results = await Promise.allSettled([
        database(null),
        browser.storage.session.remove(SESSION),
        browser.storage.local.remove(["hostId", "registrations"]),
      ]);
      if (results.some((r) => r.status === "rejected"))
        throw new AuthError(
          "Local cleanup failed. Retry reset before closing Firefox.",
        );
    });
    this.queue = result.catch(() => {});
    return result;
  }
}
