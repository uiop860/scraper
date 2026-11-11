# JSON scraping (version 1)

Open a marketplace search in a regular Firefox tab and click **Scrape this page**.
The button opens a sidebar alongside the active page. Open **JSON scraper**, replace the example selectors, click **Validate JSON**, then **Allow site access
and run**. Firefox requests access to that site. Results appear as JSON and can
be downloaded, including partial results after cancellation or a failure. No
sign-in or AI request is involved in manual runs. **Settings** opens account settings in a separate tab.

A separate worker tab loads listing and detail pages sequentially. Leave the
sidebar open; closing it ends the run and closes its
worker. Closing the worker interrupts extraction. Runs do not resume after a
browser restart. Results are held in the UI's memory; download them before closing.

The sidebar follows the active tab and its URL between runs. During a run, the
source stays pinned to its starting page; **View agent’s tab** lets you watch
the worker navigate. Switching sites does not grant access or start AI requests.
The `tabs` permission lets the sidebar display the active page across site changes;
reading page content still requires optional site access.

## Generate JSON with an agent

Sign in and unlock your account in **Account settings**. In the scraper, click
**Load models**, select a model, describe the data to extract in the chat, then click
**Send**. Follow-up messages revise the current JSON. The chat uses assistant-ui’s
React primitives and connects to the existing background agent. This sends bounded rendered page samples and
extracted test data to OpenAI using your selected model. Firefox requests optional
website-content and browsing-activity sharing consent alongside site access;
the background checks consent before each model turn. Authentication tokens
stay in the background extension context.

The agent has three tools:

- `inspect_page` reads sanitized rendered HTML, with focused CSS selectors and
  navigation restricted to the starting origin. Scripts, form values, and editable
  content are excluded from inspection; page text is treated as untrusted data.
- `test_scraper` validates a candidate specification with the existing schema and
  runs the real extraction engine on the starting listing, the first item's detail
  page, and one next listing page when those features are configured. The agent
  receives row samples, counts, and selector diagnostics, and can revise and retry.
- `finish_scraper` accepts only the exact JSON that passed a test after inspection.
  Failed extraction, empty results, and required-field diagnostics prevent a pass.

A successful specification appears in the JSON editor, ready to review and run.
The conversation shows agent activity and test coverage. If no next-page link is found, pagination
is explicitly reported as unverified. A sample test does not verify every item or
page. Generation stops after 12 model turns, 24 tool calls, or five minutes;
**Cancel** interrupts it and closes the worker. Existing editor contents are
preserved if generation fails or is cancelled. Full scraping runs separately
through **Allow site access and run**.

## Specification

Selectors in this example are illustrative, not verified against DBA.dk:

```json
{
  "version": 1,
  "name": "Marketplace listings",
  "list": {
    "itemSelector": ".listing-card",
    "waitFor": { "selector": ".listing-card h2" },
    "fields": {
      "title": { "selector": "h2", "value": "text" },
      "price": { "selector": ".price", "value": "text", "optional": true },
      "url": {
        "selector": "a[href]",
        "value": "attribute",
        "attribute": "href",
        "resolveUrl": true
      },
      "seller": {
        "selector": ".seller",
        "fields": { "name": { "selector": ".name", "value": "text" } }
      }
    }
  },
  "detail": {
    "linkField": "url",
    "waitFor": { "selector": ".description" },
    "fields": {
      "description": { "selector": ".description", "value": "text" },
      "images": {
        "selector": ".gallery img",
        "value": "attribute",
        "attribute": "src",
        "resolveUrl": true,
        "multiple": true
      }
    }
  },
  "pagination": { "type": "next", "selector": "a[rel='next']" }
}
```

- `list` is required; `detail`, `pagination`, and `identityField` are optional.
- Field rules use either `value: "text"`, `value: "attribute"` with `attribute`,
  or nested `fields`. Unknown properties are rejected. Nested field rules can
  also use `multiple` and `optional`.
