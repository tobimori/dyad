# Dyad

Dyad is a local-first music library for local files, cloud files and streaming services. Server replicas (self-hosted server, later Electron) store the shared catalog and sync with each other. Clients (CLI first, then web, later mobile) connect to a server through Effect RPC. Almost every feature is a plugin.

Local design notes are in `.docs/`. Git ignores them, so they can be missing. Start with `architecture.md`, then `data-model.md`, `catalog-schema.md`, `plugins.md` and `dj-sets.md`.

## Taste

- Build only what the current task needs. Fight scope creep. Do not add machinery because it looks architecturally impressive.
- Understand the real constraint, then choose the smallest model that makes the correct behavior unsurprising. Do not keep complexity only because it already exists.
- Before you add code for an unlikely race, failure or security case, explain the failure, its likelihood and its cost, and get approval.
- Validate unknown input once, at the boundary that owns it, with Effect Schema. Pass typed values inward. Do not check again what a schema or type already guarantees.
- Do not extract a helper that is used once, unless it names a real concept or hides a complex boundary.
- Prefer inferred types. Use `const`, early returns and expressions instead of reassignment and `else`.
- Model values with Effect, not with `interface` or object `type` declarations. Use `Schema.Class` for data that crosses a boundary (wire, storage, config) and `Data.Class` or `Data.TaggedError` for values that code constructs. A parameter gets an inline type, or a plain argument if it is one value. `type X = typeof X.Type` stays for branded schemas.
- Use `interface` or `type` only when nothing else works, for example a library type that you must match. `no-shape-declarations` rejects them; suppress it on that line with the reason (`-- reason`).
- Match the style of the file that you change.
- If a rule here conflicts with the task, say so and get approval before you break it.

## Comments

- Default: no comment. Write one only when a maintainer would get the code wrong without it: a constraint, an external quirk or an invariant that the code cannot show.
- Keep it short: one line is the target, two is the limit. Cut words until it breaks.
- No file header notes. Put the reason next to the code that needs it.
- Do not restate the name, the type, an obvious unit or an obvious example (`/** Name to show */ name`). Do not narrate steps or record history.
- `/** */` directly above an exported declaration or a member of an exported type, so that it shows in editor hover. `//` everywhere else.
- One sentence: no period. Two or more sentences: periods.
- Write in Simplified Technical English. Put code names in backticks.
- Name the version in a comment about an external quirk, for example `Mediabunny 1.61.0`, so that it is clear when to remove the workaround.
- Do not link `.docs/` from code. Git ignores it. Put the reason that the code needs in the comment.
- `no-low-value-comments` rejects dividers, commented-out code, TODOs without an issue link and comments that repeat the name below them.

## Glossary

- **workspace**: one Dyad instance with its users, catalog and shared collections
- **replica**: one database of a workspace. Server replicas hold all catalog input; client replicas hold only canonical rows and user data.
- **assertion**: one field value of one entity from one origin. Canonical catalog rows are derived from assertions; nothing writes them directly.
- **source**: one playable item: a provider track, a local file or a DJ set
- **segment**: the time range of one track in a DJ set source
- **plugin**: a package in `plugins/` that registers features through `@dyad/plugin`

## Hit every surface

Before you call a change done, check which of these apply and say so:

- **Replicas**: two server replicas must converge. Data that other replicas need goes through assertions or CRDT operations, never through local state.
- **Clients**: CLI, web, and later Electron and mobile. Shared client code goes in `packages/client-runtime`. Contracts that cross the wire go in `packages/domain`.
- **Offline**: navigation and edits must not wait for the network.
- **Plugins**: a feature that a plugin can supply must not be hard-coded in the core.
- **Reverse states**: if you add a way in, add the way out. Import needs removal, link needs unlink.

## Ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f` or kill a PID that you found by name. Kill only a PID that you captured when you started the process.
2. **Using a real database for tests.** Start test servers with their own `DYAD_DATA_DIR` in `/tmp` and a free port.
3. **Storing credentials in shared data.** Provider credentials and CDM files never go into assertions, CRDT operations or logs.

## Code

- Use `vp` commands, not `pnpm`: `vp i`, `vp add`, `vp run <script>`. `pnpm` is only the package manager under Vite+.
- `vp run check` is the full check: format, lint, type check and builds. Run it before you commit.
- `packages/oxlint` has the project lint rules. Fix findings; do not suppress them. A suppression must say why (`-- reason`).
- The CLI follows the design language of opencode's TUI: theme tokens only, few borders, one accent, dim secondary text, key hints in the footer, centered dialogs. Effects may be bold, but text stays readable.
- `apps/cli` needs Node 26.9 or later (OpenTUI audio). Other packages must stay compatible with Node 24 and Electron.
- Plugins import `@dyad/plugin` and shared libraries, never `server-core` or `db`.
- Migrations: `vp run db:generate <descriptive_name>`, for example `add_source_segment`. Do not edit or rename a migration after it is committed, unless all databases are reset.
- Do not create or change tests unless asked.

## Worktrees

- `t3.json` runs `scripts/setup-worktree.ts` when T3 Code creates a worktree. It installs the locked dependencies and links `.docs/` from the main checkout.
- Each worktree has its own database in `.data/` and its own dev URLs: portless puts the branch name in front of `dyad` and `api.dyad`.
- `.env.local` files are not linked. They hold settings for the main checkout, such as its fixed server URL.

## Docs

- `.docs/` is local and never committed. It records decisions, their reasons and constraints that span packages. Before you add text, ask what a maintainer would get wrong without it.
- Do not describe what the code already shows. Do not add plans, research notes or change logs.
- When a decision changes, rewrite the affected text. Do not append a second version.
- Write docs in Simplified Technical English.

## Git

- No pull requests. Commit to `main` and push.
- Commit only when asked. One change per commit.
- Message: `scope: imperative description`, lowercase, no period. The scope is a package or area, for example `db: add source segments`.
