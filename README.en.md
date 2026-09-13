**中文** · 🌏 [English](README.en.md)

<h1 align="center">dsh-session-reattach</h1>

<p align="center">
  <strong>Send ungrouped sessions back to the workspace their cwd belongs to</strong><br>
  Ownership bookkeeping only · session logs untouched · dry-run by default
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat" alt="Node.js 20 or newer">
  <img src="https://img.shields.io/badge/DSH-plugin-4D6BFE?style=flat" alt="DeepSeek Harness plugin">
  <img src="https://img.shields.io/badge/zero%20deps-0%20dependencies-2EA44F?style=flat" alt="Zero runtime dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
</p>

<p align="center">
  <a href="#features"><strong>Features</strong></a> ·
  <a href="#usage">Usage</a> ·
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#matching-rule">Matching rule</a> ·
  <a href="#security-boundaries-read-them-honestly">Security</a> ·
  <a href="#how-it-differs">Comparison</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="#development">Development</a>
</p>

---

> Once a session has been moved — or was created before its workspace existed — it can never return to a
> workspace group on its own; the sidebar only shows an "Ungrouped" bucket. This plugin supplies the missing
> entry point: drag the session into the workspace folder it belongs to.

## Name

**reattach**: not one byte of the session file changes; only the **ownership record** in `workspace.json` is corrected.
It is called "re-attach" rather than "move" because it **cannot move anything arbitrarily** — see
[matching rule](#matching-rule): DSH only accepts membership whose `cwd` equals the workspace directory, so this
plugin can send a session back to the directory it already belongs to, but not into a different one.

## Features

- **Fills a real DSH gap** — `Workspace.attachSession` is called only when a session/subagent is **created**; automatic adoption of history runs **exactly once** during `WorkspaceRegistry` init (once `initialized` is durable it never runs again); and every `@Remote(...)` endpoint is attach-free. So "session moved ⇒ permanently ungrouped" had no repair path. This plugin is that path.
- **Ownership only, never session files** — no filesystem writes at all; neither the session log (`session.jsonl.zstd`) nor the header `cwd` is touched. That is a different route from "rewrite the header `cwd` so the session hangs itself somewhere else".
- **DSH is the only write authority** — validation and persistence go through `Workspace.attachSession` / `detachSession`; the plugin decides nothing beyond path matching and never writes `workspace.json` itself.
- **Clean first, then attach** — before attaching, the plugin clears the session's stale slots from **every other** workspace. Not fastidiousness: `attachSession` does not cross-check other workspaces, and the registry's startup validation **throws and makes the whole workspace domain unusable** when one session is accounted twice. Getting the order wrong hits exactly that (proven by the audit).
- **Same canon** — session `cwd` and workspace `path` are both normalized through `fs.realpath` before comparison, so trailing slashes, `..`, symlinks and case differences cannot cause false matches. Results agree **case by case with the real `WorkspaceEntity`** (verified case by case by the audit).
- **Dry-run by default** — writes require an explicit `"dryRun": false` (or `apply` on the command); `"false"`, `0`, `null`, `[]` all stay dry-run.
- **Only the legal drop target lights up** — the moment a drag starts, the one workspace that can accept the session is computed (client-side pre-filter from `SessionSummary.cwd`) and only that group accepts the drop; every other group shows a not-allowed cursor. The hint is advisory — **the host remains authoritative**.
- **Fail closed** — a failed stale-slot cleanup aborts the attach (never risk dual ownership); a capped session list is **reported** ("N older sessions were not inspected") instead of pretending to be complete; if the sidebar structure changes upstream, drag and drop goes fully silent (does nothing rather than writing the wrong thing).
- **Zero runtime dependencies** — no DSH package is imported and no third-party package is installed; only `ctx` services are used. Plain JS, all platforms.

## Usage

| Entry point | What it does | How to trigger |
| --- | --- | --- |
| Drag and drop | Drag a session from "Ungrouped" into the workspace group it belongs to | Drag it in the sidebar; the cwd-matching group shows a dashed outline |
| `/reattach` | Report only: what would be attached, what cannot be and why | Type it in the composer — **never reaches the model** |
| `/reattach apply` | Perform the re-attach | Same |
| `/reattach apply subagents` | Include subagent sessions (skipped by default) | Same; tokens may appear in any order |

Dropping on any other group writes nothing (not-allowed cursor). If the session is not reattachable at all (dead `cwd`, no matching workspace, archived, …) the plugin does not guess: it lets the drop through so the host can return the exact reason, which the bottom-right toast displays.

`/reattach` is a pure host command: no tokens, no model judgement, and the fallback if drag and drop ever breaks.

A sample report (the classification wording and counts come from a **real dry-run** over 78 sessions and 10 workspaces):

```text
会话归位 · dry-run（未写入任何内容）

可归位 2 个：
• session-xxxx → 「team-manage」（/Users/me/Project/team-manage）
• session-yyyy → 「dsh-palimpsest」（/Users/me/Project/dsh-palimpsest）

无匹配工作区 1 个：
• session-zzzz：/Users/me/Downloads

cwd 无法校验 1 个：
• session-wwww：cwd 已失效（目录被移动、改名或不可访问）（/Users/me/old-project）

跳过：已归档 39 个、子代理会话 11 个
已归属、无需动作：26 个
```

## Install

### From npm / GitHub

```sh
dsh plugin --profile web add dsh-session-reattach
# or
dsh plugin --profile web add github:cnkids/dsh-session-reattach
```

### From a local path (development)

Run this inside the plugin checkout (`link:` keeps source edits live, no reinstall needed):

```sh
dsh plugin --profile web add "link:$(pwd)"
```

The command writes the dependency into the profile's `package.json` and appends every package declaring `dsh.bundle` to `dsh.profile.bundles`.

**A `dsh web` restart is required** — host plugins are assembled by the cordis loader at boot, this profile has no `patchReload: live`, and `hmr` ships `disabled: true` in `dsh-base`.

This plugin targets the **web profile**: the host half needs `webServer` and `connection` (the latter from `dsh-client-connection`'s host half). Without either, cordis parks the plugin on a missing dependency — a deliberate fail-closed choice that never leaves an unguarded write endpoint behind.

## Quick start

After the restart, first look at what would change (**this writes nothing**):

```text
/reattach
```

Then apply it once the list looks right:

```text
/reattach apply
```

Day to day, dragging is faster: expand "Ungrouped" in the sidebar, start dragging a session row, watch the **cwd-matching workspace group light up**, and drop it there — the toast reports the outcome and the sidebar refreshes.

## Matching rule

**match = `realpath(session header cwd) === workspace.path`**

`workspace.path` is already the result of `fs.realpath` (no trailing slash, no `..`, symlinks resolved), so both sides must go through realpath to be compared under one canon. These all **count as matches**: `/work/`, `/work/.`, `/work/sub/..`, symlinks to the same directory, and case differences on case-insensitive volumes.

Five mismatch causes, each with its own message:

| # | Cause | Classification |
| --- | --- | --- |
| 1 | Header carries no `cwd` | skipped: cannot validate |
| 2 | `cwd` is not absolute | skipped: not absolute |
| 3 | Directory deleted / renamed / unreachable | skipped: `cwd` no longer resolves |
| 4 | Path exists but is not a directory | skipped: not a directory |
| 5 | Resolves to a directory, but not this group's `path` | **wrong group**: name the workspace it can go to, or tell the user to create a workspace for that directory |

**Why no arbitrary migration**: DSH's `attachSession` rejects membership whose `cwd` differs from the workspace directory. That is the host's hard validation, not a limitation of this plugin — which is why a drop means "send it back to the folder it already belongs to".

## Security boundaries (read them honestly)

This is a channel that **writes workspace membership**, so the boundaries are spelled out instead of a blanket "it is safe":

1. **Request trust** — the route uses the **same** guard as `/api`: `Host` must be loopback or trusted, `Origin` when present must match the Host, `Sec-Fetch-Site: cross-site` is refused outright, and browser authentication follows. Unauthenticated, cross-origin, `Origin: null` and spoofed-Host requests were all measured at 401/403, and **rejection happens before the body is parsed** (audit probes against the live host).
2. **No writes by default** — only an explicit `"dryRun": false` persists anything; type confusion cannot flip the switch.
3. **Fail closed** — a failed stale-slot cleanup aborts the attach; the client never guesses a drop target from malformed state; a changed sidebar DOM silences drag and drop entirely.
4. **Least privilege** — only `attachSession` / `detachSession`; no file writes, no subprocesses, no network.

**Costs and things it cannot do**:

- **It mutates non-target workspaces**: re-attaching one session calls `detachSession` once per other workspace, and DSH's `mutate` then **durably prunes** that workspace's candidates whose *indexed* canonical cwd no longer matches the record. The prune criterion is a **durable fact** (header without cwd, or cwd resolving elsewhere), not "the directory is temporarily unreachable", so a briefly unmounted volume does not lose membership — and a pruned session is re-attached by this plugin once the directory is back. The alternative (no detach) leaves dual ownership and makes the next startup's `validateStoredState` throw.
- **It relies on the sidebar's structure**: the session-row anchor `[role="treeitem"][aria-selected]`, the workspace-group anchor `[role="treeitem"][aria-expanded][draggable="true"]`, and the built-in writing the session id into `dataTransfer`'s `text/plain` on dragstart. If upstream changes any of them, **drag and drop fails silently** (nothing found → nothing done); the `/reattach` command is unaffected.
- **Groups are matched by visible title** (DOM rows carry no workspace id). With duplicate titles the highlight may land on the same-named sibling — the host still rejects with "can only be re-attached to X", so the worst case is a clear error.
- **`/state` cost and caller co-tenancy**: each request does `realpath` + `stat` per session (~10 ms for 78 sessions here). The host deliberately has no cache (a cache would feed just-changed ownership into the write decision, turning a legitimate re-attach into a failure); callers must already be authenticated, and a same-origin script can already do far more expensive things through `/api`.

## How it differs

The usual take on this problem is a "session mover" (drag migration, bulk operations, trash, group merging). This plugin deliberately does **one thing**:

| | This plugin | Mover-style plugins |
| --- | --- | --- |
| Capability | **Re-attach only**: hang a session with a valid `cwd` back onto its matching workspace | Arbitrary cross-workspace migration, bulk, trash, groups |
| Session files | **Untouched** (header `cwd` never rewritten) | Often rewrite the header or relocate session directories |
| Allowed target | Only the workspace whose directory **equals** the `cwd` (host validation) | Plugin-defined, usually anything |
| Write surface | Two existing host APIs (`attachSession` / `detachSession`) | Own storage/index plus migration logic |
| Runtime dependencies | **Zero** (no DSH package imported) | Commonly direct dependencies on DSH internals |
| Security audit | Yes (8 PoCs: real sockets, the real `WorkspaceEntity`, live-host guard probes; artefacts are not shipped with the repo) | Not seen |

**Relationship to `dsh-palimpsest` (a common misdiagnosis)**: palimpsest's hard scope compares **session header `cwd` only**; its candidates come from `sessionQuery.listSessions()` (live + all persisted sessions) and **have nothing to do with workspace accounting**. So an "ungrouped" session is already readable by palimpsest as long as its `cwd` equals the calling session's `cwd` — this plugin fixes **sidebar grouping and workspace bookkeeping**, not palimpsest visibility. The two stay decoupled; neither needs changes for the other.

## FAQ

**Nothing happened after installing?** A `dsh web` restart is required (host plugins are assembled at boot). `/reattach` should then appear in the command palette.

**I cannot drag / dropping does nothing?** First check that the session's `cwd` directory **exists and is a directory**; sessions whose directory is gone only show up as "cwd no longer resolves" in the report. If **upstream changed the sidebar** and drag and drop broke as a whole, use `/reattach` (unaffected) and include your DSH version in the issue.

**What if I drop on the wrong group?** Nothing is written. cwd-mismatched groups refuse the drop; even if a duplicate title lets one through, the host rejects it and reports "can only be re-attached to X".

**Will it touch my sessions?** No. It only calls `attachSession` / `detachSession`; the log and the header `cwd` stay byte-for-byte intact.

**Why can't it move a session to another project?** Because DSH only accepts membership whose `cwd` equals the workspace directory. Changing projects means rewriting the header `cwd` (a different class of tool); this plugin deliberately never touches files.

**Should subagent sessions be re-attached?** They are skipped by default (nested under their parent, little benefit). Use `/reattach apply subagents` when you want them.

**Why are archived sessions skipped?** They are hidden in the sidebar anyway, and archiving **does not** remove the membership slot, so there is nothing to repair.

**What about a session with no matching workspace?** The plugin reports it and does not create one (its scope is re-attachment). Create or select a workspace for that directory in the sidebar, then re-attach.

**Does it slow down DSH startup?** No. There is no startup scan or index.

**Does it work offline?** Yes. No network, zero runtime dependencies.

**Why the name?** See [Name](#name).

## Development

```sh
npm test                       # 121 tests: pure logic + host assembly + real-socket HTTP + browser-half behaviour
npm run coverage               # same, plus coverage/lcov.infonode scripts/build-client.mjs  # regenerate after editing client-core.js / client-dom.js
```

Coverage (Node's built-in reporter): 99.60% lines, 99.13% functions, 96.24% branches.

**Always regenerate `lib/client.js` after editing `lib/client-core.js` or `scripts/client-dom.js`** — the drift check in `test/client.test.mjs` fails otherwise. The browser bundle must be a classic script (the built-in module system loads it via `<script src>`), so it can neither use ESM syntax nor be imported by Node; hence "pure module + generation".

**Security audit**: 8 standalone PoCs (real-socket 413/HTTP semantics, case-by-case comparison against the real `WorkspaceEntity`, and guard probes against a live host) are maintained outside this repository and **not shipped with it**; their conclusions are folded into "Security boundaries" above.

**SonarQube**:

```sh
npm run coverage        # produce coverage/lcov.info first, or coverage is empty
npm run sonar           # = ./scripts/sonar-check.sh, branch taken from git
npm run sonar -- main   # explicit branch
```

Tokens never enter the repository. The local convention is one variable per project in `~/.zshrc`:

```sh
export SONAR_TOKEN_DSH_SESSION_REATTACH=sqp_xxxxxxxx
```

`scripts/sonar-check.sh` prefers it and maps it to `SONAR_TOKEN`, falling back to the generic one; it also owns the branch and version (without `sonar.branch.name` results land on the SonarQube main branch).

**Layout**: `lib/core/` is DSH-free pure logic (path canon, plan, execute, render); `lib/host.js` is the only `ctx`-facing layer; `lib/http.js` and `lib/command.js` are the two entry points; `lib/index.js` is the plugin entry. The browser half is `lib/client-core.js` + `scripts/client-dom.js` (generating `lib/client.js`).

**HTTP contract** (for further development and diagnostics):

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/session-reattach/state` | Workspaces plus the reattachable→target mapping used for the client-side drop pre-filter |
| `POST` | `/session-reattach` | Body `{dryRun?, sessionId?, workspaceId?, includeSubagents?}`; omitting `dryRun` means dry-run |

`single.code` is one of `ok`, `already-accounted`, `cwd-invalid`, `no-workspace`, `workspace-mismatch`, `workspace-not-found`, `session-live`, `session-archived`, `session-subagent`, `session-not-found`; internal faults are always `internal-error` (details go to the host log only).

### Releasing (npm + GitHub Actions)

A `v*` tag is handled by `.github/workflows/release.yml`: tag↔version check → `npm ci` → `npm audit` → `npm test` → `npm publish --provenance` (**OIDC, no token secret at all**) → create the GitHub Release with the `.tgz` attached. Pushes to `main` and PRs run the same tests and audit through `ci.yml`.

**The very first publish must be done by hand** — npm has no pending publisher, so a package that does not exist yet **cannot be configured for trusted publishing** (you get a misleading `404 … is not in this registry`). The order is:

```sh
# 1. bootstrap locally (needs 2FA, or a granular token with bypass-2fa enabled)
npm login
npm publish --access public

# 2. on npmjs.com → package settings → Trusted Publisher → GitHub Actions:
#    Organization/user = cnkids   Repository = dsh-session-reattach
#    Workflow filename = release.yml
#    Environment = leave blank (the publish job declares none; both sides must match
#    or the OIDC claims do not line up)

# 3. push the repo and the tag; the first tag skips the npm step (same version already
#    exists) and still creates the Release
git remote add origin git@github.com:cnkids/dsh-session-reattach.git
git push -u origin main
git tag v0.1.1 && git push origin v0.1.1
```

From the **next** version onward trusted publishing takes over: bump `package.json`, sync the changelog here, commit, `git tag vX.Y.Z && git push origin vX.Y.Z`.

Three measured gotchas:

- **`npm ci` needs `package-lock.json`** — this package has zero dependencies, so the lockfile is tiny, but it must exist (`poc8` asserts it does).
- **Trusted publishing requires npm ≥ 11.5.1**, while Node 22 ships npm 10.x; with an older npm the publish fails with a **misleading 404**. The publish job therefore pins `npm install -g npm@11.5.1`.
- **The publish job declares no protected environment** (its approval gate can deadlock a release when GitHub is degraded), and the npm side's Environment field must be **blank** to match. OIDC short-lived credentials plus provenance carry the trust.

## Changelog

| Version | Changes |
| --- | --- |
| **0.1.1** | Security audit landed: an oversized body no longer kills the connection (413 is delivered), the route has an error boundary (host faults return a diagnosable JSON 500 instead of an empty 400), and a capped session list is reported honestly (no more false "nothing to re-attach"). Audited with 8 PoCs (real sockets, the real `WorkspaceEntity`, live-host guard probes; artefacts are not shipped with the repo); README restructured to match `dsh-palimpsest` and given security boundaries; tests 105 → 121 |
| **0.1.0** | First release: host-side re-attach core (realpath canon, five-way classification, detach-then-attach), HTTP route reusing the `/api` guard with dry-run by default, `/reattach [apply] [subagents]`, browser-half drag and drop (pre-filtered highlight + toast), zero runtime dependencies |

## License

[MIT](LICENSE)
