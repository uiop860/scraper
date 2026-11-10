# Experimental ChatGPT sign-in

This is an open-source, Firefox-only feasibility prototype. It follows OpenAI's
current public-client registration and Responses API contract, while replacing
the documented loopback listener with Firefox navigation interception. It does
not use a server, native companion, relay website, or second extension.

## Redirect handling

OpenAI's documented redirect is `http://127.0.0.1:1455/auth/callback`, not
`localhost` or a `moz-extension` URL. The exact URI is sent in both authorization
and token exchange. Before navigating to OpenAI, the background opens a blank tab
and installs a session DNR rule restricted to that tab, the exact loopback URL,
and top-level navigation. Firefox redirects it into our callback page with the
original callback in its fragment, without contacting a loopback server. The
page immediately removes the fragment from its visible URL and sends the value
to the background. The background checks the extension sender, callback page,
top-level frame, tab, exact callback origin/path, state, and issued client ID.
A callback is consumed once. State is checked on errors as well as success.

The callback page is the only web-accessible resource. It cannot exchange codes
or return credentials to a website. Unknown tabs, frames, content scripts, and
extension pages cannot invoke account or inference operations. No external
messaging or website message bridge is installed.

Rules are removed after callback, failure, cancellation, tab closure, timeout,
and background initialization. New login requests cannot race an existing login.
Cancellation waits for any pending rule installation before cleanup. Other tabs'
Codex logins are outside the rule's scope. A browser extension with additional
permissions, compromised Firefox, or local malware is outside this boundary.

## OAuth and credential lifecycle

- First registration uses `dynamic_agent_client`, the actual app name `Scraper`,
  and a stable per-installation `urn:uuid:` host ID. Later login can select a saved
  registration and reuse its issued client ID and verified subject.
- Fresh random state, nonce, and PKCE verifier are generated with Web Crypto.
  SHA-256 PKCE uses Web Crypto; `jose` validates RS256 ID-token signatures against
  OpenAI's published JWKS, issuer, audience, subject, expiry, and nonce.
- On first use, set and confirm a four-digit PIN. After a Firefox restart, enter
  it once to unlock the saved account. Unlocking performs no OAuth exchange;
  requests refresh on demand. Forgetting the PIN requires resetting local sign-in
  and authorizing again. There is no PIN recovery service.
- `auth/storage.ts` owns a dedicated `scraper-auth` IndexedDB database. PBKDF2 with
  SHA-256, 600,000 iterations and a random 16-byte salt derives an AES-256-GCM key.
  Each write uses a fresh random 12-byte IV and authenticated schema/version data.
  The encrypted payload contains only the refresh token, verified registration,
  and granted scopes; an encrypted null payload verifies the PIN before login.
- The operational CryptoKey is non-extractable. Neither it nor a plaintext key or
  PIN is persisted to IndexedDB. To survive Firefox event-page suspension,
  `storage.session` holds derived key bytes and the short-lived access token.
  That API serializes JSON, so a CryptoKey cannot be used there directly. On
  resumption, key bytes are imported as a non-extractable CryptoKey. ID tokens
  remain in background memory only. Key bytes are sensitive credentials too.
- `auth/lifecycle.ts` owns restoration, expiry, one shared refresh promise,
  backoff, rotation, and cancellation generations. `auth/client.ts` keeps OAuth
  exchanges and fixed model operations; `background.ts` validates messages;
  settings receives only account/status and model results, never credentials.
- Access tokens are reused until 60 seconds before expiry. Rotated refresh tokens
  are committed before access tokens become available. If persistence fails, the
  running background retains the new token and retries the write, not the old
  exchange. A revision mismatch discards a stale session access-token cache.
  Refresh responses awaiting identity verification remain in memory for retry.
- Transient failures retain saved credentials and apply a five-second refresh
  backoff. Token-endpoint HTTP 400/401 responses invalidate local authentication;
  other HTTP/network errors allow retry. This is a deliberately conservative
  classification without displaying or logging provider error bodies. Invalid
  signed identity tokens also invalidate authentication. A model-list 401 retries
  once after renewal; billable inference is never automatically replayed.
