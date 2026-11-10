# Repository guidance

## Tools and tasks with mise

Use mise as the entry point for development tools and project tasks. `mise.toml`
defines pinned Node.js and Mozilla `web-ext` versions and is the source of truth
for task commands. Do not require globally installed Node.js, npm, or web-ext.

From the repository root, set up the environment with:

```sh
mise trust
mise install
mise run install
```

Firefox is a separate desktop application and is not installed by mise.
Tasks that need npm dependencies automatically run the `install` dependency when
`package.json` or `package-lock.json` changes.

| Command              | Use                                                               |
| -------------------- | ----------------------------------------------------------------- |
| `mise run dev`       | Watch source and assets, check types, and launch Firefox          |
| `mise run compile`   | Compile TypeScript and copy static assets into `build/`           |
| `mise run typecheck` | Run strict TypeScript checking without emitting files             |
| `mise run lint`      | Compile and check TypeScript, ESLint, Prettier, and Mozilla rules |
| `mise run format`    | Apply Prettier formatting                                         |
| `mise run build`     | Run all checks and package the extension into `dist/`             |

For commands without a task, use `mise exec -- <command>` so the pinned toolchain
is used. For example, add a development dependency with
`mise exec -- npm install --save-dev --save-exact <package>` and commit the updated
`package.json` and `package-lock.json` together. Define reusable workflows in
`mise.toml` rather than adding competing task runners.

## Source and validation

Write extension code in `extension/**/*.ts`; the current entry point is
`extension/content.ts`. Firefox API types are provided by
`@types/firefox-webext-browser`. Keep manifest script references as compiled `.js`
paths. Add new script entry points in `scripts/build.mjs` when needed.

Edit source files rather than generated output. `build/`, `dist/`, and
`node_modules/` are generated and must remain untracked.

Use ESLint for code rules and Prettier for formatting. Run `mise run lint` after
code or configuration changes; run `mise run build` when changing compilation,
the manifest, assets, or packaging. For documentation-only changes, checking the
changed Markdown files with `mise exec -- npm exec -- prettier <file> --check`
is sufficient. Project-local CLIs such as Prettier run through `npm exec`;
`mise exec` alone exposes the tools managed directly by mise.

The development task is long-running; stop it when finished. It reuses the ignored `.firefox-profile/` development profile and preserves
temporary-extension storage across restarts. Use this profile only for development. To select a Firefox binary, use
`WEB_EXT_FIREFOX=/path/to/firefox mise run dev`. If browser verification fails,
report the limitation separately from successful type, lint, or build checks.
