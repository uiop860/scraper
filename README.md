# Scraper

Firefox Manifest V3 extension with a sidebar chat for declarative JSON scraping, built with WXT, React, and strict TypeScript. It extracts rendered listing and detail pages locally, with an optional ChatGPT-powered agent that inspects pages, generates scraping JSON, tests it, and revises it using tool feedback.

## Setup

Install [mise](https://mise.jdx.dev/getting-started.html) and [Firefox](https://www.mozilla.org/firefox/), then run:

```sh
mise trust
mise install
mise run install
mise run dev
```

mise manages pinned Node.js and Mozilla `web-ext` versions. Tasks automatically install project dependencies from `package-lock.json` when needed. Firefox is installed separately.

## Development

Edit source under `extension/`. WXT discovers entrypoints in `extension/entrypoints/`; extension pages use React through `@wxt-dev/module-react`, and the sidebar chat uses assistant-ui. Settings open in their own tab. Firefox API types are available through the global `browser` object, with strict TypeScript checking enabled.

`mise run dev` starts WXT in Firefox with React hot module replacement and extension reloads. WXT generates development output in `.output/firefox-mv3-dev/`. Run `mise run typecheck` for strict TypeScript checking; lint and release builds include it. Press Ctrl+C to stop WXT and its browser runner.

The dev task reuses a dedicated `.firefox-profile/` directory (ignored by Git),
so saved sign-in survives stopping and restarting `mise run dev`. It preserves
both extension storage and its internal origin when Firefox removes the temporary
add-on at shutdown. After restarting, enter your PIN; OAuth sign-in is only needed
again if credentials were reset, lost, or revoked. An earlier disposable profile's
login cannot be recovered automatically, so sign in once in this new profile.

Use this profile only for development: web-ext changes browser settings for
extension debugging. Close the development Firefox before starting dev again;
do not run two instances against this profile. To start fresh, close dev Firefox
and remove `.firefox-profile/`, which deletes its saved login and browser data.
See [Mozilla's persistence testing guide](https://extensionworkshop.com/documentation/develop/testing-persistent-and-restart-features/).

To select another Firefox binary, set `WEB_EXT_FIREFOX`:

```sh
WEB_EXT_FIREFOX=/path/to/firefox mise run dev
```

For manual loading, run `mise run compile`, then select `.output/firefox-mv3/manifest.json` in `about:debugging` → **This Firefox** → **Load Temporary Add-on**. Recompile and click **Reload** after edits. Temporary extensions are removed when Firefox closes. Content scripts cannot run on restricted sites such as `addons.mozilla.org`.

## Tasks

| Command              | Purpose                                                     |
| -------------------- | ----------------------------------------------------------- |
| `mise run install`   | Install locked project dependencies                         |
| `mise run dev`       | Run WXT with React hot reload in Firefox                    |
| `mise run compile`   | Build Firefox MV3 with WXT into `.output/firefox-mv3/`      |
| `mise run typecheck` | Run strict TypeScript checking                              |
| `mise run lint`      | Check types, ESLint, Prettier formatting, and Mozilla rules |
| `mise run format`    | Apply Prettier formatting                                   |
| `mise run build`     | Run all checks and create an extension ZIP in `.output/`    |

ESLint checks JavaScript tooling and TypeScript extension code with recommended rules. Prettier handles formatting independently. Generated files and dependencies are excluded from both. Mozilla manifest and validation errors fail lint; upstream React `innerHTML` and Zod dynamic-compiler warnings remain visible without failing the task. Application code renders page data as React text, and Zod JIT compilation is disabled for extension CSP compatibility.

## Source

- `extension/entrypoints/`: WXT background, on-demand worker script, and React pages (`settings`, `scraper`, and `callback`). Page URLs remain `settings.html`, `scraper.html`, and `callback.html`.
- `extension/content.ts`: isolated DOM extraction, registered by `scraper-worker.ts` and injected only after site access is granted.
- `extension/scraper/`: scraping schema, runtime, agent, and navigation guard.
- `extension/background.ts` and `extension/auth/`: PIN-encrypted OAuth storage, refresh lifecycle, and authenticated requests. Background listeners register synchronously in WXT's main callback.
- `wxt.config.ts`: React module, Firefox MV3 manifest metadata and permissions, browser runner, and persistent development profile.
- `public/icons/`: static assets copied unchanged by WXT.
- `tsconfig.json`: extends WXT's generated configuration with strict Firefox and React types.
- `eslint.config.mjs` and `.prettierrc.json`: lint and formatting rules.
- `mise.toml`: pinned tool versions and all development, validation, and packaging tasks.
- `tests/` and `scripts/*smoke.mjs`: unit and synthetic Firefox integration tests. esbuild is retained only for test harness bundles.

`.wxt/`, `.output/`, and `node_modules/` are generated and ignored by Git. WXT generates the manifest from configuration and discovered entrypoints. `mise run compile` builds an unpacked production extension; `mise run build` validates it and uses WXT to create an unsigned ZIP in `.output/`. WXT does not type-check while bundling; `mise run typecheck` and `mise run lint` perform that check.

The starter targets Firefox 142 or later. Before publishing, replace `scraper@example.com` with a unique add-on ID you control. Update the URL matches, description, permissions, and data collection declaration as functionality changes; this extension declares required authentication data collection and optional website content and browsing activity for AI generation. Manual scraping stays local.

Builds are unsigned. Distribution through standard Firefox installations requires [Mozilla signing](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/). See Mozilla's [web-ext guide](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/) for more details.

## JSON scraping

Open a marketplace search tab and click the extension button to open the sidebar, paste, validate,
and run a JSON scraping specification. Listing pagination and detail pages run
locally in a separate tab with exact-origin navigation limits. Download complete
or partial JSON results; no AI or sign-in is required for manual runs. To generate
the JSON, sign in, load models, describe the data you want in chat, and click **Send**. The agent inspects, tests and revises its specification. See [scraping documentation](docs/scraping.md)
for the contract, examples, security boundaries, tests, and limitations.

## Experimental ChatGPT authentication

Open **Account settings** from the scraper page or Firefox's extension options. The browser-only
prototype uses OpenAI's documented open-source OAuth flow and intercepts its
`127.0.0.1` callback inside Firefox; no local server is needed. Set a four-digit PIN on first use. Refresh credentials are saved encrypted in
IndexedDB; enter the PIN once per Firefox session to restore sign-in without
repeating OAuth. Access tokens and the unlocked key stay in memory/session storage.
A short PIN offers limited resistance to offline guessing. Private browsing is
disabled; logout removes all local authentication state.
The settings page can discover account models and send a fixed test greeting.
Live login and an upstream greeting response have been reported by the user;
rendering through the updated SDK path still needs a real-account recheck.

Run `mise run test` for mocked authentication tests and `mise run test:firefox`
for synthetic redirect and encrypted-storage checks in a temporary Firefox profile. See
[authentication notes](docs/authentication.md) for security boundaries, limitations,
and manual verification steps. The starter's earlier no-data declaration has been
replaced with required `authenticationInfo` and optional `websiteContent` and `browsingActivity`. AI generation sends page samples only after permission is granted; manual scraping stays local.

See [application state](docs/state.md) for the Zustand stores and extension context boundaries.
