# Changelog

All notable changes to LoopPilot are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The moving `v1` tag always points at the latest `v1.x.y` release; pin to `@v1`
for automatic patch/minor updates or to a full `@v1.x.y` (or a commit SHA) to
freeze. See [docs/operations/releasing.md](docs/operations/releasing.md).

## [Unreleased]

## [1.11.0] - 2026-07-06

### Added
- Opt-in escalated-tier auto-retry on `max_turns_exceeded` (`LOOPPILOT_AUTO_RETRY_ESCALATE`,
  default `false`). When enabled, a base-tier iteration that stops with
  `max_turns_exceeded` no longer waits for a manual `/restart-review`: post-fix
  re-requests `@codex review` and returns to `waiting_codex` preserving the stop
  reason, so the next pre-fix escalates the model tier automatically. One-shot —
  an escalated-tier attempt that also exceeds `--max-turns` stops as before — and
  a no-op when `CLAUDE_CODE_MODEL_BASE === CLAUDE_CODE_MODEL_ESCALATED`. A
  `🔁 LoopPilot auto-retry` comment records each automatic re-request; a failed
  re-request / missing Codex ACK degrades to `stopped/codex_request_failed` like
  the existing re-review path (ES-496).

## [1.10.2] - 2026-07-06

### Fixed
- Pre-fix no longer declares the loop `done` when a `pull_request_review`
  trigger comes from a duplicate or superseded Codex review whose reviewed
  `commit_id` is not the current HEAD, *and* that HEAD is LoopPilot's own
  just-pushed fix (so a fresh `@codex review` of HEAD is already pending). In
  that case the serialized run now skips (leaving `waiting_codex`) instead of
  prematurely marking `done` and swallowing the genuine HEAD re-review. The
  guard is deliberately narrow: it applies only to review triggers (Codex's
  clean verdict arrives as an `issue_comment` without a `commit_id` and still
  marks done), only when HEAD equals `lastClaudeCommitSha` (a benign external
  HEAD advance still marks done, avoiding a permanent `waiting_codex` strand),
  and it fails open when the review commit cannot be determined (ES-506).

## [1.10.1] - 2026-06-20

### Changed
- Rename all org references from `team-yubune` to `edereship` (ES-386).

## [1.10.0] - 2026-06-20

### Changed
- `show-full-output` default changed from `"true"` to `"false"`. Session logs
  are no longer printed to Actions output by default; set
  `LOOPPILOT_SHOW_FULL_OUTPUT=true` to opt in (ES-429).

## [1.9.1] - 2026-06-19

