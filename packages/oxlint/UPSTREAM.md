# Upstream

Rules copied from other MIT-licensed projects. Imports use `vite-plus/lint/plugins` instead of `@oxlint/plugins`.

| Files                                                                                            | Source                                                                                                                               |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Most rules in `src/rules/` and `src/shared/`                                                     | [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop)                                                                          |
| `no-array-filter-map`, `no-reduce-accumulator-copy`, `shared/array-method.ts`, `shared/scope.ts` | anti-slop, as installed in [anomalyco/opencode](https://github.com/anomalyco/opencode) `script/oxlint/anti-slop` at `a49f179`        |
| `no-low-value-comments`, `require-suppression-reason`                                            | [pingdotgg/t3code](https://github.com/pingdotgg/t3code) `oxlint-plugin-t3code` at `da7c4f23` (MIT, Copyright (c) 2026 T3 Tools Inc.) |
