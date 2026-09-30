import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["**/routeTree.gen.ts"],
  },
  lint: {
    ignorePatterns: ["**/dist/**", "**/routeTree.gen.ts", ".docs/**", "packages/oxlint/src/**"],
    jsPlugins: [{ name: "@project", specifier: "@dyad/oxlint" }],
    rules: {
      "@project/no-chained-type-assertions": "error",
      "@project/no-conditional-empty-object-spread": "error",
      "@project/no-explicit-return-types": "error",
      "@project/no-internal-export-all": "error",
      "@project/no-known-value-widening": "error",
      "@project/no-manual-tags": "error",
      "@project/no-module-mocking": "error",
      "@project/no-nested-ternaries": "error",
      "@project/no-object-parameters": "error",
      "@project/no-reflect-apply": "error",
      "@project/no-reflect-get": "error",
      "@project/no-runtime-typeof": "error",
      "@project/no-shape-in-symbol-names": "error",
      "@project/no-switch-statements": "error",
      "@project/no-unknown-parameters": "error",
      "@project/no-unknown-returns": "error",
      "@project/no-unknown-type-aliases": "error",
      "@project/no-unsafe-dictionary-type": "error",
      "@project/no-widen-then-assert": "error",
      "@project/require-safety-comment-for-type-assertion": "error",
      "@project/no-service-constructor-imports": "error",
      "@project/prefer-effect-fn": "error",
    },
  },
});
