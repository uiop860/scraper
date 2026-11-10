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
- Credentials exist only in background memory. Access, refresh, and ID tokens are
  never persisted, returned by runtime messages, or logged. `storage.local` holds
  only the host ID and verified account/client mappings (including display email).
  These mappings are accessible to our content scripts and are not credentials.
- Credentials are refreshed on demand near expiry. Refreshes are serialized and
  replacement refresh tokens replace the old values. Errors require retry or
  reauthorization; there is no silent fallback to a private backend.
- Logout stops authenticated work, cancels login, clears local credentials, and
  attempts renewable-session revocation. The UI reports unconfirmed revocation.
  Saved account registrations and the host ID remain for later sign-in.
- Account switches abort requests for the previous account. Late callbacks and
  refresh responses cannot restore credentials after cancellation or logout.
- Firefox MV3 background suspension, extension reload, and browser restart discard
  credentials and pending attempts. Reauthorize from settings if that occurs.
  Keeping settings open polls status, but does not guarantee background lifetime.

OpenAI's credential guidance explicitly says to keep tokens out of browser
storage. This prototype therefore does not implement persistent credentials.
That does not establish that OpenAI endorses extension-only execution or DNR
callback interception. Persistent extension storage needs a separate decision
and clarification of OpenAI's guidance before implementation.

## Permissions and network access

Permissions are `storage` and `declarativeNetRequestWithHostAccess`. Host access
is limited to `127.0.0.1`, `auth.openai.com`, and `api.openai.com`. Match patterns
cannot limit a host grant to one port; the actual DNR rule restricts port/path/tab.
No `tabs`, cookies, webRequest, native messaging, or all-sites permission is used.
The existing mozilla.org starter content script remains independent of auth.

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
background context with temporary OAuth tokens. The wrapper limits response bytes
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
header in Firefox. It is not packaged or copied into source assets. Firefox is required
separately; `WEB_EXT_FIREFOX` can select its binary.

Automated mocks cover the PKCE RFC vector, new/returning registration parameters,
invalid/duplicate state, cancellation, wrong callback destinations/client IDs,
ID-token signature/nonce/audience/expiry failures, token rotation, expiration,
concurrent request rejection, failed exchange, mocked permission errors, callback
replay, wrong-tab/content-script access, logout during exchange, rule-installation
cancellation, and restart behavior. They do not prove OpenAI will accept the app.

Manual real-account checks still required:

1. Run `mise run dev`, open Scraper from the toolbar, and choose **Continue with
   ChatGPT**. Authorize the registered app and plan scopes. Confirm the callback
   stays in the extension and settings show the correct verified account.
2. Load models and send the fixed greeting. Confirm completion and check account
   usage. Test an account without plan consent or an exhausted allowance.
3. Cancel from OpenAI, close the login tab, cancel from settings, and retry.
4. Sign out and confirm the revocation status. Sign in using the saved registration.
5. Reload the extension/restart Firefox: account mappings remain, credentials do
   not, and stale callbacks fail safely. Reauthorize successfully.
6. Remove host permissions and verify a sanitized failure, then restore and retry.
7. Allow a real token to approach expiry and verify renewal; disconnect the app in
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
client ID, private endpoints, JWT decoding, and persistent token storage were not
adopted. This code is an independent implementation of the documented protocol
and browser APIs. The documented sign-in contract is distinct from the
experimentally verified Firefox redirect mechanism; the user has reported successful live login and an upstream greeting completed
response. Rendering through the updated SDK path still needs a real-account
recheck.
