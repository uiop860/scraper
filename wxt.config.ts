import { resolve } from "node:path";
import { env } from "node:process";
import { defineConfig } from "wxt";
import { extensionDependencies } from "./scripts/extension-dependencies";

export default defineConfig({
  srcDir: "extension",
  modules: ["@wxt-dev/module-react"],
  imports: false,
  manifestVersion: 3,
  manifest: {
    name: "Scraper",
    description:
      "Extract structured data with JSON scrapers and an optional AI agent that generates, tests, and revises them.",
    icons: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "96": "icons/icon-96.png",
      "128": "icons/icon-128.png",
    },
    action: {
      default_icon: {
        "16": "icons/icon-16.png",
        "32": "icons/icon-32.png",
      },
      default_title: "Scrape this page",
    },
    browser_specific_settings: {
      gecko: {
        id: "scraper@example.com",
        strict_min_version: "142.0",
        data_collection_permissions: {
          required: ["authenticationInfo"],
          optional: ["websiteContent", "browsingActivity"],
        },
      },
    },
    options_ui: { page: "settings.html", open_in_tab: true },
    permissions: [
      "storage",
      "declarativeNetRequest",
      "scripting",
      "activeTab",
      "tabs",
    ],
    sidebar_action: {
      default_title: "Scraper",
      default_panel: "scraper.html",
      default_icon: "icons/icon-32.png",
      open_at_install: false,
    },
    host_permissions: [
      "http://127.0.0.1/*",
      "https://auth.openai.com/*",
      "https://api.openai.com/*",
    ],
    web_accessible_resources: [
      {
        resources: ["callback.html"],
        matches: ["http://127.0.0.1/*", "https://auth.openai.com/*"],
      },
    ],
    incognito: "not_allowed",
    optional_host_permissions: ["http://*/*", "https://*/*"],
  },
  vite: () => ({
    plugins: [extensionDependencies()],
    build: { target: "firefox142" },
  }),
  webExt: {
    binaries: env.WEB_EXT_FIREFOX ? { firefox: env.WEB_EXT_FIREFOX } : {},
    firefoxProfile: resolve(".firefox-profile"),
    keepProfileChanges: true,
    firefoxPref: {
      "extensions.webextensions.keepStorageOnUninstall": true,
      "extensions.webextensions.keepUuidOnUninstall": true,
    },
    startUrls: ["https://www.mozilla.org/en-US/"],
  },
});
