import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.venv/**", "sites/**", "apps/studio/vite.config.ts", "experiments/001-todo/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["scripts/**/*.mjs", "apps/cli/bin/*.js"], languageOptions: { globals: globals.node } },
  { files: ["apps/studio/src/**/*.{ts,tsx}"], languageOptions: { globals: globals.browser } },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error"
    }
  }
);
