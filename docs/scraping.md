# JSON scraping (version 1)

Open a marketplace search in a regular Firefox tab and click **Scrape this page**.
Replace the example selectors, click **Validate JSON**, then **Allow site access
and run**. Firefox requests access to that site. Results appear as JSON and can
be downloaded, including partial results after cancellation or a failure. No
sign-in or AI request is involved. Account settings are linked from the scraper.

A separate worker tab loads listing and detail pages sequentially. Leave the
scraper UI open; closing or navigating away from it ends the run and closes its
worker. Closing the worker interrupts extraction. Runs do not resume after a
browser restart. Results are held in the UI's memory; download them before closing.

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
  or nested container itself. CSS cannot cross frame or shadow-root boundaries.
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
guards; it does not import authentication code. `extension/scraper.ts` owns the UI.

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
`stopReason`, timestamps, approved origin, starting URL, items, document visit
records and diagnostics. Each item has listing data, separate detail data and
source URLs. Visit records include requested/final URLs, page kind and success.
Diagnostics include code, URL, field path and selector/match count where relevant.
A completed traversal may still have field or detail warnings; inspect diagnostics.
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
scrolling, button-only pagination, recursive detail traversal, shadow DOM and
cross-origin frames are unsupported. Background tabs may receive throttled site
updates. This milestone does not claim compatibility with unverified DBA selectors.

## Later AI integration

The existing background-only OpenAI client and unlocked OAuth lifecycle can be
reused for generation without changing this interpreter. The next step is a
bounded page-structure inspector (repeated elements, safe attribute names, small
text samples and navigation links), excluding scripts, form values and unrelated
sensitive content. Show the outbound sample to the user before sending it.

Treat all page samples as untrusted data, explicitly separate them from model
instructions, and never give the generator tool execution or credentials. Prefer
schema-constrained Responses output if the selected account model supports it;
that capability needs live verification beyond the existing greeting test. Parse
and validate generated JSON locally, display it for review, and require the same
explicit run action and origin policy. Sending page data would also require
updating the extension's data-collection declaration and UI disclosure.

Future repairs, pagination strategies, template libraries, visual selection and
alternative syntax can target the same versioned internal contract. They are not
implemented in this milestone.

API references: [script injection](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript),
[optional host permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/optional_host_permissions),
[DNR permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest),
[background lifecycle](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts).

## DBA search example

On `www.dba.dk/recommerce/forsale/search`, the UI now prefills a current-page
listing example using `article.sf-search-ad`, `h2`, `div.font-bold > span` and
`a.sf-search-ad-link[href]`. These selectors matched 54 listings, titles, prices
and links during inspection on 2026-11-10. The earlier `.listing-card` example
matches no DBA listings. JSON validation checks syntax, not whether the current
website contains matching elements.

The DBA example intentionally covers the current listing page only. The inspected
page has no light-DOM `a[rel="next"]`, and its pagination uses a custom element.
Detail selectors and automatic DBA pagination still need site-specific support;
this example does not imply that those features have been verified on DBA.
