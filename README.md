# Scraper

Firefox Manifest V3 extension starter based on [MDN's first extension guide](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Your_first_WebExtension). Write TypeScript; esbuild bundles it into JavaScript for Firefox. The starter adds a red border to pages on `mozilla.org` and its subdomains.

## Setup

Install [mise](https://mise.jdx.dev/getting-started.html) and [Firefox](https://www.mozilla.org/firefox/), then run:

```sh
mise trust
mise install
mise run dev
```

mise manages pinned Node.js and Mozilla `web-ext` versions. Tasks automatically install project dependencies from `package-lock.json` when needed. Firefox is installed separately.

## Development

Edit `extension/content.ts`. Firefox API types are available through the global `browser` object, with strict TypeScript checking enabled.

`mise run dev` runs the compiler, TypeScript checker, and Firefox together. Changes to TypeScript, the manifest, or static assets rebuild `build/`, and web-ext reloads the extension. Refresh the page to apply content script changes. Type errors appear in the terminal; lint and release builds fail on them. Press Ctrl+C to stop all processes.

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

- `extension/content.ts`: content script entry point; import additional TypeScript modules here.
- `extension/background.ts` and `extension/auth/`: PIN-encrypted OAuth storage, refresh lifecycle, and authenticated requests.
- `extension/settings.html` and `extension/settings.ts`: account and model-test UI.
- `extension/manifest.json`: metadata, permissions, and script URL matches. References compiled `.js` files.
- `extension/icons/`: static assets copied into the extension.
- `scripts/build.mjs`: esbuild compilation and source watcher. Add new script entry points here as needed.
- `tsconfig.json`: strict browser TypeScript configuration and Firefox API types.
- `eslint.config.mjs` and `.prettierrc.json`: lint and formatting rules.
- `mise.toml`: tool versions and tasks.

`build/`, `dist/`, and `node_modules/` are ignored by Git. Only compiled JavaScript, the manifest, and static assets are packaged. esbuild bundles modules into content-script-compatible code and does not type-check; the separate TypeScript check runs during development and before packaging.

The starter targets Firefox 142 or later. Before publishing, replace `scraper@example.com` with a unique add-on ID you control. Update the URL matches, description, permissions, and data collection declaration as functionality changes; this prototype declares authentication data collection and sends no scraped page data.

Builds are unsigned. Distribution through standard Firefox installations requires [Mozilla signing](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/). See Mozilla's [web-ext guide](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/) for more details.

## Experimental ChatGPT authentication

Click the extension's toolbar button to open account settings. The browser-only
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
