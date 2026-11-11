# Application state

The scraper and settings pages use **Zustand's vanilla store** (`zustand/vanilla`),
with a separate instance for each page. DOM subscriptions render state changes;
event handlers update state. No React runtime is required.

- `extension/state/scraper.ts` owns source metadata, the editor, validation,
  model selection, progress, logs, results, and operation status. Derived controls
  prevent overlapping model loading, scraping, and generation. Editing a spec
  invalidates its approval. Abort controllers stay in the page's lifecycle code.
- `extension/state/settings.ts` owns the public account snapshot, models, output,
  and pending UI actions. Status responses are projected onto explicit public
  fields. PINs, tokens, and encryption keys never enter these stores.
- Background operations remain authoritative. Settings refreshes the existing
  restricted `status` message every two seconds and after actions, in request
  order. The scraper uses the existing worker and agent message handlers.
  Importing a store into another context does **not** share its memory.

These stores are intentionally in memory. Scraped content, prompts, and logs
are discarded when their page closes. Credential persistence remains in the
existing encrypted IndexedDB vault and session cache; worker guards retain their
existing session storage. No storage migration or new permissions are required.
Subscriptions and timers are released on page shutdown.

## Why this choice

There is no universal best extension store. For this plain TypeScript app,
[Zustand's vanilla API](https://zustand.docs.pmnd.rs/apis/create-store) supplies
small, typed stores and subscriptions without changing the UI framework.
[webext-redux](https://github.com/tshaddix/webext-redux) adds a Redux background
store and messaging proxies, while
[webext-zustand](https://github.com/sinanbekar/webext-zustand) provides a similar
bridge for Zustand. Those bridges are useful when contexts need a shared store;
this app already has narrow, sender-checked background APIs, so it keeps them.

Zustand persistence alone does not synchronize extension contexts. If shared
preferences are added later, use browser storage and
[`storage.onChanged`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/onChanged)
or a deliberately scoped background API. Do not persist the whole UI store.

Run `mise run test` for state transitions, public account projection, operation
exclusion, and a DOM integration test covering validation, permission gestures,
and cancellation before worker creation, alongside the existing suite.