- Listing selectors are relative to the item, detail selectors to the document,
  and nested selectors to their matched container. Use `:scope` to read an item
  or nested container itself. Use `host >>> descendant` to enter an open shadow
  root, for example `podium-layout >>> [data-testid="description"]`. Each segment
  is ordinary CSS; up to eight segments and 200 hosts per boundary are supported.
  Inspection, extraction and readiness use the same selector syntax. Closed shadow
  roots and frames cannot be crossed.
- Text uses `textContent`, collapses whitespace and trims. It is not limited to
  visible text. Attribute values are returned literally unless `resolveUrl` is
  true; resolved URLs must be HTTP(S), without embedded credentials. URLs resolve
  against the actual document URL, ignoring a page's `<base>` element.
- Single rules take the first match. Missing singles become `null`; missing
  multiple rules become `[]`. Missing required elements or attributes generate
  diagnostics. `optional: true` suppresses those missing-value diagnostics.
- Detail `linkField` references a single listing attribute rule extracting a
  resolved `href`. Detail output is stored separately under each item's `detail`.
  Failed details preserve the listing data and record a diagnostic.
- `identityField` references a listing field and deduplicates by its JSON value.
  Without it, identity uses the permitted detail URL or extracted listing data.
  Choose a stable unique listing ID or URL when possible. Detail requests are
  cached per URL, including failures. Fragments are removed from navigation URLs;
  query strings are preserved because they may identify pages or listings.
- Next pagination reads the first matching element's `href`. Absence ends the
  run. Repeated listing pages stop with a cycle diagnostic. Redirect aliases are
  tracked too. Arbitrary clicks, forms and scripts are not part of the contract.

## Runtime and boundaries

`extension/scraper/spec.ts` owns the Zod schema, inferred types, parser and hard
limits. `dom.ts` handles extraction and bounded MutationObserver waits.
`runner.ts` owns traversal, deduplication, cancellation and results, using a small
page-driver interface so it can be tested without Firefox. `browser.ts` implements
that interface using tabs, bundled script injection and extension messaging.
`background.ts` inside the scraper directory owns worker lifecycle and navigation
guards; it does not import authentication code. `extension/entrypoints/scraper/main.tsx` owns the UI.

Every specification is validated before execution and again inside the content
script. There is no evaluation of generated code, main-world injection, webpage
message bridge or direct HTTP scraping API. Scraper messages cannot invoke the
account settings message handlers. The content script never receives tokens,
PINs, cookies or authentication objects. Authentication service origins are
excluded from scraping.

Allowed navigation is fixed to the source page's exact HTTP(S) origin, including
scheme and port, independently of the JSON. Optional host access is requested
for that site only. Firefox match patterns may grant broader port access than
this engine permits; URL checks and the navigation guard still enforce the exact
origin. Saved Firefox permission grants may persist after a run; revoke them in
Firefox's extension settings when desired.

Before any worker navigation, session DNR rules block main-frame network requests
except the exact approved origin. These also block off-origin HTTP redirects
before their destination is requested. This requires `declarativeNetRequest`,
replacing `declarativeNetRequestWithHostAccess`; the OAuth callback rule remains
separate. Worker ownership is recorded in extension session storage so background
event-page restarts retain cleanup information. Cleanup closes the tab before
removing its rules. Tab URL events also interrupt unexpected non-network URLs.

This is a navigation boundary, not a sandbox for website activity: the browser
loads the site's JavaScript, subresources and frames normally, and uses the
user's existing website session. Website scripts can perform their normal network
activity. The scraper itself makes no arbitrary fetch requests, reads no cookie
API and neither submits forms nor clicks controls. Visiting a URL still has normal
website effects; use read-only marketplace listing/detail URLs.

Hard ceilings, independent of JSON: 20 listing pages, 200 items, 220 document
visits, one detail-follow level, five minutes overall, 15 seconds for navigation
and 15 seconds for DOM readiness per document. Cancellation races pending browser
operations and closes the worker. Readiness requires a matching wait selector
(default: item selector on listings), followed by 400 ms without mutations inside the matched elements. Unrelated
page updates do not restart the wait.
Continuously mutating matched content times out. Timeout diagnostics distinguish
zero matches from matched content that never settled. Waiting cannot guarantee that every lazy
field has loaded; choose a specific readiness selector where necessary.