- Logout/reset cancels work and deletes the encrypted vault record, session key
  bytes, cached access token, saved registrations (including legacy metadata),
  and host ID. Scraper configuration is untouched. Unlocked logout attempts remote
  revocation; a locked reset cannot decrypt the token to revoke it. Disconnect the
  app in ChatGPT Settings if revocation is unavailable. Browser cleanup is logical
  deletion, not forensic erasure of storage media or profile backups.
- The active registration is encrypted with its refresh token. Old non-secret
  registrations are still recognized for compatibility; new registrations are
  not written to content-script-readable `storage.local`. The non-secret host ID
  remains there until logout. This implementation persists one active account.
- Pending OAuth attempts are not resumed after event-page/browser restart; stale
  interception rules are removed and users can retry. Established sign-in survives.

### Threat model and PIN limits

The primary boundary is Firefox's extension origin and trusted background code,
not encryption alone. Webpages cannot open the extension's IndexedDB. Content
scripts use webpage-origin DOM storage and never receive credentials through
messages; they can access extension `storage.local`, so no secrets are stored
there. `storage.session` excludes content scripts in Firefox. The UI has no
credential imports or token-returning operations. A compromised extension UI,
callback page, background, malicious extension update, privileged debugger,
compromised browser, or local malware is outside this protection: extension pages
share an origin and privileges, and trusted code can use an unlocked key.

A four-digit PIN has only 10,000 possible values. PBKDF2 increases guessing cost,
but an attacker with the encrypted database can guess offline and bypass the UI's
short exponential retry delay. That delay resets when the background restarts.
This is modest protection while locked, not strong profile-theft resistance.
The session key is available to trusted extension pages while Firefox is running;
non-extractability of the operational CryptoKey does not change that fact. JS
strings and browser-managed copies cannot be reliably zeroed; temporary byte
buffers are cleared where practical. Memory dumps, swap, and OS compromise are
not covered. This is not an OS-backed keychain.

A browser-only key persisted beside ciphertext permits seamless automatic
restoration but provides little protection against full profile theft. A longer
user passphrase improves offline resistance but adds typing; a native keychain
companion or server-held token changes the browser-only requirement. The selected
PIN design follows the user's decision to require one unlock per Firefox session,
so unattended authenticated requests after a browser restart wait for unlock.
The reference design was investigated, not copied; unlike it, we do not persist
access/ID tokens or a usable encryption key on disk.

A refresh request and local database transaction cannot form an atomic operation.
If Firefox crashes after the server rotates a token but before the new token is
committed, the old record survives. On the next unlocked request, renewal retries
with that saved token; if the provider rejects it, local auth is cleared and the
user signs in again. No browser-only implementation can guarantee recovery of a
lost server response without provider support. The same caveat applies to an
interrupted initial code exchange and to account switching during server rotation.

### Firefox compatibility

The minimum Firefox version remains 142. `storage.session` is supported from 115;
Firefox does not implement Chrome's `setAccessLevel()`, and this code does not call
it. MV3 uses Firefox's document-based event page through `background.scripts`, not
an unsupported extension service worker. No background timers keep tokens alive.

