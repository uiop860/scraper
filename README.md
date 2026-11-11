# Scraper

Firefox Manifest V3 extension with a sidebar chat for declarative JSON scraping, built with strict TypeScript and esbuild. It extracts rendered listing and detail pages locally, with an optional ChatGPT-powered agent that inspects pages, generates scraping JSON, tests it, and revises it using tool feedback.

## Setup

Install [mise](https://mise.jdx.dev/getting-started.html) and [Firefox](https://www.mozilla.org/firefox/), then run:

```sh
mise trust
mise install
mise run dev
```

mise manages pinned Node.js and Mozilla `web-ext` versions. Tasks automatically install project dependencies from `package-lock.json` when needed. Firefox is installed separately.

## Development

Edit source under `extension/`. The sidebar, account settings, and sign-in callback are React components written in TSX. The chat uses assistant-ui; settings remain a separate options tab. Firefox API types are available through the global `browser` object, with strict TypeScript checking enabled.

`mise run dev` runs the compiler, TypeScript checker, and Firefox together. Changes to TypeScript, the manifest, or static assets rebuild `build/`, and web-ext reloads the extension. Refresh the page to apply content script changes. Type errors appear in the terminal; lint and release builds fail on them. Press Ctrl+C to stop all processes.

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

For manual loading, run `mise run compile`, then select `build/manifest.json` in `about:debugging` → **This Firefox** → **Load Temporary Add-on**. Recompile and click **Reload** after edits. Temporary extensions are removed when Firefox closes. Content scripts cannot run on restricted sites such as `addons.mozilla.org`.

## Tasks

| Command              | Purpose                                                     |
| -------------------- | ----------------------------------------------------------- |
| `mise run install`   | Install locked project dependencies                         |
| `mise run dev`       | Watch sources, check types, and run Firefox                 |
| `mise run compile`   | Compile TypeScript and copy assets into `build/`            |
| `mise run typecheck` | Run strict TypeScript checking                              |
| `mise run lint`      | Check types, ESLint, Prettier formatting, and Mozilla rules |
| `mise run format`    | Apply Prettier formatting                                   |
| `mise run build`     | Run all checks and create an extension ZIP in `dist/`       |

ESLint checks JavaScript tooling and TypeScript extension code with recommended rules. Prettier handles formatting independently. Generated files and dependencies are excluded from both.

## Source

- `extension/content.ts`: isolated worker content script for rendered DOM extraction.
- `extension/scraper.tsx` and `extension/scraper/`: JSON scraping UI, schema, runtime, and navigation guard.
- `extension/background.ts` and `extension/auth/`: PIN-encrypted OAuth storage, refresh lifecycle, and authenticated requests.
- `extension/settings.html` and `extension/settings.tsx`: account and model-test UI.
- `extension/manifest.json`: metadata, permissions, and script URL matches. References compiled `.js` files.
- `extension/icons/`: static assets copied into the extension.
- `scripts/build.mjs`: esbuild compilation and source watcher. Add new script entry points here as needed.
- `tsconfig.json`: strict browser TypeScript configuration and Firefox API types.
- `eslint.config.mjs` and `.prettierrc.json`: lint and formatting rules.
- `mise.toml`: tool versions and tasks.

`build/`, `dist/`, and `node_modules/` are ignored by Git. Only compiled JavaScript, the manifest, and static assets are packaged. esbuild bundles modules into content-script-compatible code and does not type-check; the separate TypeScript check runs during development and before packaging.

The starter targets Firefox 142 or later. Before publishing, replace `scraper@example.com` with a unique add-on ID you control. Update the URL matches, description, permissions, and data collection declaration as functionality changes; this prototype declares authentication data collection and sends no scraped page data.

Builds are unsigned. Distribution through standard Firefox installations requires [Mozilla signing](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/). See Mozilla's [web-ext guide](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/) for more details.

## JSON scraping

Open a marketplace search tab and click the extension button to paste, validate,
and run a JSON scraping specification. Listing pagination and detail pages run
locally in a separate tab with exact-origin navigation limits. Download complete
or partial JSON results; no AI or sign-in is required for manual runs. To generate
the JSON, sign in, load models, describe the data you want, and use **Allow site
access and generate**. The agent inspects, tests and revises its specification. See [scraping documentation](docs/scraping.md)
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
replaced with `authenticationInfo`; no scraped page data is sent by this prototype.
