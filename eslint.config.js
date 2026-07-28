import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/", "tmp/"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.nodeBuiltin,
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "no-constant-binary-expression": "error",
      "no-duplicate-imports": "error",
      "no-promise-executor-return": "error",
    },
  },
];