Specifications are limited to 64 KB, 100 fields total, five nested field levels,
500-character selectors and safe field names. Extraction caps matches at 200,
strings at 10,000 characters, nested extraction at 10,000 field operations and
item data at approximately 5 MB per run. Diagnostics are capped at 300. Expensive
CSS matching still executes synchronously in Firefox's content process; browser
responsiveness cannot be guaranteed for pathological pages/selectors.

## Results and diagnosis

Results contain `status` (`completed`, `limited`, `cancelled`, `failed`),
`stopReason`, timestamps, approved origin, starting URL and items. Each item has
listing data and separate detail data. The displayed and downloaded JSON excludes
`pages`, `diagnostics` and each item's `source`; visit tracking and extraction diagnostics
remain internal to the engine. A completed traversal may still have missing fields
or failed details.
No DOM dumps or persistent scraping logs are stored. Exports can contain private
page content and source URL query strings selected by your specification.

## Verification and limitations

Run `mise run test` for deterministic HTML extraction and fake-driver traversal
cases. Run `mise run test:scraper:firefox` for a temporary-profile headless Firefox
integration test against a local dynamic website: listing pagination, detail
navigation, exact-origin redirect blocking and cleanup. Its temporary extension
pregrants the fixture host; it does not test Firefox's interactive permission UI.
`mise run test:firefox` retains the separate authentication smoke checks.

Before relying on DBA.dk, manually verify:

1. Actual search/detail selectors and next-page links in the rendered DOM.
2. Permission approval, denial, revocation and restarting a run from the UI.
3. Cookie-consent overlays, signed-in pages and missing/removed listings.
4. Lazy images (`src`, `data-src`, `srcset`) and fields loaded after initial render.
5. Cancellation during listing loading and detail loading; closing the UI/worker.
6. Partial JSON download, duplicate listings and pagination loops.

Restricted Firefox/Mozilla pages cannot be scripted. Anti-bot challenges, infinite
scrolling, button-only pagination, recursive detail traversal, closed shadow roots
and cross-origin frames are unsupported. Background tabs may receive throttled site
updates. This milestone does not claim compatibility with unverified DBA selectors.

## Agent inspection

The inspector reports open shadow roots with selector prefixes, heading previews
and description-region hints. It does not execute page scripts or open closed
roots. The agent can inspect those regions with `>>>`, then use the same selectors
in its specification. Readiness observes queried shadow roots and detects delayed
root attachment. The activity log includes inspected URLs, selectors, match counts,
truncation, discovered shadow roots, tool errors and extraction-test results.

API references: [script injection](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript),
[optional host permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/optional_host_permissions),
[DNR permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest),
[background lifecycle](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts).

## DBA search example

On `www.dba.dk/recommerce/forsale/search`, the UI prefills a listing-and-detail
specification using `article.sf-search-ad`, `h2`, `div.font-bold > span` and
`a.sf-search-ad-link[href]`. These selectors matched 54 listings, titles, prices
and links during inspection on 2026-11-10. The earlier `.listing-card` example
matches no DBA listings. JSON validation checks syntax, not whether the current
website contains matching elements.

DBA item pages render their listing content inside `podium-layout`'s open shadow
root. The preset follows each listing's `url` and reads its full description with
`podium-layout >>> [data-testid="description"] .whitespace-pre-wrap`, waiting for
that element before extracting it. The selector was checked on a live item page;
synthetic tests cover multiple listings and delayed shadow content in Firefox.
Descriptions appear under each result item's `detail.description`.

Automatic DBA pagination is not preconfigured. Ask the agent to inspect and test
next-page links if the search spans multiple pages. The normal page, item, visit
and time limits still apply; the preset alone processes the current search page
and each of its permitted detail links.