Extension-context IndexedDB is origin-isolated and supports structured cloning,
including non-extractable CryptoKeys. We deliberately do not persist a key because
it would undermine the PIN gate. Storage is expected to survive normal updates of
the installed extension with the same add-on identity/origin. Schema version 1 and
a stable database name preserve records; unknown formats fail closed with reset
available. Removing/reinstalling, changing identity, clearing site/profile data,
quota failures, disk corruption, and temporary add-on profiles can lose data.
The dev task now uses an ignored `.firefox-profile/` with web-ext's
`--keep-profile-changes` and both `extensions.webextensions.keepStorageOnUninstall`
and `extensions.webextensions.keepUuidOnUninstall` preferences enabled. This
preserves authentication storage and its origin across dev shutdown/relaunch.
The preferences apply only to the dedicated development profile. Removing a
temporary extension therefore retains its data there; use logout/reset to clear
credentials, or delete that profile while Firefox is closed. Never use this
web-ext-modified profile as your daily browser profile. See
[Mozilla's persistence testing guide](https://extensionworkshop.com/documentation/develop/testing-persistent-and-restart-features/).

Actual installed-extension restart/update continuity remains a manual release
check; reopening a database in a fixture is not proof of those behaviors.

Private browsing is disabled with `incognito: "not_allowed"`; message handlers also
reject private-tab senders. Firefox does not support Chrome's isolated split mode.
There is no separate private authentication vault or assumption that private
windows isolate extension storage. Persistent storage cannot be promised in a
browser configured to discard its profile/data at shutdown.

## Permissions and network access

Authentication uses `storage` and the shared `declarativeNetRequest` permission.
Required host access is limited to `127.0.0.1`, `auth.openai.com`, and
`api.openai.com`. Match patterns cannot limit a host grant to one port; the actual
OAuth DNR rule restricts port/path/tab. Scraping additionally uses `scripting`,
`activeTab`, and optional HTTP(S) site grants requested when the user starts a run.
No `tabs`, cookies, webRequest, or native messaging permission is used. The scraper
content script remains independent of auth; see [scraping boundaries](scraping.md).

OpenAI requests run in the background with host permissions, omitted cookies,
no redirects, and bounded timeouts. The UI receives only sanitized errors, never
raw response bodies or authentication URLs. The manifest declares authentication
data collection. Adding scraping uploads will require revisiting Mozilla's data
collection declarations and consent requirements.

The token/revocation/JWKS paths are pinned to the paths observed in OpenAI's live
OIDC discovery document on 2026-11-10. The document advertises identity scopes;
the additional plan scopes come from the sign-in guide. The user has since
reported successful real-account login and a completed upstream greeting.

## Model access

The account-specific catalog comes from `https://api.openai.com/v1/models` using
the OAuth bearer token. Only entries with `visibility: list` populate the selector.
The fixed greeting goes to `/v1/responses` with `store: false` and `stream: true`.
There is no API key, ChatGPT cookie extraction, Codex client impersonation, private
`backend-api` endpoint, automatic tool execution, or scraped-page upload.

The official OpenAI JavaScript SDK generates requests and decodes SSE, including
streams with missing or mismatched Content-Type headers. SDK logging and automatic
retries are disabled, and browser execution is enabled only in our trusted
background context with short-lived OAuth access tokens. The wrapper limits response bytes
and reports only known media types and HTTP status on decoding failures. It
requires `response.completed` with completed status. Failed, incomplete, malformed,
interrupted, or oversized responses fail instead of reporting partial success.
The current UI displays the result after completion. A model listing is not proof
that inference will succeed; plan/workspace restrictions and shared quotas apply.
Only `chatgpt.tokens.use.direct` grants permit inference. ChatGPT plan access is
not unrestricted access to the OpenAI API, and preview field/tool limits apply.

## Verification

Run `mise run test` for mocked protocol and background tests, `mise run build` for
all static checks and packaging, and `mise run test:firefox` for a synthetic
callback in a temporary headless Firefox profile. The Firefox check installs a
throwaway fixture using the same callback rule/parser and actual callback page,
navigates to loopback without a listening server, verifies the callback arrives
in the expected tab, and removes the rule. It never signs into an account. The
fixture also checks SDK decoding of a synthetic stream with no Content-Type
header in Firefox. It additionally exercises actual IndexedDB encryption/reopening,
PIN unlocking after clearing session state, session restoration, non-extractable
CryptoKey structured cloning, and vault cleanup. It is not packaged or copied into source assets. Firefox is required
separately; `WEB_EXT_FIREFOX` can select its binary.

Automated mocks cover the PKCE RFC vector, new/returning registration parameters,
invalid/duplicate state, cancellation, wrong callback destinations/client IDs,
ID-token signature/nonce/audience/expiry failures, token rotation, expiration,
concurrent request rejection, failed exchange, mocked permission errors, callback
replay, wrong-tab/content-script access, logout during exchange, rule-installation
cancellation, PIN validation/backoff, encryption/decryption, corrupt envelopes and
ciphertext, restart locking, session restoration, full local cleanup, concurrent
refresh coalescing, transient/invalid-grant failures, and persistence retry after
rotation. IndexedDB tests use the development-only `fake-indexeddb` package and
real WebCrypto. They do not prove real installed-browser restart continuity or
that OpenAI will accept the app.

Manual real-account checks still required:

1. Run `mise run dev`, open Scraper from the toolbar, follow **Account settings**,
   set and confirm a PIN, then
   choose **Continue with ChatGPT**. Authorize the registered app and plan scopes. Confirm the callback
   stays in the extension and settings show the correct verified account.
2. Load models and send the fixed greeting. Confirm completion and check account
   usage. Test an account without plan consent or an exhausted allowance.
3. Cancel from OpenAI, close the login tab, cancel from settings, and retry.
4. Sign out and confirm revocation status, absence of auth records/session cache,
   and removal of host ID/registrations. Set a new PIN and sign in again. Repeat
   reset while locked and with damaged storage; unrelated scraper data must remain.
5. Test with an installed, signed extension in a persistent profile (temporary
   web-ext profiles do not establish this guarantee). Close and restart Firefox:
   the account stays locked until PIN entry, then model requests renew without
   interactive OAuth. Verify wrong PIN, session unlock across multiple UI tabs,
   background suspension, extension reload, and update under the same add-on ID.
   Updates/reloads may clear session storage and require PIN again. Pending OAuth
   callbacks must fail safely. Confirm private windows cannot use the extension.
6. Remove host permissions and verify a sanitized failure, then restore and retry.
7. Interrupt a refresh with offline mode and retry; ensure no rapid refresh loop.
   Interrupt after provider rotation/before persistence and verify either successful
   renewal or explicit reauthorization, never silent success with lost credentials.
8. Allow a real token to approach expiry and verify renewal; disconnect the app in
   ChatGPT Settings and verify a subsequent request fails without exposing tokens.

## Sources and support boundaries

- [OpenAI registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [OpenAI accounts, refresh, revocation, and credential security](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [OpenAI models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [OpenAI preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [OpenAI discovery](https://auth.openai.com/.well-known/openid-configuration)
- [Mozilla DNR](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest)
- [Mozilla rule conditions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest/RuleCondition)
- [Reference reviewed at 9079e62](https://github.com/EvanZhouDev/openai-oauth/tree/9079e62840a7f4b19114cb8f4bb0009b5bcf1773)

The reference inspired the interception experiment, but its relay design, OAuth
client ID, private endpoints, and unverified JWT decoding were not adopted. Its
WebCrypto/IndexedDB storage informed the independent PIN-protected vault. This code is an independent implementation of the documented protocol
and browser APIs. The documented sign-in contract is distinct from the
experimentally verified Firefox redirect mechanism; the user has reported successful live login and an upstream greeting completed
response. Rendering through the updated SDK path still needs a real-account
recheck.

Storage/security references reviewed on 2026-11-10:

- [Reference browser store at reviewed commit](https://github.com/EvanZhouDev/openai-oauth/blob/9079e62840a7f4b19114cb8f4bb0009b5bcf1773/packages/web/src/index.ts)
- [Firefox background environments](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)
- [Session storage](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/session)
- [Firefox storage compatibility data](https://github.com/mdn/browser-compat-data/blob/main/webextensions/api/storage.json)
- [Content-script boundaries](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts)
- [CryptoKey structured cloning](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm)
- [PBKDF2 in WebCrypto](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey)
- [WebCrypto security considerations](https://www.w3.org/TR/webcrypto/#security-considerations)
- [Firefox private browsing modes](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/incognito)
