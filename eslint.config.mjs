import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "build/**",
      "dist/**",
      ".wxt/**",
      ".output/**",
      ".firefox-profile/**",
    ],
  },
  {
    files: ["**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.browser, browser: "readonly" },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: { "@typescript-eslint/no-deprecated": "error" },
  },
);