### Fixed
- Default model names changed from `claude-sonnet-4-6[1m]` /
  `claude-opus-4-6[1m]` to `claude-sonnet-4-6` / `claude-opus-4-6`. OAuth
  tokens without usage credits fail immediately with 1M-context models;
  standard context works out-of-the-box. Operators who want 1M context can
  set `CLAUDE_CODE_MODEL_BASE` / `CLAUDE_CODE_MODEL_ESCALATED` explicitly
  (#63).

## [1.9.0] - 2026-06-19

### Added
- `show-full-output` input (default `"true"`) wired through `loop.yml` →
  `loop/action.yml` → `claude-code-action@v1`'s `show_full_output`. Operators
  see the full Claude Code session log in Actions output by default, making
  authentication and runtime errors visible. Set
  `LOOPPILOT_SHOW_FULL_OUTPUT=false` to suppress (ES-428 / #61).

## [1.8.2] - 2026-06-19

### Fixed
- `/restart-review` Case A passed already-fixed (isOutdated) Codex findings to
  claude-code-action, causing `action_no_op` loops. Now
  `fetchUnresolvedCodexFindings` skips `isOutdated` threads and tracks
  `latestOutdatedAt` so the REST timestamp baseline advances past them
  (ES-420 / #58).
- Crash recovery (`demoteFixingOnCrash`) left stale
  `currentIterationFindingCommentIds` from the crashed iteration, causing
  `resolveFindingThreads` to incorrectly resolve un-fixed threads on the next
  `/restart-review` (ES-421 / #58).
- REST review-collector double-counted Codex thread replies as separate
  findings when they contained a severity badge. Now filters by
  `in_reply_to_id` in both `filterAndParseComments` and
  `countRelevantBotComments` (ES-422 / #58).
- `pr-merger` self-exclusion treated workflow runs with `path === undefined` as
  self-runs (fail-open), potentially hiding CI failures. Now treats undefined
  path as non-match (fail-closed) (ES-423 / #58).
- `state-comment-locker` `onConflict` callback exceptions masked the conflict
  signal (`return false`), routing the workflow into crash recovery instead of
  conflict handling. Now catches handler errors and preserves the signal
  (ES-424 / #58).
- `codex-status` usage-limit detection patterns were too narrow; Codex wording
  changes (rate limit, usage cap, limit exceeded) caused quota-exhaustion
  messages to be misclassified as `no_findings`. Broadened patterns and added a
  severity-badge guard to prevent false positives on review text. Updated
  workflow YAML trigger filter to admit the new substrings (ES-425 / #58).

## [1.8.1] - 2026-06-19

### Fixed
- OAuth-only deployments failed 100% of the time because LoopPilot passed
  `anthropic_api_key=""` to `claude-code-action@v1`, which set
  `ANTHROPIC_API_KEY=""` in the CLI process — the empty key won credential
  precedence over `CLAUDE_CODE_OAUTH_TOKEN` (ES-427 / #42). Credentials are
  now exported to `$GITHUB_ENV` only when non-empty, and cleared immediately
  after `claude-code-action` finishes. Note: the upstream action still
  unconditionally sets `ANTHROPIC_API_KEY` from its env block; the full fix
  requires an upstream change in `claude-code-action@v1`.

## [1.8.0] - 2026-06-15

### Changed
- Default Claude Code models now use the 1M-context (`[1m]`) tier (ES-419 / #40):
  - base: `claude-sonnet-4-6` → `claude-sonnet-4-6[1m]`
  - escalated: `claude-opus-4-7` → `claude-opus-4-6[1m]`
  The `[1m]` suffix is stripped by Claude Code before the provider call and
  enables 1M context with no long-context surcharge. Updates `src/config.ts`
  defaults, `loop/action.yml` / `loop/pre-fix/action.yml` input defaults, and
  the `.github/workflows/loop.yml` fallbacks. The config validator's example
  identifiers were aligned to the bracket `[1m]` form.

### Documentation
- Document the 2026-06-15 Anthropic billing change for subscription OAuth
  tokens (ES-418 / #40). `CLAUDE_CODE_OAUTH_TOKEN` now draws from the separate
  Agent SDK credit pool (billed at API rates, no roll-over) instead of the
  interactive subscription allowance; once exhausted, runs stop unless overflow
  usage is manually enabled. `README.md`, `README.ja.md`, and
  `docs/operations/security.md` now recommend `ANTHROPIC_API_KEY` for
  CI/automation, and the pre-fix OAuth runtime warning was reworded to match.

## [1.7.1] - 2026-06-14

### Fixed
- GraphQL `author.login` omits the `[bot]` suffix that the REST API includes,
  causing `fetchUnresolvedCodexFindings` to skip all Codex threads and Case A
  to never fire (ES-413 / #38). Now matches both forms.

## [1.7.0] - 2026-06-14

### Added
- `/restart-review` now checks for unresolved Codex review threads before
  requesting a new review (ES-413 / #36). If unresolved findings exist
  (Case A), they are repaired first via the composite action, then `@codex
  review` is posted. If none exist (Case B), the existing flow runs unchanged.
  Soft and hard restart modes both trigger the unresolved check.
- New module `src/unresolved-findings.ts` fetches unresolved Codex threads via
  paginated GraphQL with severity filtering, error handling, and 64-bit
  `fullDatabaseId` support.

### Changed
- Refactored `handleRestartCommand` into `validateRestartCommand`,
  `executeRestartWithCodexReview`, and `handleRestartWithRepair` for the
  Case A/B split. The monolithic wrapper is preserved for backward compatibility.
- Extracted `buildAndEmitRepairOutputs` helper in `main-pre-fix.ts` to
  deduplicate the prompt-building pipeline between Phase 3 and Case A.

## [1.6.1] - 2026-06-12

### Fixed
- Unified error comment prefix to `⚠️` across all stop/rejection comments
  (ES-398 / #34).

## [1.6.0] - 2026-06-11

### Added
- Auto-resolve Codex review threads after a successful repair (TY-360 / #32).
  When post-fix confirms that CHECK_COMMAND passed and the repair commit was
  pushed, it now resolves the PR review threads whose in-scope findings were
  fixed in the iteration. Only threads matching in-scope comment ids at or above
  the severity threshold are targeted; below-threshold / unparseable threads are
  left open. Best-effort: a resolve failure logs a warning and the loop
  continues. New module `src/review-thread-resolver.ts` with full test coverage.

## [1.5.1] - 2026-06-01

### Fixed
- Root `action.yml` description shortened to under 125 characters (TY-343). GitHub
  Marketplace rejects a description of 125+ chars at publish time (it is not
  validated at merge), which blocked publishing the v1.5.0 listing. Added a CI
  guard for the 125-char limit in `tests/marketplace-facade.test.ts`.

## [1.5.0] - 2026-06-01

GitHub Marketplace discoverability facade (TY-343 / #31). Adds a repository-root
`action.yml` so LoopPilot can be listed on the GitHub Marketplace, which lists
Actions/Apps only — not the `gh-looppilot` CLI extension or reusable workflows.
The listed action is an inert signpost (prints the `gh looppilot` install path and
exits 0), not the way to run LoopPilot. Touches the `@v1`-consumed surface with no
adopter-facing behavior change to the loop.

### Added
- Repository-root `action.yml` (TY-343): a GitHub Marketplace discoverability
  **facade**. LoopPilot is event-driven (reusable workflows), and Marketplace
  lists Actions/Apps only — so listing requires a real root action. This one is an
  inert signpost: run as a step it prints the `gh looppilot` install path and exits
  0. It does not change the canonical `loop@v1` / `init@v1` subpath actions or the
  reusable-workflow refs. Touches the `@v1`-consumed surface (no adopter-facing
  behavior change to the loop). The Marketplace listing `name` is "LoopPilot PR
  Review-Fix Loop" (not the bare "LoopPilot", which GitHub would reject because a
  `looppilot` user already exists).
- README.md / README.ja.md: GitHub Marketplace badge + a note that the listing is a
  discoverability front door, not the way to run LoopPilot (do not use the bare
  `uses: edereship/loop-pilot@v1` ref).
- `tests/marketplace-facade.test.ts`: CI guards that the root facade meets
  Marketplace listing requirements (name / description / branding) and stays an
  inert signpost (exit 0, no sub-action / `./` refs).
- `docs/operations/releasing.md`: root `action.yml` added to the documented
  `@v1`-consumed surface; notes it is intentionally excluded from the action-ref
  scan because it carries no `edereship/loop-pilot/...@v<major>` refs.

## [1.4.0] - 2026-05-31

Config-wiring audit follow-ups (#29). The end-to-end config chain was found
intact (TY-335/337/350 confirmed fixed); these close the remaining gaps and add
CI guards so the regression class cannot silently return. Touches the
`@v1`-consumed surface (no adopter-facing behavior change).

### Removed
- Dead `codex-review-marker` action input and `codexReviewMarker` config field
  (config-wiring audit, CW-1). The value was wired through every layer into
  `config.codexReviewMarker` but read by no entrypoint or helper; in-job Codex
  detection matches on `CODEX_BOT_LOGIN` (comment author), not marker text. The
  `CODEX_REVIEW_MARKER` Repository variable still works as the workflow trigger
  gate (`if:` in loop.yml), exactly as documented in event-design.md — so this
  is not an adopter-facing behavior change.

### Fixed
- `docs/operations/security.md` (CW-2): the nested-dotfile remediation no longer
  points operators at the removed `scope-additional-hard-block-prefixes` input
  (removed in v1.1.0, TY-350); it now recommends the live `LOOPPILOT_BLOCK_PATHS`.

### Added
- `CLAUDE_CODE_MAX_TURNS` documented in README.md / README.ja.md (F2 — it was
  wired and functional but undocumented).
- README.ja.md variable table brought to parity with README.md (CW-3):
  `LOOPPILOT_SCOPE_MAX_FILES` / `_LINES`, `CODEX_ACK_TIMEOUT_SECONDS`,
  `CODEX_ACK_MAX_REPOSTS`.
- `tests/config-wiring.test.ts`: matrix-completeness CI guards (no dead config
  field, composite forwards every operator input, docs never cite removed
  inputs, EN/JA README tables stay in sync) so the recurring config-wiring
  regression class (TY-335 / TY-337 / TY-350) fails CI going forward.

## [1.3.0] - 2026-05-31

Backfill of the PoC #137–#160 fix/security wave that the initial extraction
missed (epic TY-352). Every change touches the `@v1`-consumed surface.

### Security
- Block claude-code-action's `github_comment` / `github_inline_comment` base
  tools in the loop's `--disallowedTools`, so an IPI-influenced agent (running
  as `github-actions[bot]`, the trusted author of the hidden `looppilot-state`
  comment) cannot forge that state and corrupt loop accounting (TY-353).
- Hard-fail the secret scanner on the base64 `x-access-token:` credential that
  `actions/checkout` persists in `.git/config`, closing a `GITHUB_TOKEN` exfil
  path the raw-prefix patterns missed (TY-354).
- Add an in-action fork-PR backstop: pre-fix refuses to run when the PR head
  repo does not match the base repo, even if a consumer's workflow omits the
  "Check fork PR" guard (TY-358, PoC #160).

### Fixed
- Surface unparseable Codex review comments and withhold auto-merge on an
  uncertain "clean" result, so a Codex output-format drift cannot silently
  auto-merge a PR with un-triaged findings (TY-355).
- Bound `validateState` string fields (commit SHA, findings hashes, timestamps)
  and validate `stopReason` against its union, so a tampered/oversized hidden
  state cannot pass validation and exceed GitHub's 65,536-char comment limit
  (TY-356).
- Cap config tuning bounds (debounce, stabilize-interval, auto-merge poll &
  timeout) and validate the stabilization-window product (≤900 s) and the
  done-path budget (2×debounce + timeout ≤1500 s when auto-merge is enabled), so
  an oversized value can no longer wedge the loop past the 30-min job timeout
  (TY-357).
- Prevent a multi-byte (CJK) status-comment entry from wiping the entire
  history — the render now truncates an over-budget newest entry instead of
  dropping to zero entries (TY-358, PoC #148).
- Reject a soft `/restart-review` from a `max_iterations` stop and route it to
  `--hard`; give a `fixing`-state soft restart accurate `--hard` recovery
  guidance (TY-358 PoC #145, TY-359 PoC #142).
- Report `merge_sha_unsettled` instead of a contradictory empty-pending timeout
  when CI is green but GitHub has not settled a merge commit; `--hard` restart
  now also clears `previousCheckFailure` (TY-358, PoC #152).
- Gate the workflow's #2B crash notification on a healthy hidden state, so a
  job-timeout cancellation that lands after the loop committed its work no
  longer posts a misleading "crashed → `--hard`" notice (TY-358, PoC #147).
- Treat Codex's standard "automated review suggestions" summary as
  possibly-findings so the debounce is not silently skipped (TY-358, PoC #146).
- Forward `max-review-iterations` to post-fix so its status-comment **Iterations**
  header shows the operator-configured cap instead of the default 20 (TY-359,
  PoC #138).
- Harden post-fix against transient (non-412) API failures after a push, so a
  successful repair is no longer falsely reported as crashed or demoted to
  `codex_request_failed` (TY-359, PoC #151).
- Decode C-quoted `git ls-files --others` paths so untracked files with control
  characters in their names no longer trip a spurious scope violation (TY-359,
  PoC #142).
- Warn when `MAX_REVIEW_ITERATIONS` exceeds the findings-hash history cap, where
  long-cycle oscillation loops can no longer be detected (TY-359, PoC #158).
- Anchor the auto-merge-skip-notification dedup to the comment body start, so a
  comment that merely quotes the skip prefix no longer suppresses a fresh
  notification (TY-359, PoC #155).
- Second-truncate the `lastCodexReviewReceivedAt` fallback timestamp to match
  GitHub's second precision, avoiding lexicographic re-processing of an
  already-seen comment (TY-359, PoC #150).

## [1.2.0] - 2026-05-31

### Added
- In-job `@codex review` acknowledgement watchdog (TY-334, ported from the
  upstream PoC). After posting `@codex review`, init / post-fix / `/restart-review`
  now poll for Codex's 👀 reaction (or any new Codex activity) for up to
  `CODEX_ACK_TIMEOUT_SECONDS` (default 90, `0` disables) and re-request the
  review up to `CODEX_ACK_MAX_REPOSTS` times (default 2) before stopping with
  `codex_request_failed`. Previously, if Codex silently dropped the request (no
  reaction, no review), the loop wedged at `waiting_codex` indefinitely until an
  operator ran `/restart-review`. Reposts are authored by the request token (not
  the Codex bot) so they cannot self-trigger the loop; bounds keep
  `timeout × (reposts + 1)` under the job budget (the init job timeout is raised
  5 → 10 min). New tunables: `CODEX_ACK_TIMEOUT_SECONDS`,
  `CODEX_ACK_POLL_INTERVAL_SECONDS`, `CODEX_ACK_MAX_REPOSTS`.

## [1.1.0] - 2026-05-31

### Fixed
- The reusable `loop.yml` workflow now forwards the `LOOPPILOT_BLOCK_PATHS`,
  `LOOPPILOT_SCOPE_MAX_FILES`, and `LOOPPILOT_SCOPE_MAX_LINES` repository
  variables to the composite `loop` action. Previously these documented
  scope-policy variables were silently ignored — GitHub `vars.*` are not
  auto-exported to an action's process env, and the workflow never passed them
  as inputs — so custom block paths and size budgets had no effect and the
  `scope_violation` / `too_many_files` / `too_many_lines` stop-comment recovery
  hints pointed at variables that did nothing. The values are also forwarded to
  pre-fix so the repair prompt's `## Scope Policy` section reflects the
  operator's configuration. Built-in default block paths (`.github/` locked,
  `dist/`, `package.json`, …) and the default budgets were always enforced
  regardless, so this was a configuration/UX gap, not a protection bypass
  (TY-350).

### Removed
- The deprecated scope variables `LOOPPILOT_HARD_BLOCK_OVERRIDE`,
  `LOOPPILOT_SCOPE_ALLOWED_PATH_PREFIXES`, and
  `LOOPPILOT_SCOPE_ADDITIONAL_HARD_BLOCK_PREFIXES` (and their
  `looppilot-hard-block-override` / `scope-allowed-path-prefixes` /
  `scope-additional-hard-block-prefixes` action inputs) are removed, as
  announced in TY-271. They were never forwarded from `loop.yml` to the
  composite action, so they had no effect through `@v1` regardless. Migrate to
  `LOOPPILOT_BLOCK_PATHS` (use the `!path` syntax to un-block defaults); see
  [docs/operations/scope-policy.md](docs/operations/scope-policy.md).

## [1.0.0] - 2026-05-30

### Added
- First stable release. Distributes the `init` and `loop` composite actions as
  `edereship/loop-pilot/{init,loop}@v1`, plus the tag-driven release pipeline
  that keeps the moving `v1` tag and GitHub Releases in sync (TY-342).
