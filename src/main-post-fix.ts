import { readFileSync } from "node:fs";
import * as core from "@actions/core";
import {
  loadInitConfig,
  type BaseConfig,
} from "./config.js";
import { runIfNotVitest } from "./entrypoint.js";
import { demoteFixingOnCrash, rollbackFixingClaim } from "./crash-recovery.js";
import {
  readState as defaultReadState,
  updateStateComment as defaultUpdateStateComment,
} from "./state-manager.js";
import { createLockedStateUpdater } from "./state-comment-locker.js";
import { fetchPrLifecycle } from "./gh.js";
import * as git from "./git.js";
import { runCheckCommand as defaultRunCheckCommand } from "./check-runner.js";
import { runBuildCommand as defaultRunBuildCommand } from "./build-runner.js";
import {
  scanForSecrets,
  extractAddedContentFromUnifiedDiff,
  formatSecretLeakDetail,
  unquoteGitPath,
  type SecretScanResult,
  type SecretScanTarget,
} from "./secret-scanner.js";
import {
  parseGitNumstat,
  checkScope,
  checkScopeBuildMode,
  buildScopePolicy,
  parseBlockPathsSpec,
  type ChangedFile,
  type ScopeCheckResult,
  type ScopeCheckViolation,
} from "./scope-checker.js";
import {
  truncatePreviousCheckFailure,
} from "./claude-code-repair-request.js";
import {
  deriveIterationProgress,
  postComment as defaultPostComment,
  postClaudeCodeActionFixSummary as defaultPostClaudeCodeActionFixSummary,
  postCodexReviewRequest as defaultPostCodexReviewRequest,
  postStopComment as defaultPostStopComment,
  postTerminalNotification as defaultPostTerminalNotification,
  postTestFailureComment as defaultPostTestFailureComment,
} from "./comment-poster.js";
import { registerAllSecrets } from "./secrets.js";
import { resolveFindingThreads as defaultResolveFindingThreads } from "./review-thread-resolver.js";
import { ensureCodexAck } from "./codex-ack.js";
import type { CodexAckParams, CodexAckResult } from "./codex-ack.js";
import type { ReviewState, StopReason } from "./types.js";

/**
 * Inputs received from the composite action's pre-fix and claude-code-action
 * steps. The post-fix step always runs (`if: always()`) when pre-fix gated
 * `should_run=true`, so this includes the claude-code-action `outcome` /
 * `conclusion` for failure / timeout handling.
 */
export interface PostFixInputs {
  commentId: number;
  iteration: number;
  checkCommand: string;
  prHeadRef: string;
  triggerCommentId: number;
  /**
   * GitHub Actions step `outcome`: "success" | "failure" | "cancelled" |
   * "skipped". Set on the `claude-code-action@v1` step. We intentionally
   * accept the wider string type so the YAML can pass the raw expression.
   */
  actionOutcome: string;
  /**
   * Optional path to the claude-code-action execution output file. When
   * present and readable, post-fix inspects it to distinguish
   * `max_turns_exceeded` from generic `action_failure`.
   */
  actionExecutionFile: string;
}

export interface PostFixDeps {
  readState: typeof defaultReadState;
  updateStateComment: typeof defaultUpdateStateComment;
  runCheckCommand: typeof defaultRunCheckCommand;
  /**
   * Optional build step (TY-281). Invoked after CHECK_COMMAND succeeds and
   * before the auto-fix commit is staged. Skipped entirely when
   * `config.buildCommand` is empty so the post-fix path remains a no-op for
   * repos that do not commit build artifacts.
   */
  runBuildCommand: typeof defaultRunBuildCommand;
  postClaudeCodeActionFixSummary: typeof defaultPostClaudeCodeActionFixSummary;
  postCodexReviewRequest: typeof defaultPostCodexReviewRequest;
  /**
   * ES-496: posts a plain top-level PR comment. Used only for the
   * `🔁 LoopPilot auto-retry` audit comment that explains why an `@codex review`
   * was re-posted without a `/restart-review` (max_turns escalated retry).
   */
  postComment: typeof defaultPostComment;
  // TY-334: injected so tests can drive ACK / no-ACK without real polling.
  ensureCodexAck: (params: CodexAckParams) => Promise<CodexAckResult>;
  /**
   * TY-360: resolves the Codex review threads for the iteration's in-scope
   * findings after a successful repair commit/push. Best-effort — the impl
   * never throws — and injected so tests can assert it is called (and that a
   * failure does not stop the loop) without hitting the GraphQL API.
   */
  resolveFindingThreads: typeof defaultResolveFindingThreads;
  postStopComment: typeof defaultPostStopComment;
  postTestFailureComment: typeof defaultPostTestFailureComment;
  /**
   * Posts a new top-level ⚠️ / ✅ PR comment to restore GitHub
   * notifications on terminal events. `postStopComment` calls this internally,
   * but the `test_failure` branch uses `postTestFailureComment` (which only
   * edits the aggregated status comment) and must invoke this explicitly so
   * operators get a notification for CHECK_COMMAND failures too.
   */
  postTerminalNotification: typeof defaultPostTerminalNotification;
  setSecret: (secret: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
  error: (message: string) => void;
  /**
   * Marks the workflow step as `failure` (TY-297 #2). `core.error` alone only
   * adds an annotation; the step still ends in `success` so the
   * `looppilot-loop.yml` #2B fail-safe (which keys on
   * `steps.loop.conclusion == 'failure' || 'cancelled'`) does not fire and the
   * PR receives no top-level notification. Use this instead of a silent
   * `return` whenever post-fix cannot proceed and the operator must intervene,
   * so the workflow YAML fail-safe posts the ⚠️ comment.
   */
  setFailed: (message: string) => void;
  /**
   * Demotes a hidden `status: fixing` state to `stopped/workflow_crashed`
   * (TY-282), then best-effort posts the ⚠️ notification. No-op when the state
   * is not `fixing`. Injected (TY-310 #2) so the `!found` entry path can fire it
   * explicitly: that path exits via `setFailed + return` rather than throwing,
   * so `runIfNotVitest`'s `onError` — which is the only other caller — never
   * runs. Without this call a transient `readState` failure (or a misconfigured
   * `LOOPPILOT_STATE_COMMENT_AUTHORS` that makes the real comment invisible)
   * would leave the state `fixing` until pre-fix's 30-min stale detector, during
   * which the operator's `/restart-review` is silently skipped.
   */
  demoteFixingOnCrash: typeof demoteFixingOnCrash;
  /**
   * Returns numstat output (stdout) for `git diff --numstat --no-renames HEAD`.
   *
   * `--no-renames` is mandatory: without it git emits compact rename notation
   * (`src/{a.ts => b.ts}`) that is not a real filesystem path and would crash
   * subsequent `git add -- <path>` calls in `stagePaths`.
   */
  gitDiffNumstat: () => string;
  /**
   * Returns the unified diff (`git diff --unified=0 --no-renames --no-color HEAD`)
   * used by the TY-274 secret-scanner to extract added-only lines. Untracked
   * files do not appear here — those are read in full via `readWorkingTreeFile`.
   */
  gitDiffHead: () => string;
  /** Lists untracked file paths from the working tree (one per line). */
  gitListUntracked: () => string;
  /**
   * Reads a working-tree file. Used to count lines for synthesized numstat
   * entries of untracked files. Returns null on read failure (binary, missing,
   * or permission error); the caller treats null as a binary entry.
   */
  readWorkingTreeFile: (path: string) => string | null;
  /** Capture HEAD sha for logging. Returns "" on failure. */
  readHeadSha: () => string;
  /**
   * Reverts the working tree to HEAD AND removes untracked files / dirs.
   * Used on scope_violation, action_failure, and CHECK failure paths so that
   * new files written by claude-code-action are also cleaned up (a plain
   * `git reset --hard HEAD` only touches tracked paths).
   */
  resetWorkingTree: () => void;
  /** Stages the given paths. */
  stagePaths: (paths: string[]) => void;
  /**
   * Adds the given paths to the index as intent-to-add (zero-content entries)
   * so subsequent `gitDiffHead` calls treat previously-untracked files as
   * add-side endpoints and git's rename detection can pair low-similarity
   * renames with their tracked-side deletions (TY-287 #2 follow-up).
   */
  intentToAdd: (paths: string[]) => void;
  /**
   * Inverse of `intentToAdd`: drops intent-to-add entries from the index so
   * the post-scan flow's `stagePaths` does not surface stale index state.
   * No-op for already-clean paths.
   */
  resetIntentToAdd: (paths: string[]) => void;
  /** Returns true if the index has staged changes. */
  hasStagedChanges: () => boolean;
  /** Creates a commit with the supplied message. */
  commit: (message: string) => void;
  /** Pushes HEAD to the given branch on github.com/<owner>/<repo>.git, optionally using a push token. */
  push: (owner: string, repo: string, ref: string, token: string) => void;
  /** Reads the file at `path` as utf-8. Returns null on failure. */
  readActionExecutionFile: (path: string) => string | null;
  /**
   * ES-426 #5: reads the PR lifecycle state (`state` / `draft` / `merged`) so
   * post-fix can discard the repair and pause instead of committing / pushing /
   * re-requesting review on a PR that was closed / merged / drafted during the
   * claude-code-action run.
   */
  fetchPrLifecycle: (
    owner: string,
    repo: string,
    pr: number,
    token: string,
  ) => Promise<{ state: string; draft: boolean; merged: boolean }>;
}

const defaultDeps: PostFixDeps = {
  readState: defaultReadState,
  updateStateComment: defaultUpdateStateComment,
  runCheckCommand: defaultRunCheckCommand,
  runBuildCommand: defaultRunBuildCommand,
  postClaudeCodeActionFixSummary: defaultPostClaudeCodeActionFixSummary,
  postCodexReviewRequest: defaultPostCodexReviewRequest,
  postComment: defaultPostComment,
  ensureCodexAck: (params) => ensureCodexAck(params),
  resolveFindingThreads: defaultResolveFindingThreads,
  postStopComment: defaultPostStopComment,
  postTestFailureComment: defaultPostTestFailureComment,
  postTerminalNotification: defaultPostTerminalNotification,
  setSecret: (secret) => core.setSecret(secret),
  info: (message) => core.info(message),
  warning: (message) => core.warning(message),
  error: (message) => core.error(message),
  setFailed: (message) => core.setFailed(message),
  demoteFixingOnCrash,
  gitDiffNumstat: git.gitDiffNumstat,
  gitDiffHead: git.gitDiffHead,
  gitListUntracked: git.gitListUntracked,
  readWorkingTreeFile: git.readWorkingTreeFile,
  readHeadSha: () => git.readHeadSha("post-fix"),
  resetWorkingTree: git.resetWorkingTree,
  stagePaths: git.stagePaths,
  intentToAdd: git.intentToAdd,
  resetIntentToAdd: git.resetIntentToAdd,
  hasStagedChanges: git.hasStagedChanges,
  commit: git.commit,
  push: git.pushWithToken,
  readActionExecutionFile: (path) => {
    if (!path) return null;
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  },
  fetchPrLifecycle: (owner, repo, pr, token) =>
    fetchPrLifecycle(owner, repo, pr, token),
};

/**
 * Count added lines for an untracked file the way `git diff --numstat` counts a
 * brand-new tracked file. TY-326 #2 (BUG-04): `split("\n").length` over-counts
 * by one for the common trailing-newline file (`"a\nb\n"` → `["a","b",""]` → 3,
 * but git reports 2 additions). Tracked files already use git's real count via
 * `parseGitNumstat`, so without this the scope `maxLines` budget was applied
 * asymmetrically to untracked (claude-authored) files.
 */
export function countUntrackedAddedLines(content: string): number {
  if (content === "") return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

/**
 * Decode a `git ls-files --others` output line into a real filesystem path.
 *
 * With `-c core.quotepath=false` (set in `git.ts:gitListUntracked`), non-ASCII
 * bytes are emitted raw, but paths containing control characters (tab,
 * newline, embedded quote, backslash) are still C-quoted and wrapped in
 * double quotes — `git` quotes those regardless of `core.quotepath`. Passing
 * the quoted literal straight to `readWorkingTreeFile` / `git add` yields
 * ENOENT, so the untracked entry gets marked binary (`added: -1`) and the loop
 * stops on a spurious `scope_violation`.
 *
 * `parseGitNumstat` already unquotes the same shape on the tracked side
 * (TY-306 #2); this keeps the untracked builders — which feed the *same*
 * scope check, secret scan, and `git add` — symmetric. A no-op for ordinary
 * unquoted paths.
 */
export function decodeLsFilesPath(line: string): string {
  return line.length >= 2 && line.startsWith('"') && line.endsWith('"')
    ? unquoteGitPath(line.slice(1, -1))
    : line;
}

function readPostFixInputs(): PostFixInputs {
  const commentId = parseInt(core.getInput("comment-id"), 10);
  const iteration = parseInt(core.getInput("iteration"), 10);
  const triggerCommentId = parseInt(core.getInput("trigger-comment-id") || "0", 10);
  if (!Number.isFinite(commentId) || commentId <= 0) {
    throw new Error(`[post-fix] Invalid input comment-id: ${core.getInput("comment-id")}`);
  }
  if (!Number.isFinite(iteration) || iteration <= 0) {
    throw new Error(`[post-fix] Invalid input iteration: ${core.getInput("iteration")}`);
  }
  return {
    commentId,
    iteration,
    triggerCommentId: Number.isFinite(triggerCommentId) ? triggerCommentId : 0,
    checkCommand: core.getInput("check-command") || "npm run check",
    prHeadRef: core.getInput("pr-head-ref"),
    actionOutcome: core.getInput("action-outcome") || "success",
    actionExecutionFile: core.getInput("action-execution-file") || "",
  };
}

/**
 * Determine whether a non-success claude-code-action outcome was caused by the
 * configured `--max-turns` budget being exhausted. Returns false when the
 * execution file is missing / unreadable / does not indicate a limit hit.
 *
 * The execution file is claude-code-action's structured log: a JSON array of
 * Claude Agent SDK messages written via `JSON.stringify(messages, null, 2)`
 * (base-action/src/run-claude-sdk.ts). The terminal `{ type: "result" }`
 * message carries a `subtype` that is exactly one of `success` /
 * `error_max_turns` / `error_during_execution`, so a real limit hit is
 * `subtype === "error_max_turns"` — authoritative, and distinct from the
 * `--max-turns N` config echo that surfaces as `"max_turns": N` in every run.
 *
 * TY-324: the previous heuristic returned true on any `includes("max_turns")`,
 * which also matched that config echo (plus log / doc lines), so EVERY
 * `outcome=failure` was misclassified as `max_turns_exceeded`. That is not a
 * cosmetic label error: TY-258 carries `max_turns_exceeded` across
 * `/restart-review` as a one-shot escalation signal that forces the next
 * iteration's `selectModel` (via `previousMaxTurnsExceeded`) onto the escalated
 * (Opus) tier. Misclassifying a transient infra / tool failure therefore burned
 * an unnecessary Opus iteration on resume. Keying off the structured stop
 * reason removes that secondary cost; the textual scan is only a fallback for
 * non-JSON execution files and is verb-anchored so the config echo never trips.
 */
function detectMaxTurnsExceeded(executionFileContents: string | null): boolean {
  if (executionFileContents === null) return false;

  // 1) Structured result subtype — authoritative when the file is valid JSON.
  try {
    const parsed: unknown = JSON.parse(executionFileContents);
    const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "result"
      ) {
        const subtype = (message as { subtype?: unknown }).subtype;
        // A result message with a string subtype is decisive: only
        // `error_max_turns` is a budget exhaustion. Any other subtype
        // (e.g. `error_during_execution`) is a generic action_failure.
        if (typeof subtype === "string") {
          return subtype === "error_max_turns";
        }
      }
    }
    // Valid JSON but no result message with a string subtype: fall through to
    // the textual heuristic rather than silently returning false.
  } catch {
    // Not JSON (e.g. a plain stderr dump) — fall through to the text heuristic.
  }

  // 2) Human-readable fallback: require a verb that denotes hitting the limit
  //    adjacent (same line) to the "turns" noun, so the bare `"max_turns": N`
  //    config echo — which has no such verb — does not match.
  const haystack = executionFileContents.toLowerCase();
  return /\b(?:reach(?:ed|ing)?|exceed(?:ed|ing|s)?|exhaust(?:ed|ing|s)?|hit)\b[^\n.]*\b(?:max[ _-]?turns|maximum turns)\b/.test(
    haystack,
  );
}

const SCOPE_POLICY_DOC = "docs/operations/scope-policy.md";

/**
 * Compose an actionable `Detail:` body for the stop comment when the post-fix
 * scope check rejects a diff (TY-271).
 *
 * Each violation reason maps to a different remediation: hard-block paths get
 * a copy-pasteable `LOOPPILOT_BLOCK_PATHS=!<path>` snippet; budget overruns
 * point at `LOOPPILOT_SCOPE_MAX_*`; binary changes are flagged as outside
 * the auto-fix surface; path traversal is reported as a security refusal with
 * no override path.
 */
/**
 * Build the scan-input list for the TY-274 secret-scanner.
 *
 * Tracked files: extracted from a unified diff so only the agent's added
 * lines are scanned (avoids self-matching the scanner's own regex literals
 * and test fixtures, which live in HEAD and therefore do not appear as
 * additions). Untracked files: read in full because the entire body is new.
 */
function buildSecretScanTargets(args: {
  diff: string;
  untrackedFiles: readonly string[];
  readFile: (path: string) => string | null;
}): SecretScanTarget[] {
  const targets = extractAddedContentFromUnifiedDiff(args.diff);
  for (const path of args.untrackedFiles) {
    const content = args.readFile(path);
    if (content === null || content.length === 0) continue;
    targets.push({ path, content });
  }
  return targets;
}

/**
 * Run a single secret-scan pass with the untracked working-tree files
 * temporarily promoted to intent-to-add so `git diff HEAD` (with rename
 * detection enabled by `--find-renames=20%` in `gitDiffHead`) can pair
 * low-similarity renames with their tracked-side deletions (TY-287 #2
 * follow-up to Codex P2 r3263061946).
 *
 * Without intent-to-add, the post-fix flow scans untracked files in full
 * via `readWorkingTreeFile`, so any pre-existing secret-shape fixture
 * content in a moved file re-appears as a fresh leak and hard-fails the
 * scanner. With intent-to-add, the destination is visible to `git diff
 * HEAD` and git pairs it with the deleted source — only the actually
 * changed lines are surfaced as additions. The `finally` block restores
 * the empty index even when `gitDiffHead` / `scanForSecrets` throws, so
 * the subsequent `stagePaths` flow does not see stale entries.
 */
function scanWithIntentToAdd(args: {
  untrackedPaths: readonly string[];
  deps: {
    intentToAdd: (paths: string[]) => void;
    resetIntentToAdd: (paths: string[]) => void;
    gitDiffHead: () => string;
    readWorkingTreeFile: (path: string) => string | null;
    warning: (message: string) => void;
  };
}): SecretScanResult {
  const paths = [...args.untrackedPaths];
  // TY-306 #1: `intentToAdd` is inside the `try` so that a partway failure
  // (e.g. `git add --intent-to-add` throws on the second of N paths) still
  // hits the `finally` that calls `resetIntentToAdd`, which leaves no stale
  // index entries behind. Previously the call sat outside the `try`, so a
  // throw skipped the cleanup and propagated up to `demoteFixingOnCrash` —
  // operator saw `workflow_crashed` instead of a `failureExit` carrying the
  // real reason. `resetIntentToAdd` is a no-op on paths that were never
  // staged, so feeding it the full list (including ones that failed) is safe.
  try {
    args.deps.intentToAdd(paths);
    const targets = buildSecretScanTargets({
      diff: args.deps.gitDiffHead(),
      // Intent-to-add promotes the untracked list into the diff, so we
      // intentionally pass [] here — feeding the same paths back through
      // the readFile path would double-count and (worse) re-introduce the
      // full-content scan that this whole helper exists to avoid.
      untrackedFiles: [],
      readFile: (p) => args.deps.readWorkingTreeFile(p),
    });
    return scanForSecrets(targets);
  } finally {
    try {
      args.deps.resetIntentToAdd(paths);
    } catch (resetError) {
      args.deps.warning(
        `[post-fix] Could not reset intent-to-add after secret scan: ${
          resetError instanceof Error ? resetError.message : String(resetError)
        }`,
      );
    }
  }
}

/**
 * Paths whose WARN findings are suppressed from the workflow log (TY-298 #2).
 * These locations hold high-entropy strings as a matter of normal repository
 * hygiene — npm integrity hashes, build bundles, vitest / jest snapshots,
 * compiled binary lockfiles — so the `high-entropy-long-string` pattern
 * matches them aggressively and floods the log with hundreds of WARN lines
 * per run. Hard-fail findings under the same paths are still logged via
 * `deps.error`; only the warning-only stream is suppressed.
 */
export const SECRET_WARN_PATH_SUPPRESS_RE =
  /(?:(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock)$|^dist\/|\.snap$|\.lockb?$)/i;

/**
 * Per-pattern upper bound on individually emitted WARN lines. Once exceeded
 * for one pattern, additional WARN findings of that same pattern are folded
 * into the summary line. Other patterns continue to log up to their own cap.
 *
 * TY-304: previously a single shared counter capped at this value, so a
 * noisy pattern like `high-entropy-long-string` could exhaust the budget
 * with 20 false positives and silently push out the first
 * `credential-assignment` line — defeating the "WARN observation → HARD
 * promote" design intent for low-FP patterns. Pre-pattern accounting keeps
 * the low-FP pattern observable even when a noisy pattern saturates.
 *
 * Aliased as `SECRET_WARN_LOG_CAP` for legacy callers / tests.
 */
export const SECRET_WARN_LOG_CAP_PER_PATTERN = 20;
export const SECRET_WARN_LOG_CAP = SECRET_WARN_LOG_CAP_PER_PATTERN;

/**
 * Emit `core.info` lines for warning-tier secret-scan findings.
 *
 * The matched value is never logged — pattern name + path only — so the
 * workflow log itself cannot become a secret-leak vector.
 *
 * TY-298 #2: WARN findings on hash-bearing paths (`SECRET_WARN_PATH_SUPPRESS_RE`)
 * are suppressed and the emitted volume is capped so the log cannot grow
 * unboundedly on PRs that touch many high-entropy files.
 *
 * TY-304: the cap is now **per-pattern** (`SECRET_WARN_LOG_CAP_PER_PATTERN`)
 * rather than a single shared counter. A high-FP pattern like
 * `high-entropy-long-string` saturating its own 20-line budget no longer
 * pushes out a low-FP pattern like `credential-assignment`, which preserves
 * the "observe WARN volume → promote to hard-fail" track record the design
 * intent (`src/secret-scanner.ts:36-46`) relies on. The summary line lists
 * which patterns hit their cap so operators can spot saturation per-pattern.
 *
 * Hard-fail findings are logged separately by the caller via `deps.error`
 * and are unaffected.
 */
export function logSecretScanWarnings(
  result: SecretScanResult,
  stage: "pre-check" | "pre-commit",
  deps: { info: (msg: string) => void },
): void {
  let suppressedByPath = 0;
  let cappedOver = 0;
  let totalLogged = 0;
  const loggedByPattern = new Map<string, number>();
  for (const w of result.warnings) {
    if (SECRET_WARN_PATH_SUPPRESS_RE.test(w.path)) {
      suppressedByPath += 1;
      continue;
    }
    const loggedSoFar = loggedByPattern.get(w.pattern) ?? 0;
    if (loggedSoFar >= SECRET_WARN_LOG_CAP_PER_PATTERN) {
      cappedOver += 1;
      continue;
    }
    deps.info(
      `[secret-scan] WARN stage=${stage} pattern=${w.pattern} path=${w.path} (warning-only; not stopping the loop)`,
    );
    loggedByPattern.set(w.pattern, loggedSoFar + 1);
    totalLogged += 1;
  }
  if (suppressedByPath > 0 || cappedOver > 0) {
    // TY-304: surface *which* patterns saturated so operators can act on
    // per-pattern volume (e.g. tune the regex, promote to hard-fail, add a
    // path-suppress entry). Sorted for deterministic test output.
    const cappedByPattern = [...loggedByPattern.entries()]
      .filter(([, count]) => count >= SECRET_WARN_LOG_CAP_PER_PATTERN)
      .map(([name]) => name)
      .sort();
    const cappedHint =
      cappedByPattern.length > 0
        ? ` (capped patterns: ${cappedByPattern.join(", ")})`
        : "";
    deps.info(
      `[secret-scan] WARN summary stage=${stage} logged=${totalLogged} suppressed_by_path=${suppressedByPath} capped_over=${cappedOver}${cappedHint}`,
    );
  }
}

export function formatScopeViolationDetail(
  violation: ScopeCheckViolation,
  maxFiles: number,
  maxLines: number,
): string {
  switch (violation.reason) {
    case "hard_block_path": {
      const matched = violation.matchedBlockPatterns ?? [];
      const lockedPaths = matched
        .filter((p) => p.locked)
        .map((p) => p.path);
      const unlockedSnippets = matched
        .filter((p) => !p.locked)
        .map((p) => `!${p.path}`);
      const uniqueSnippets = Array.from(new Set(unlockedSnippets));
      const lines: string[] = [
        "Auto-fix touched paths blocked by the scope check.",
        "",
        "Affected paths:",
        ...violation.offendingPaths.map((p) => `  - ${p}`),
      ];
      if (uniqueSnippets.length > 0) {
        lines.push(
          "",
          "To let Claude edit these paths, add the matching `!` entries to the",
          "`LOOPPILOT_BLOCK_PATHS` Repository variable:",
          "",
          `  LOOPPILOT_BLOCK_PATHS = "${uniqueSnippets.join(",")}"`,
          "",
          "(If the variable is already set, append the new entries with a comma.)",
        );
      }
      if (lockedPaths.length > 0) {
        lines.push(
          "",
          `Note: \`.github/\` is locked and cannot be unblocked — ${lockedPaths.join(", ")} must be edited manually.`,
        );
      }
      lines.push("", `See ${SCOPE_POLICY_DOC}.`);
      return lines.join("\n");
    }
    case "too_many_files":
      return [
        `Auto-fix diff exceeds the file-count budget (${violation.offendingPaths.length} > ${maxFiles}).`,
        "",
        "To raise the limit, set the `LOOPPILOT_SCOPE_MAX_FILES` Repository variable",
        "(or pass the `scope-max-files` action input) to a higher value.",
        "",
        `See ${SCOPE_POLICY_DOC}.`,
      ].join("\n");
    case "too_many_lines":
      return [
        `Auto-fix diff exceeds the line-count budget (limit ${maxLines}).`,
        "",
        "To raise the limit, set the `LOOPPILOT_SCOPE_MAX_LINES` Repository variable",
        "(or pass the `scope-max-lines` action input) to a higher value.",
        "",
        `See ${SCOPE_POLICY_DOC}.`,
      ].join("\n");
    case "binary_change":
      return [
        "Auto-fix produced a binary change, which the loop cannot validate.",
        "",
        "Affected paths:",
        ...violation.offendingPaths.map((p) => `  - ${p}`),
        "",
        "Auto-fix only handles text edits. Apply the binary change manually.",
        `See ${SCOPE_POLICY_DOC}.`,
      ].join("\n");
    case "path_traversal":
      return [
        "Refusing to apply a diff containing path-traversal or absolute paths.",
        "",
        "Offending paths:",
        ...violation.offendingPaths.map((p) => `  - ${p}`),
        "",
        "This is a hard security refusal and has no override.",
        `See ${SCOPE_POLICY_DOC}.`,
      ].join("\n");
  }
}

interface FailureExitOptions {
  config: BaseConfig;
  inputs: PostFixInputs;
  state: ReviewState;
  stopReason: StopReason;
  detail: string;
  postCheckFailureBody?: string;
  /** When true, save `postCheckFailureBody` (truncated) into previousCheckFailure. */
  preservePreviousCheckFailure?: boolean;
  remainingFindings?: number;
}

export async function runPostFix(
  config: BaseConfig,
  deps: PostFixDeps = defaultDeps,
  inputs: PostFixInputs = readPostFixInputs(),
): Promise<void> {
  // TY-264: shared helper so a new Config secret is masked symmetrically in
  // init/pre-fix/post-fix. Anthropic credentials are also registered here in
  // case the wrapping workflow exports `ANTHROPIC_API_KEY` via `env:` without
  // going through `loadConfig` (post-fix uses `loadInitConfig`, which leaves
  // those two fields empty by design).
  registerAllSecrets(config, deps.setSecret);

  deps.info(
    `[post-fix] Starting post-fix for PR #${config.prNumber}, iteration ${inputs.iteration}, action outcome: ${inputs.actionOutcome}`,
  );

  // Re-read state to get the latest commentUpdatedAt for optimistic locking,
  // and to verify pre-fix actually claimed the "fixing" status.
  const stateResult = await deps.readState(
    config.repoOwner,
    config.repoName,
    config.prNumber,
    config.githubToken,
  );
  if (!stateResult.found) {
    // TY-297 #2: end the step in `failure` so the looppilot-loop.yml #2B
    // fail-safe posts the top-level ⚠️ notification. A silent `return` would
    // leave the workflow step in `success` and the fail-safe would not fire.
    //
    // TY-310 #2: also demote a still-`fixing` hidden state here. Because this
    // path exits via `setFailed + return` (not a throw), `runIfNotVitest`'s
    // `onError` — the only other place demoteFixingOnCrash runs — never fires.
    // Without this call a transient readState failure, or a misconfigured
    // `LOOPPILOT_STATE_COMMENT_AUTHORS` that hides the real comment, would
    // strand the state at `fixing` until pre-fix's 30-min stale detector, and
    // the operator's `/restart-review` would be silently skipped by pre-fix's
    // `status === fixing && !stale` branch in the meantime. demoteFixingOnCrash
    // re-reads state and is a no-op unless it finds `fixing`, so a genuinely
    // missing state is unaffected.
    await deps.demoteFixingOnCrash("post-fix");
    deps.setFailed(
      "[post-fix] Hidden state comment is missing or corrupted at post-fix entry. " +
        "Demoted hidden state to `stopped/workflow_crashed` if it was still `fixing`. " +
        "If the state comment exists but is invisible, verify the `LOOPPILOT_STATE_COMMENT_AUTHORS` " +
        "configuration, then use `/restart-review` to resume.",
    );
    return;
  }
  if (stateResult.commentId !== inputs.commentId) {
    deps.warning(
      `[post-fix] State comment id changed since pre-fix (pre=${inputs.commentId}, current=${stateResult.commentId}). Using current id.`,
    );
  }
  if (stateResult.state.status !== "fixing") {
    deps.warning(
      `[post-fix] Expected status 'fixing' but found '${stateResult.state.status}'. Pre-fix may have short-circuited or another workflow ran. Skipping post-fix.`,
    );
    return;
  }

  const state = stateResult.state;
  const commentId = stateResult.commentId;

  const updateStateCommentLocked = createLockedStateUpdater({
    owner: config.repoOwner,
    repo: config.repoName,
    commentId,
    token: config.githubToken,
    initialExpectedUpdatedAt: stateResult.commentUpdatedAt,
    label: "post-fix",
    updateStateComment: deps.updateStateComment,
    warning: deps.warning,
    onConflict: async (detail) => {
      await deps.postStopComment(
        config.repoOwner,
        config.repoName,
        config.prNumber,
        "state_conflict",
        inputs.triggerCommentId,
        0,
        `${detail} Hidden comment was updated by another workflow run before this run could safely persist its state.`,
        config.githubToken,
      );
    },
  });

  async function failureExit(opts: FailureExitOptions): Promise<void> {
    // TY-302 #2: when the caller supplies a fresh CHECK_COMMAND failure tail
    // (= test_failure callsite), record it. Otherwise preserve the existing
    // `previousCheckFailure` so soft `/restart-review` after a non-test
    // failure (action_no_op / scope_violation / secret_leak_suspected /
    // max_turns_exceeded / action_timeout / action_failure / BUILD_COMMAND
    // failures) keeps the prior test_failure context available for the next
    // iteration's repair prompt and the `selectModel` escalation.
    // The clean-commit path (`:1423`) explicitly writes `previousCheckFailure:
    // null` outside failureExit, so successful repairs still clear context.
    const previousCheckFailure =
      opts.preservePreviousCheckFailure && opts.postCheckFailureBody
        ? truncatePreviousCheckFailure(opts.postCheckFailureBody)
        : opts.state.previousCheckFailure;

    // TY-302 #1: pre-fix Phase 3 optimistically claimed `fixing` with
    // iterationCount+1 and appended the current findings hash to history
    // before claude-code-action ran. When post-fix stops without a committed
    // fix, that bookkeeping would otherwise consume an iteration and
    // pre-poison loop detection for a subsequent soft `/restart-review`
    // (next run sees the same hash already in history → `loop_detected`
    // immediately). The shared `rollbackFixingClaim` helper is also used by
    // `demoteFixingOnCrash` and pre-fix stale-fixing recovery so all three
    // paths share a single source of truth.
    const stoppedState: ReviewState = {
      ...opts.state,
      ...rollbackFixingClaim(opts.state),
      status: "stopped",
      stopReason: opts.stopReason,
      previousCheckFailure,
      // TY-273 #B4: leaving stale entry would mislead the next pre-fix run.
      fixingStartedAt: null,
      // TY-360: no commit was pushed on this path, so the iteration's in-scope
      // findings were not fixed — clear the ids so a soft /restart-review does
      // not resolve threads for findings that were never repaired.
      currentIterationFindingCommentIds: [],
    };
    if (
      !(await updateStateCommentLocked(
        stoppedState,
        `Could not stop after ${opts.stopReason}.`,
      ))
    ) {
      return;
    }
    const progress = deriveIterationProgress(
      stoppedState,
      config.maxReviewIterations,
    );
    if (opts.stopReason === "test_failure" && opts.postCheckFailureBody) {
      // TY-290 #2: `postTestFailureComment` only edits the aggregated status
      // comment, which does NOT fire a GitHub notification (the same reason
      // TY-259 split `postTerminalNotification` out of the status upsert).
      // CHECK_COMMAND failures need operator attention to triage the failing
      // test / lint / typecheck output, so we follow the status update with
      // an explicit top-level ⚠️ comment via `postTerminalNotification`.
      const statusCommentId = await deps.postTestFailureComment(
        config.repoOwner,
        config.repoName,
        config.prNumber,
        opts.postCheckFailureBody,
        config.githubToken,
        progress,
      );
      await deps.postTerminalNotification(
        config.repoOwner,
        config.repoName,
        config.prNumber,
        statusCommentId,
        {
          kind: "stopped",
          stopReason: "test_failure",
          remainingFindings: opts.remainingFindings,
        },
        config.githubToken,
      );
    } else {
      await deps.postStopComment(
        config.repoOwner,
        config.repoName,
        config.prNumber,
        opts.stopReason,
        inputs.triggerCommentId,
        opts.remainingFindings ?? 0,
        opts.detail,
        config.githubToken,
        progress,
      );
    }
  }

  /**
   * ES-496: on a base-tier `max_turns_exceeded`, retry once at the escalated
   * tier WITHOUT waiting for a manual `/restart-review`. Returns `true` when it
   * has taken over the terminal handling — either re-requesting `@codex review`
   * and returning to `waiting_codex` (so the next pre-fix escalates via
   * `previous_max_turns_exceeded`), or demoting to `stopped/codex_request_failed`
   * when the re-request cannot reach Codex. Returns `false` when auto-retry does
   * not apply, so the caller proceeds with the normal `failureExit`.
   *
   * The working tree was already reverted by the outer failure branch. This
   * deliberately mirrors (rather than shares) Phase 4's re-request/demotion
   * contract so the merge-critical successful-repair path stays untouched.
   */
  async function attemptMaxTurnsAutoRetry(): Promise<boolean> {
    if (!config.autoRetryEscalateMaxTurns) return false;

    // No higher tier exists under fixed-model operation → escalation is a no-op.
    if (config.claudeCodeModelBase === config.claudeCodeModelEscalated) {
      deps.info(
        "[post-fix] auto-retry-escalate: base and escalated models are identical; not auto-retrying max_turns_exceeded.",
      );
      return false;
    }

    // Fire only when the just-run iteration used the base tier. The last
    // findingsHashHistory entry records that tier (pre-fix Phase 3 appends it);
    // a legacy/absent modelTier is treated as escalated (no higher tier). This
    // is also the one-shot guard: an escalated retry that hits max_turns again
    // has `modelTier: "escalated"` here and stops normally.
    const lastTier = state.findingsHashHistory.at(-1)?.modelTier ?? "escalated";
    if (lastTier !== "base") {
      deps.info(
        `[post-fix] auto-retry-escalate: previous iteration tier=${lastTier}; one-shot exhausted, stopping on max_turns_exceeded.`,
      );
      return false;
    }

    deps.info(
      "[post-fix] auto-retry-escalate: base-tier max_turns_exceeded — re-requesting @codex review to retry once at the escalated tier (no /restart-review).",
    );

    // Roll back the base iteration's bookkeeping (same as failureExit) and
    // return to waiting_codex preserving stopReason so the next pre-fix selects
    // the escalated tier (`previous_max_turns_exceeded`).
    const retryState: ReviewState = {
      ...state,
      ...rollbackFixingClaim(state),
      status: "waiting_codex",
      stopReason: "max_turns_exceeded",
      fixingStartedAt: null,
      currentIterationFindingCommentIds: [],
    };
    if (
      !(await updateStateCommentLocked(
        retryState,
        "Could not record waiting_codex for the max_turns auto-retry.",
      ))
    ) {
      // 412 conflict: another writer reconciled; the state is no longer fixing.
      // Treat as handled so the caller does not also run failureExit.
      return true;
    }

    // Demote to a restartable stop when the re-request cannot reach Codex
    // (mirrors Phase 4 / TY-273 #B5). The reverted working tree means no commit
    // was made, so /restart-review cleanly retries the same findings.
    const demoteToCodexRequestFailed = async (
      baseState: ReviewState,
      detail: string,
    ): Promise<void> => {
      const stoppedState: ReviewState = {
        ...baseState,
        status: "stopped",
        stopReason: "codex_request_failed",
      };
      if (
        !(await updateStateCommentLocked(
          stoppedState,
          "Could not record codex_request_failed after a failed max_turns auto-retry.",
          {
            onConflict: async (conflictDetail) => {
              deps.warning(
                `[post-fix] ${conflictDetail} State was advanced by a concurrent run; auto-retry demotion skipped.`,
              );
            },
          },
        ))
      ) {
        return;
      }
      try {
        await deps.postStopComment(
          config.repoOwner,
          config.repoName,
          config.prNumber,
          "codex_request_failed",
          inputs.triggerCommentId,
          0,
          detail,
          config.githubToken,
          deriveIterationProgress(stoppedState, config.maxReviewIterations),
        );
      } catch (notifyError) {
        deps.warning(
          `[post-fix] auto-retry-escalate: demoted to codex_request_failed but failed to post the stop notification: ${
            notifyError instanceof Error ? notifyError.message : String(notifyError)
          }`,
        );
      }
    };

    deps.info(
      "[post-fix] Posting @codex review request (max_turns auto-retry)...",
    );
    const codexRequestedAt = new Date().toISOString();
    let reviewRequestId: number;
    try {
      reviewRequestId = await deps.postCodexReviewRequest(
        config.repoOwner,
        config.repoName,
        config.prNumber,
        config.codexReviewRequestToken,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.error(
        `[post-fix] auto-retry-escalate: failed to post @codex review: ${message}. Downgrading to stopped/codex_request_failed.`,
      );
      await demoteToCodexRequestFailed(
        retryState,
        `Failed to post @codex review for the max_turns escalated auto-retry: ${message}`,
      );
      return true;
    }

    // Audit comment (best-effort). Posted only AFTER `@codex review` actually
    // went out, so a request failure above cannot leave an optimistic
    // "retrying" comment contradicting the codex_request_failed stop.
    try {
      await deps.postComment(
        config.repoOwner,
        config.repoName,
        config.prNumber,
        "🔁 LoopPilot auto-retry: the base-tier repair hit `--max-turns`. " +
          "Re-requested `@codex review` to retry once at the escalated tier " +
          `(\`${config.claudeCodeModelEscalated}\`) — no \`/restart-review\` needed. ` +
          "If the escalated attempt also exceeds `--max-turns`, the loop stops for manual follow-up.",
        config.githubToken,
      );
    } catch (commentError) {
      deps.warning(
        `[post-fix] auto-retry-escalate: failed to post the audit comment (continuing): ${
          commentError instanceof Error ? commentError.message : String(commentError)
        }`,
      );
    }

    const withRequestId: ReviewState = {
      ...retryState,
      lastCodexRequestCommentId: reviewRequestId,
    };
    let requestIdPersisted: boolean;
    try {
      requestIdPersisted = await updateStateCommentLocked(
        withRequestId,
        "Could not persist the auto-retry Codex review request comment id.",
        {
          onConflict: async (conflictDetail) => {
            deps.warning(
              `[post-fix] ${conflictDetail} LoopPilot state remains waiting_codex; the next Codex review trigger will reconcile.`,
            );
          },
        },
      );
    } catch (recordError) {
      // The @codex review comment was posted and state is waiting_codex; a
      // non-conflict failure to persist the id is non-fatal (mirrors Phase 4).
      deps.warning(
        `[post-fix] auto-retry-escalate: failed to persist the review request id (non-conflict error): ${
          recordError instanceof Error ? recordError.message : String(recordError)
        }. State remains waiting_codex; the next Codex trigger will reconcile.`,
      );
      return true;
    }
    if (!requestIdPersisted) {
      // 412 conflict: a concurrent run already advanced the state (e.g. the
      // incoming Codex review drove a fresh pre-fix). Skip the ACK poll — the
      // concurrent writer now owns the loop (mirrors Phase 4's guard).
      return true;
    }

    const ack = await deps.ensureCodexAck({
      owner: config.repoOwner,
      repo: config.repoName,
      pr: config.prNumber,
      commentId: reviewRequestId,
      requestedAt: codexRequestedAt,
      codexBotLogin: config.codexBotLogin,
      readToken: config.githubToken,
      token: config.codexReviewRequestToken,
      timeoutSeconds: config.codexAckTimeoutSeconds,
      pollIntervalSeconds: config.codexAckPollIntervalSeconds,
      maxReposts: config.codexAckMaxReposts,
    });
    if (!ack.acked) {
      await demoteToCodexRequestFailed(
        { ...withRequestId, lastCodexRequestCommentId: ack.lastCommentId },
        `Codex did not acknowledge the escalated auto-retry @codex review request after ${config.codexAckMaxReposts} repost(s) (≈${config.codexAckTimeoutSeconds}s per attempt). No commit was made; run /restart-review once Codex is reachable to retry at the escalated tier.`,
      );
      return true;
    }

    // If the ACK only arrived after a repost, record the latest @codex review
    // comment id (mirrors Phase 4). Best-effort — the state is already
    // waiting_codex — so a failure here is swallowed rather than demoting a
    // healthy loop.
    if (ack.reposts > 0 && ack.lastCommentId !== reviewRequestId) {
      try {
        await updateStateCommentLocked(
          { ...withRequestId, lastCodexRequestCommentId: ack.lastCommentId },
          "Could not persist the reposted auto-retry Codex review request id.",
          {
            onConflict: async (conflictDetail) => {
              deps.warning(
                `[post-fix] ${conflictDetail} LoopPilot state remains waiting_codex; the next Codex review trigger will reconcile.`,
              );
            },
          },
        );
      } catch (repostWriteError) {
        deps.warning(
          `[post-fix] auto-retry-escalate: failed to persist the reposted review request id ${ack.lastCommentId}: ${
            repostWriteError instanceof Error ? repostWriteError.message : String(repostWriteError)
          }. State remains waiting_codex; the next Codex trigger will reconcile.`,
        );
      }
    }

    deps.info(
      `[post-fix] auto-retry-escalate: state=waiting_codex; escalated retry pending. Review request: ${ack.lastCommentId}`,
    );
    return true;
  }

  // ─── PR lifecycle gate (ES-426 #5) ────────────────────────────────────────
  // If the PR was closed / merged / converted to draft during the run, do not
  // commit / push / re-request review — including via the ES-496 max_turns
  // auto-retry, which posts an `@codex review` on the failure path. Placed
  // BEFORE the outcome handling so it covers BOTH the success path and the
  // auto-retry. Discard the uncommitted repair, roll back the optimistic fixing
  // claim (no iteration consumed), and pause at waiting_codex — non-destructive,
  // resumes on the next Codex review once the PR is open and ready.
  //
  // `stopReason` is intentionally preserved (via `...state`): rollbackFixingClaim
  // rewinds this iteration, so the paused state should mirror the pre-iteration
  // waiting_codex state, including any escalation signal (e.g.
  // `max_turns_exceeded`) carried in from a prior `/restart-review` — the resumed
  // iteration then re-escalates until an actual clean commit clears it (one-shot,
  // same as the normal Phase 4 semantics).
  //
  // Fail-open on lookup error so a transient API failure cannot strand a healthy
  // repair.
  try {
    const lifecycle = await deps.fetchPrLifecycle(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      config.githubToken,
    );
    if (lifecycle.merged || lifecycle.state === "closed" || lifecycle.draft) {
      const reason = lifecycle.merged
        ? "merged"
        : lifecycle.state === "closed"
          ? "closed"
          : "a draft";
      deps.warning(
        `[post-fix] PR #${config.prNumber} is ${reason}; discarding the uncommitted repair and pausing (no commit / re-review). Resumes on the next Codex review once the PR is open and ready.`,
      );
      try {
        deps.resetWorkingTree();
      } catch (resetError) {
        deps.error(
          `[post-fix] Failed to reset working tree after detecting a ${reason} PR: ${
            resetError instanceof Error ? resetError.message : String(resetError)
          }`,
        );
      }
      const pausedState: ReviewState = {
        ...state,
        ...rollbackFixingClaim(state),
        status: "waiting_codex",
        fixingStartedAt: null,
        currentIterationFindingCommentIds: [],
      };
      // Per-call onConflict: a benign lifecycle pause must not post the default
      // `state_conflict` "⚠️ stopped" comment (which would contradict the
      // non-terminal pause). A concurrent writer already owns the state — warn
      // and move on (mirrors the TY-286 re-review write pattern).
      await updateStateCommentLocked(
        pausedState,
        `Could not pause after detecting a ${reason} PR.`,
        {
          onConflict: async (detail) => {
            deps.warning(
              `[post-fix] ${detail} State was advanced by a concurrent run; lifecycle pause skipped.`,
            );
          },
        },
      );
      return;
    }
  } catch (error) {
    deps.warning(
      `[post-fix] Could not read PR lifecycle state for #${config.prNumber} (${
        error instanceof Error ? error.message : String(error)
      }); proceeding.`,
    );
  }

  // ─── claude-code-action outcome handling ─────────────────────────────────
  const outcome = inputs.actionOutcome.toLowerCase();
  if (outcome !== "success") {
    deps.warning(
      `[post-fix] claude-code-action outcome=${inputs.actionOutcome}. Reverting working tree and stopping.`,
    );
    try {
      deps.resetWorkingTree();
    } catch (resetError) {
      deps.error(
        `[post-fix] Failed to reset working tree after action failure: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
      );
    }

    let stopReason: StopReason = "action_failure";
    let detail = `claude-code-action exited with outcome=${inputs.actionOutcome}.`;

    if (outcome === "cancelled") {
      // Cancelled steps are typically the result of job-level timeout or a
      // manual cancel. The dedicated stop reason for the workflow timeout
      // case is action_timeout.
      stopReason = "action_timeout";
      detail =
        "claude-code-action step was cancelled, typically because the workflow job timeout was reached.";
    } else if (outcome === "failure") {
      const fileContents = deps.readActionExecutionFile(inputs.actionExecutionFile);
      if (detectMaxTurnsExceeded(fileContents)) {
        stopReason = "max_turns_exceeded";
        detail = "claude-code-action exhausted the configured --max-turns budget.";
      }
    }

    // ES-496: opt-in escalated-tier auto-retry on a base-tier max_turns stop.
    // When it takes over (re-requests @codex review or demotes to
    // codex_request_failed) skip the normal stop.
    if (stopReason === "max_turns_exceeded" && (await attemptMaxTurnsAutoRetry())) {
      return;
    }

    await failureExit({
      config,
      inputs,
      state,
      stopReason,
      detail,
    });
    return;
  }

  // ─── Scope check ─────────────────────────────────────────────────────────
  // Combine `git diff --numstat HEAD` (tracked edits / deletions; ignoring
  // rename detection so paths are real filesystem paths, not `{a => b}`
  // notation) with `git ls-files --others --exclude-standard` (untracked
  // files). Without the second source, brand-new files written by
  // claude-code-action are invisible to the pipeline and either drop the
  // entire run as a no-op or partially stage edits — see Codex review
  // feedback on PR #33.
  let numstat: string;
  let untrackedRaw: string;
  try {
    numstat = deps.gitDiffNumstat();
    untrackedRaw = deps.gitListUntracked();
  } catch (error) {
    deps.error(
      `[post-fix] Failed to enumerate working-tree changes: ${error instanceof Error ? error.message : String(error)}`,
    );
    await failureExit({
      config,
      inputs,
      state,
      stopReason: "action_failure",
      detail: "Could not enumerate working-tree changes via git diff / ls-files.",
    });
    return;
  }
  const trackedChanges: ChangedFile[] = parseGitNumstat(numstat);
  // TY-275 #3: `parseGitNumstat` drops paths containing ` => ` as a defensive
  // guard against rename notation that leaks through when `--no-renames` is
  // missing — but `git ls-files --others` (which produces `untrackedRaw`)
  // never emits rename notation. The literal substring is therefore a
  // legitimate filename character on the untracked side; applying the same
  // filter would silently drop real files (and any secrets they carry) from
  // both scope check and the post-fix secret scan. The asymmetry is
  // intentional — do not add the filter here.
  const untrackedChanges: ChangedFile[] = untrackedRaw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => decodeLsFilesPath(line))
    .map((path) => {
      const content = deps.readWorkingTreeFile(path);
      // null content (binary, missing, permission) → mark as binary so
      // checkScope rejects it explicitly via reason="binary_change" rather
      // than silently undercounting line totals.
      if (content === null) {
        return { path, added: -1, deleted: -1 };
      }
      const added = countUntrackedAddedLines(content);
      return { path, added, deleted: 0 };
    });
  const changedFiles: ChangedFile[] = [...trackedChanges, ...untrackedChanges];
  deps.info(
    `[post-fix] Detected ${changedFiles.length} changed file(s) in working tree (${trackedChanges.length} tracked, ${untrackedChanges.length} new).`,
  );

  if (changedFiles.length === 0) {
    // TY-284: claude-code-action returning success without any file edits is
    // treated as a stop condition (`action_no_op`) rather than a soft retry.
    // The earlier behavior (TY-273 #B3) rolled back Phase 3 bookkeeping and
    // re-posted `@codex review` to give the action a second chance, but the
    // resulting loop was indistinguishable from a normal iteration in PR
    // history and silently consumed model budget. The user spec is "any
    // error stops the loop; `/restart-review` is the only resumption" — the
    // Phase 3 rollback is folded into `failureExit` so soft restart picks up
    // where pre-fix left off, and probabilistic empty runs that previously
    // benefited from the auto-retry are now an explicit operator decision.
    deps.error(
      "[post-fix] claude-code-action produced no file changes. Stopping (action_no_op).",
    );
    await failureExit({
      config,
      inputs,
      state,
      stopReason: "action_no_op",
      detail:
        "claude-code-action returned success but made no file changes for the given findings. " +
        "This typically means the findings are already resolved, false positives, or beyond claude-code-action's one-shot capability. " +
        "Use /restart-review to retry, or investigate the Codex findings manually.",
    });
    return;
  }

  const blockSpec = parseBlockPathsSpec(config.autoReviewBlockPaths);
  for (const ignored of blockSpec.ignoredRemovals) {
    deps.warning(
      `[scope-check] LOOPPILOT_BLOCK_PATHS removal "!${ignored}" was ignored: .github/ is locked and cannot be unblocked.`,
    );
  }

  const scopePolicy = buildScopePolicy({
    blockPathsSpec: config.autoReviewBlockPaths,
    maxFiles: config.scopeMaxFiles > 0 ? config.scopeMaxFiles : undefined,
    maxLines: config.scopeMaxLines > 0 ? config.scopeMaxLines : undefined,
  });

  if (config.autoReviewBlockPaths !== "") {
    deps.info(
      `[scope-check] LOOPPILOT_BLOCK_PATHS: "${config.autoReviewBlockPaths}"`,
    );
  }

  let scopeResult: ScopeCheckResult = checkScope(changedFiles, scopePolicy);
  if (!scopeResult.ok) {
    deps.warning(`[post-fix] Scope violation: ${scopeResult.message}`);
    try {
      deps.resetWorkingTree();
    } catch (resetError) {
      deps.error(
        `[post-fix] Failed to reset working tree after scope violation: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
      );
    }
    await failureExit({
      config,
      inputs,
      state,
      stopReason: "scope_violation",
      detail: formatScopeViolationDetail(scopeResult, scopePolicy.maxFiles, scopePolicy.maxLines),
    });
    return;
  }

  deps.info(
    `[post-fix] Scope check passed: ${scopeResult.changedFiles} file(s), ${scopeResult.totalLines} line(s).`,
  );

  // ─── Secret pattern scan (TY-274 #1) ─────────────────────────────────────
  // Scope check already validated *paths*, but `src/`-class allow-listed paths
  // are content-agnostic — claude-code-action can `Read` `.env`-style files
  // and embed their contents into an allowed path. Hard-fail patterns
  // (known token prefixes / PEM private-key headers) stop the loop with
  // `secret_leak_suspected`; warning patterns are surfaced via `core.info` so
  // operators can promote them to hard-fail after they accumulate clean hits.
  //
  // Diff-based: we scan only the lines the agent ADDED. Whole-content scanning
  // would falsely flag the scanner's own regex literals and test fixtures
  // (which encode the patterns) as leaks the first time they entered the
  // tree; that content is in HEAD now and therefore absent from `git diff`.
  const preCheckScanResult = scanWithIntentToAdd({
    untrackedPaths: untrackedChanges.map((f) => f.path),
    deps,
  });
  logSecretScanWarnings(preCheckScanResult, "pre-check", deps);
  if (preCheckScanResult.hardFailures.length > 0) {
    deps.error(
      `[secret-scan] Hard-fail secret patterns detected pre-check (${preCheckScanResult.hardFailures.length} finding(s)). Reverting working tree.`,
    );
    for (const f of preCheckScanResult.hardFailures) {
      deps.error(`[secret-scan] HARD pattern=${f.pattern} path=${f.path}`);
    }
    try {
      deps.resetWorkingTree();
    } catch (resetError) {
      deps.error(
        `[post-fix] Failed to reset working tree after secret-scan hard fail: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
      );
    }
    await failureExit({
      config,
      inputs,
      state,
      stopReason: "secret_leak_suspected",
      detail: formatSecretLeakDetail(preCheckScanResult.hardFailures),
    });
    return;
  }

  // ─── CHECK_COMMAND ───────────────────────────────────────────────────────
  // `modifiedFiles` is reassigned post-CHECK (TY-297 #1) so CHECK_COMMAND's
  // own writes are staged, and again post-BUILD when artifacts expand the
  // staging set (TY-281). The initial pre-CHECK value is never read on the
  // success path; it survives only as a typed initializer for the `let`.
  let modifiedFiles: string[] = changedFiles.map((f) => f.path);
  deps.info(`[post-fix] Running CHECK_COMMAND: ${inputs.checkCommand}`);
  const checkResult = await deps.runCheckCommand(inputs.checkCommand);

  if (!checkResult.success) {
    deps.error("[post-fix] CHECK_COMMAND failed. Reverting working tree (incl. untracked).");
    try {
      // TY-276 #2: working-tree restore is consolidated here via
      // `resetWorkingTree` (`git reset --hard HEAD && git clean -ffd`).
      // Earlier `runCheckCommand` also performed per-file rollback for tracked
      // paths, but that was a partial duplicate of this reset and could leave
      // partial restores when the per-file loop failed mid-way.
      deps.resetWorkingTree();
    } catch (resetError) {
      deps.error(
        `[post-fix] Failed to reset working tree after CHECK_COMMAND failure: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
      );
    }
    await failureExit({
      config,
      inputs,
      state,
      stopReason: "test_failure",
      detail: "CHECK_COMMAND failed after claude-code-action repair.",
      postCheckFailureBody: checkResult.output,
      preservePreviousCheckFailure: true,
    });
    return;
  }

  deps.info("[post-fix] CHECK_COMMAND passed. Committing changes...");

  // ─── Post-CHECK enumeration (TY-297 #1) ─────────────────────────────────
  // Re-enumerate the working tree regardless of BUILD_COMMAND configuration.
  // CHECK_COMMAND can mutate files via `prettier --write` / `eslint --fix` /
  // snapshot regeneration; with the pre-fix `modifiedFiles` list only those
  // post-CHECK mutations would never be staged on the no-build path and would
  // silently disappear at the next iteration's `actions/checkout`, fueling
  // exactly the cycle-≥-4 oscillation TY-296 raised. Hoisting the enumeration
  // also lets us run a second scope check against CHECK_COMMAND's output, so a
  // formatter that touches `.github/` (or any other locked path) is now caught
  // instead of slipping through the pre-CHECK gate.
  let postCheckNumstat: string;
  let postCheckUntrackedRaw: string;
  try {
    postCheckNumstat = deps.gitDiffNumstat();
    postCheckUntrackedRaw = deps.gitListUntracked();
  } catch (error) {
    deps.error(
      `[post-fix] Failed to re-enumerate working tree after CHECK_COMMAND: ${error instanceof Error ? error.message : String(error)}`,
    );
    try {
      deps.resetWorkingTree();
    } catch {
      // best-effort; outer failureExit still records the failure
    }
    await failureExit({
      config,
      inputs,
      state,
      stopReason: "action_failure",
      detail: "Could not enumerate working-tree changes after CHECK_COMMAND.",
    });
    return;
  }
  const postCheckTracked: ChangedFile[] = parseGitNumstat(postCheckNumstat);
  const postCheckUntracked: ChangedFile[] = postCheckUntrackedRaw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => decodeLsFilesPath(line))
    .map((path) => {
      const content = deps.readWorkingTreeFile(path);
      if (content === null) {
        return { path, added: -1, deleted: -1 };
      }
      const added = countUntrackedAddedLines(content);
      return { path, added, deleted: 0 };
    });
  const postCheckChangedFiles: ChangedFile[] = [...postCheckTracked, ...postCheckUntracked];

  // Catch CHECK_COMMAND writing to locked / blocked paths. The pre-CHECK scope
  // check at :745 only saw claude-code-action's intentional edits; a hook /
  // formatter / snapshot updater could still touch `.github/` etc. between
  // CHECK_COMMAND and the commit.
  //
  // On the no-build path (buildCommand === "") this gate is the only
  // post-CHECK enforcement, so it runs unconditionally with strict checkScope.
  //
  // When buildCommand is configured we defer until after BUILD_COMMAND: the
  // build step can legitimately clean up temporary files that CHECK_COMMAND
  // wrote as side-effects (cache reports, scratch artefacts). Running the gate
  // here would trigger false scope_violation stops on file-count / line-count /
  // blocked-path rules for files BUILD_COMMAND is about to remove. The
  // post-build checkScope at :1153 re-checks only the files that actually
  // survive to the staging set, so the security guarantee is preserved.
  if (config.buildCommand === "") {
    const postCheckScopeResult: ScopeCheckResult = checkScope(postCheckChangedFiles, scopePolicy);
    if (!postCheckScopeResult.ok) {
      deps.warning(
        `[post-fix] Scope violation after CHECK_COMMAND: ${postCheckScopeResult.message}`,
      );
      try {
        deps.resetWorkingTree();
      } catch (resetError) {
        deps.error(
          `[post-fix] Failed to reset working tree after post-CHECK scope violation: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
        );
      }
      await failureExit({
        config,
        inputs,
        state,
        stopReason: "scope_violation",
        detail: formatScopeViolationDetail(
          postCheckScopeResult,
          scopePolicy.maxFiles,
          scopePolicy.maxLines,
        ),
      });
      return;
    }
    scopeResult = postCheckScopeResult;
  }

  // Replace the pre-CHECK `modifiedFiles` snapshot with the post-CHECK truth.
  // Stage / pre-commit-secret-scan / commit downstream all rely on this list,
  // and the no-build path previously used the stale pre-CHECK list — see the
  // TY-297 #1 description for the silent-discard failure mode this closes.
  modifiedFiles = postCheckChangedFiles.map((f) => f.path);

  // TY-325: pre-CHECK had non-empty changes (the :850 action_no_op guard
  // passed), but CHECK_COMMAND (a formatter / codegen / regeneration step)
  // normalized the working tree back to HEAD. On the no-build path this is the
  // last enumeration before commit, so without this guard the flow falls
  // through with an empty staging set: `stagePaths([])` is a no-op,
  // `hasStagedChanges()` is false, and we would post a misleading
  // "Auto-fix applied (no files changed)" summary plus a fresh `@codex review`
  // on unchanged code — wasting a Codex cycle and an iteration slot. Stop with
  // action_no_op so the behavior is symmetric with the build path, which
  // already stops on its own net-zero cases (postBuild / preBuild length===0).
  // failureExit's rollbackFixingClaim (TY-302 #1) rewinds iterationCount /
  // findingsHashHistory so a soft /restart-review re-evaluates the same
  // findings as a fresh iteration — the same recovery UX as TY-284.
  if (config.buildCommand === "" && postCheckChangedFiles.length === 0) {
    deps.error(
      "[post-fix] CHECK_COMMAND reverted all of claude-code-action's edits to HEAD (net-zero diff). Stopping (action_no_op).",
    );
    await failureExit({
      config,
      inputs,
      state,
      stopReason: "action_no_op",
      detail:
        "claude-code-action made edits that passed the scope check, but CHECK_COMMAND normalized the working " +
        "tree back to HEAD (net-zero diff), so the repair produced no committable change. This typically means " +
        "CHECK_COMMAND (a formatter / codegen step) is reverting the fix. Use /restart-review to retry, or " +
        "investigate whether CHECK_COMMAND is undoing claude-code-action's edits.",
    });
    return;
  }

  // ─── BUILD_COMMAND (TY-281) ──────────────────────────────────────────────
  // For repos that commit build artifacts (e.g. this repo's `dist/`), run
  // a configurable build step so the auto-fix commit cannot drift out of
  // sync with `src/`. Empty `buildCommand` skips this block, preserving
  // prior behavior for repos without committed build outputs.
  if (config.buildCommand !== "") {
    deps.info(`[post-fix] Running BUILD_COMMAND: ${config.buildCommand}`);
    const buildResult = await deps.runBuildCommand(config.buildCommand);
    if (!buildResult.success) {
      deps.error(
        "[post-fix] BUILD_COMMAND failed. Reverting working tree (incl. untracked).",
      );
      try {
        deps.resetWorkingTree();
      } catch (resetError) {
        deps.error(
          `[post-fix] Failed to reset working tree after BUILD_COMMAND failure: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
        );
      }
      const truncated = buildResult.output.length > 1500
        ? buildResult.output.slice(0, 1500) + "\n... (truncated) ..."
        : buildResult.output;
      await failureExit({
        config,
        inputs,
        state,
        stopReason: "action_failure",
        detail: [
          `BUILD_COMMAND failed: ${config.buildCommand}`,
          "",
          "Output:",
          truncated,
          "",
          "Adjust the BUILD_COMMAND Repository variable or fix the underlying build error and re-run with /restart-review.",
        ].join("\n"),
      });
      return;
    }

    // Re-enumerate working tree changes after BUILD_COMMAND. Build artifacts
    // (e.g. dist/*.cjs) typically appear in `git diff --numstat HEAD` as
    // tracked-edits, but a brand-new artifact path would show up as untracked.
    let postBuildNumstat: string;
    let postBuildUntrackedRaw: string;
    try {
      postBuildNumstat = deps.gitDiffNumstat();
      postBuildUntrackedRaw = deps.gitListUntracked();
    } catch (error) {
      deps.error(
        `[post-fix] Failed to re-enumerate working tree after BUILD_COMMAND: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        deps.resetWorkingTree();
      } catch {
        // best-effort; outer failureExit still records the failure
      }
      await failureExit({
        config,
        inputs,
        state,
        stopReason: "action_failure",
        detail: "Could not enumerate working-tree changes after BUILD_COMMAND.",
      });
      return;
    }
    const postBuildTracked: ChangedFile[] = parseGitNumstat(postBuildNumstat);
    const postBuildUntracked: ChangedFile[] = postBuildUntrackedRaw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => decodeLsFilesPath(line))
      .map((path) => {
        const content = deps.readWorkingTreeFile(path);
        if (content === null) {
          return { path, added: -1, deleted: -1 };
        }
        const added = countUntrackedAddedLines(content);
        return { path, added, deleted: 0 };
      });
    const postBuildChangedFiles: ChangedFile[] = [
      ...postBuildTracked,
      ...postBuildUntracked,
    ];

    // BUILD_COMMAND succeeded but left the working tree identical to HEAD.
    // claude-code-action's edits were accepted by CHECK_COMMAND but erased by
    // the build step, which means BUILD_COMMAND is destructively overwriting
    // fixes rather than layering build artifacts on top of them. Re-queuing
    // Codex review with rolled-back accounting would allow the loop to spin
    // indefinitely because loop-detection and max-iteration safeguards never
    // advance. Stop with action_failure so the operator is notified.
    if (postBuildChangedFiles.length === 0) {
      deps.warning(
        "[post-fix] BUILD_COMMAND erased all working-tree changes after claude's edits passed CHECK_COMMAND. Stopping.",
      );
      await failureExit({
        config,
        inputs,
        state,
        stopReason: "action_failure",
        detail: [
          `BUILD_COMMAND erased all working-tree changes: ${config.buildCommand}`,
          "",
          "claude-code-action's edits passed CHECK_COMMAND but the subsequent BUILD_COMMAND left",
          "the working tree identical to HEAD. If BUILD_COMMAND normalizes or overwrites the edits,",
          "the loop cannot make progress. Fix or disable BUILD_COMMAND and re-run with /restart-review.",
        ].join("\n"),
      });
      return;
    }

    // Re-apply scope checks on the post-build working tree. Files that were
    // already in postCheckChangedFiles (claude's edits plus any files written
    // or modified by CHECK_COMMAND) receive the full strict checkScope so that
    // file/line budgets, binary rejection, and unlocked block patterns still
    // apply to non-artifact changes. Only net-new files produced by
    // BUILD_COMMAND (the "build delta") use the relaxed checkScopeBuildMode,
    // which skips size budgets and default-blocked paths such as dist/.
    // Locked paths (`.github/`) and path traversal are still rejected by
    // both checks — those are security boundaries the build step must not breach.
    const changedFilePathSet = new Set(postCheckChangedFiles.map((f) => f.path));
    const postBuildPathSet = new Set(postBuildChangedFiles.map((f) => f.path));
    const preBuildFiles = postBuildChangedFiles.filter((f) => changedFilePathSet.has(f.path));
    const buildDeltaFiles = postBuildChangedFiles.filter((f) => !changedFilePathSet.has(f.path));

    // Guard: BUILD_COMMAND reverted all pre-build repairs but produced some
    // artifact. Without this check, preBuildFiles would be empty, checkScope([])
    // would succeed, and the commit would contain only artifacts with none of the
    // actual repair edits — causing repeated identical Codex findings and wasted
    // iterations.
    if (preBuildFiles.length === 0) {
      deps.warning(
        "[post-fix] BUILD_COMMAND reverted all repaired paths. No pre-build file differs from HEAD after BUILD_COMMAND.",
      );
      try {
        deps.resetWorkingTree();
      } catch (resetError) {
        deps.error(
          `[post-fix] Failed to reset working tree after BUILD_COMMAND reverted all repairs: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
        );
      }
      await failureExit({
        config,
        inputs,
        state,
        stopReason: "action_failure",
        detail: [
          `BUILD_COMMAND reverted all repair edits: ${config.buildCommand}`,
          "",
          "The build step produced artifacts but overwrote every file that claude-code-action",
          "and CHECK_COMMAND had changed. The resulting commit would not contain the actual repair,",
          "causing repeated identical Codex findings and wasted iterations.",
          "Fix or disable BUILD_COMMAND and re-run with /restart-review.",
        ].join("\n"),
      });
      return;
    }

    // Guard: BUILD_COMMAND reverted a subset of pre-build repairs. preBuildFiles
    // is non-empty (the all-reverted guard above did not fire) but some paths from
    // postCheckChangedFiles are absent from postBuildChangedFiles — the build step
    // restored those files to HEAD. Committing only the surviving paths would
    // produce an incomplete repair that re-triggers the same Codex findings.
    //
    // Only paths that were already in the pre-CHECK snapshot (changedFiles) are
    // considered repair paths. Files that first appeared after CHECK_COMMAND
    // (e.g. temporary scratch files or reports created as a CHECK_COMMAND
    // side-effect) are excluded: BUILD_COMMAND cleaning those up is not a revert
    // of the actual repair.
    const preCheckPathSet = new Set(changedFiles.map((f) => f.path));
    const revertedPaths = postCheckChangedFiles
      .map((f) => f.path)
      .filter((p) => preCheckPathSet.has(p) && !postBuildPathSet.has(p));
    if (revertedPaths.length > 0) {
      deps.warning(
        `[post-fix] BUILD_COMMAND reverted ${revertedPaths.length} repaired path(s): ${revertedPaths.join(", ")}`,
      );
      try {
        deps.resetWorkingTree();
      } catch (resetError) {
        deps.error(
          `[post-fix] Failed to reset working tree after BUILD_COMMAND partially reverted repairs: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
        );
      }
      await failureExit({
        config,
        inputs,
        state,
        stopReason: "action_failure",
        detail: [
          `BUILD_COMMAND reverted some repair edits: ${config.buildCommand}`,
          "",
          "The following repaired paths were restored to their HEAD state by the build step:",
          revertedPaths.map((p) => `  - ${p}`).join("\n"),
          "",
          "A commit built from the remaining changes would be an incomplete repair, causing",
          "repeated Codex findings and wasted iterations.",
          "Fix or disable BUILD_COMMAND and re-run with /restart-review.",
        ].join("\n"),
      });
      return;
    }

    const preBuildScopeResult: ScopeCheckResult = checkScope(preBuildFiles, scopePolicy);
    if (!preBuildScopeResult.ok) {
      deps.warning(
        `[post-fix] Scope violation (non-build files) after BUILD_COMMAND: ${preBuildScopeResult.message}`,
      );
      try {
        deps.resetWorkingTree();
      } catch (resetError) {
        deps.error(
          `[post-fix] Failed to reset working tree after post-build scope violation: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
        );
      }
      await failureExit({
        config,
        inputs,
        state,
        stopReason: "scope_violation",
        detail: formatScopeViolationDetail(
          preBuildScopeResult,
          scopePolicy.maxFiles,
          scopePolicy.maxLines,
        ),
      });
      return;
    }

    const buildDeltaScopeResult: ScopeCheckResult = checkScopeBuildMode(
      buildDeltaFiles,
      scopePolicy,
    );
    if (!buildDeltaScopeResult.ok) {
      deps.warning(
        `[post-fix] Scope violation (build artifacts) after BUILD_COMMAND: ${buildDeltaScopeResult.message}`,
      );
      try {
        deps.resetWorkingTree();
      } catch (resetError) {
        deps.error(
          `[post-fix] Failed to reset working tree after post-build scope violation: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
        );
      }
      await failureExit({
        config,
        inputs,
        state,
        stopReason: "scope_violation",
        detail: formatScopeViolationDetail(
          buildDeltaScopeResult,
          scopePolicy.maxFiles,
          scopePolicy.maxLines,
        ),
      });
      return;
    }

    scopeResult = {
      ok: true,
      changedFiles: postBuildChangedFiles.length,
      totalLines: preBuildScopeResult.totalLines + buildDeltaScopeResult.totalLines,
    };
    modifiedFiles = postBuildChangedFiles.map((f) => f.path);
    deps.info(
      `[post-fix] BUILD_COMMAND succeeded: ${postBuildChangedFiles.length} file(s), ${scopeResult.totalLines} line(s) staged.`,
    );
  }

  // ─── Pre-commit secret pattern scan (TY-274 #1) ──────────────────────────
  // Runs unconditionally after CHECK_COMMAND (and BUILD_COMMAND if any),
  // immediately before staging. Catches two bypass paths that the pre-check
  // scan cannot see:
  //   1. CHECK_COMMAND can rewrite files (`prettier --write`, `eslint --fix`,
  //      autoformatters in test runners). On the no-build path there is no
  //      second scan otherwise, so a check-time mutation that introduces a
  //      secret-shaped value would be committed silently.
  //   2. BUILD_COMMAND can inline env vars into bundle output (`dist/`).
  //
  // Diff-based, like the pre-check scan: only freshly added lines plus
  // untracked file bodies. Idempotent against the pre-check scan because the
  // same additions appear in `git diff HEAD`.
  let preCommitUntrackedRaw: string;
  try {
    preCommitUntrackedRaw = deps.gitListUntracked();
  } catch (error) {
    deps.error(
      `[post-fix] Failed to enumerate untracked files for pre-commit scan: ${error instanceof Error ? error.message : String(error)}`,
    );
    try {
      deps.resetWorkingTree();
    } catch {
      // best-effort
    }
    await failureExit({
      config,
      inputs,
      state,
      stopReason: "action_failure",
      detail: "Failed to enumerate untracked files for the final secret scan.",
    });
    return;
  }
  // `git ls-files --others` emits real filesystem paths verbatim (one per
  // line). Unlike `git diff --numstat` it does not produce rename notation,
  // so a `" => "` substring here is part of a legitimate filename and must
  // be preserved — filtering it out would silently drop those files from
  // the final scan and let secrets in such files slip through.
  const preCommitUntracked = preCommitUntrackedRaw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => decodeLsFilesPath(line));
  const preCommitScanResult = scanWithIntentToAdd({
    untrackedPaths: preCommitUntracked,
    deps,
  });
  logSecretScanWarnings(preCommitScanResult, "pre-commit", deps);
  if (preCommitScanResult.hardFailures.length > 0) {
    deps.error(
      `[secret-scan] Hard-fail secret patterns detected pre-commit (${preCommitScanResult.hardFailures.length} finding(s)). Reverting working tree.`,
    );
    for (const f of preCommitScanResult.hardFailures) {
      deps.error(`[secret-scan] HARD pattern=${f.pattern} path=${f.path}`);
    }
    try {
      deps.resetWorkingTree();
    } catch (resetError) {
      deps.error(
        `[post-fix] Failed to reset working tree after pre-commit secret-scan hard fail: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
      );
    }
    await failureExit({
      config,
      inputs,
      state,
      stopReason: "secret_leak_suspected",
      detail: formatSecretLeakDetail(preCommitScanResult.hardFailures),
    });
    return;
  }

  // Stage every file that the scope check accepted, then commit + push.
  try {
    deps.stagePaths(modifiedFiles);
  } catch (error) {
    deps.error(
      `[post-fix] git add failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    await failureExit({
      config,
      inputs,
      state,
      stopReason: "action_failure",
      detail: "Failed to stage repaired files for commit.",
    });
    return;
  }

  let commitSha = "";
  if (deps.hasStagedChanges()) {
    const commitMessage = [
      `fix: auto-resolve Codex review findings (iteration ${inputs.iteration})`,
      "",
      "Generated by anthropics/claude-code-action@v1 (loop-pilot).",
      `Files: ${modifiedFiles.length}, lines: ${scopeResult.totalLines}.`,
    ].join("\n");
    try {
      deps.commit(commitMessage);
      deps.push(
        config.repoOwner,
        config.repoName,
        inputs.prHeadRef,
        config.autoReviewPushToken,
      );
    } catch (error) {
      deps.error(
        `[post-fix] commit/push failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await failureExit({
        config,
        inputs,
        state,
        stopReason: "action_failure",
        detail: "Failed to commit or push repaired changes.",
      });
      return;
    }
    commitSha = deps.readHeadSha();
    deps.info(`[post-fix] Committed and pushed: ${commitSha}`);
  } else {
    // TY-329 #2: changedFiles was non-empty and passed scope / CHECK / BUILD,
    // but `git add` staged nothing. The earlier net-zero guards (TY-325) catch
    // the realistic cases; this residual branch previously fell through to
    // postClaudeCodeActionFixSummary + a fresh `@codex review` on unchanged
    // code with iterationCount NOT rolled back. Stop with action_no_op so every
    // net-zero exit is symmetric and a soft /restart-review re-evaluates the
    // same findings as a fresh iteration (failureExit's rollbackFixingClaim).
    deps.error(
      "[post-fix] No staged changes after `git add` despite a non-empty change set. Stopping (action_no_op).",
    );
    await failureExit({
      config,
      inputs,
      state,
      stopReason: "action_no_op",
      detail:
        "claude-code-action's edits passed scope / CHECK_COMMAND but produced no staged changes after `git add`, so there is nothing to commit. Use /restart-review to retry the same findings as a fresh iteration.",
    });
    return;
  }

  // Best-effort: the repair commit is already committed and pushed above, so a
  // transient failure updating the visible status comment must NOT propagate.
  // Left unhandled it reaches `runIfNotVitest`'s onError → `demoteFixingOnCrash`,
  // which — because the hidden state is still `fixing` (the `waiting_codex`
  // write below has not run yet) — rolls back `iterationCount` /
  // `findingsHashHistory` for an iteration whose commit is already on the branch
  // and demotes to `stopped/workflow_crashed`, falsely reporting a crash for a
  // successful repair and skipping the `@codex review` re-request. Mirror
  // pre-fix's `postFixingStartComment` handling (main-pre-fix.ts): warn and
  // continue so the push is honoured and Phase 4 still runs.
  try {
    await deps.postClaudeCodeActionFixSummary(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      inputs.iteration,
      modifiedFiles,
      commitSha || undefined,
      config.githubToken,
      deriveIterationProgress(state, config.maxReviewIterations),
    );
  } catch (summaryError) {
    const message =
      summaryError instanceof Error ? summaryError.message : String(summaryError);
    deps.warning(
      `[post-fix] Failed to update the auto-fix status comment after pushing the repair: ${message}. ` +
        "The repair commit is on the branch; continuing to waiting_codex and the @codex review re-request.",
    );
  }

  // ─── Phase 4: Re-review ──────────────────────────────────────────────────
  const waitingState: ReviewState = {
    ...state,
    status: "waiting_codex",
    lastClaudeCommitSha: commitSha || state.lastClaudeCommitSha,
    // TY-258: clear any `max_turns_exceeded` (or other) stop reason carried
    // over from a previous stop + `/restart-review`. A successful repair
    // means the escalation signal has done its job and the next iteration
    // should fall back to normal tiering (one-shot escalation).
    stopReason: null,
    previousCheckFailure: null,
    // TY-273 #B4: see no-op path and failureExit.
    fixingStartedAt: null,
    // TY-360: the iteration's findings are fixed + committed; clear the ids
    // from the persisted state. The resolve pass below reads the original
    // `state.currentIterationFindingCommentIds` (captured at post-fix entry),
    // so clearing here only prevents the next iteration's pre-fix / post-fix
    // from re-seeing a stale set.
    currentIterationFindingCommentIds: [],
  };
  try {
    if (
      !(await updateStateCommentLocked(
        waitingState,
        "Could not return state to waiting_codex after committing fixes.",
      ))
    ) {
      // 412 conflict: another writer reconciled. The hidden state is no longer
      // `fixing`, so demoteFixingOnCrash will not roll back the pushed commit.
      return;
    }
  } catch (writeError) {
    // TY-327: the repair commit was already committed AND pushed above. The
    // locker re-throws non-412 errors (transient 5xx / network); left
    // unhandled they propagate to runIfNotVitest's onError → demoteFixingOnCrash,
    // which sees status still === "fixing" (this write never landed) and rolls
    // back iterationCount + findingsHashHistory for an iteration whose commit is
    // already on the branch. Persist a restartable stop that PRESERVES the
    // committed iteration (no rollback) instead.
    const message =
      writeError instanceof Error ? writeError.message : String(writeError);
    deps.error(
      `[post-fix] Pushed repair commit ${commitSha || "(unknown sha)"} but failed to persist waiting_codex: ${message}. Recording stopped/codex_request_failed without rolling back the pushed iteration.`,
    );
    const stoppedState: ReviewState = {
      ...waitingState,
      status: "stopped",
      stopReason: "codex_request_failed",
    };
    let recorded: boolean;
    try {
      recorded = await updateStateCommentLocked(
        stoppedState,
        "Could not record stopped/codex_request_failed after the post-push waiting_codex write failed.",
      );
    } catch (secondError) {
      // Both writes failed (sustained API outage). Re-throw the ORIGINAL error
      // so demoteFixingOnCrash posts the crash notification; the iteration
      // rollback in that rare path is accounting-only since the commit is on
      // the branch.
      deps.error(
        `[post-fix] Could not record stopped state after push (${secondError instanceof Error ? secondError.message : String(secondError)}); falling back to crash recovery.`,
      );
      throw writeError;
    }
    if (recorded) {
      await deps.postStopComment(
        config.repoOwner,
        config.repoName,
        config.prNumber,
        "codex_request_failed",
        inputs.triggerCommentId,
        0,
        `The repair commit ${commitSha || "(unknown sha)"} was pushed, but persisting the waiting_codex state failed: ${message}. The commit is preserved on the branch; use /restart-review to resume.`,
        config.githubToken,
        deriveIterationProgress(stoppedState, config.maxReviewIterations),
      );
    }
    return;
  }

  // ─── Resolve fixed Codex review threads (TY-360 / A案) ───────────────────
  // CHECK_COMMAND succeeded and the repair commit is committed + pushed, so the
  // iteration's in-scope findings are considered fixed. Resolve the matching
  // Codex review threads so the PR's "Unresolved conversations" reflects the
  // repair. Best-effort: `resolveFindingThreads` never throws, but we still
  // wrap it so even a programming error here cannot break the `@codex review`
  // re-request / state transition below. Uses `config.githubToken`
  // (`pull-requests:write`), NOT the push token. Runs before the re-request so
  // the threads are already resolved when the next Codex review arrives. Reads
  // the original `state` ids (waitingState cleared them).
  try {
    await deps.resolveFindingThreads({
      owner: config.repoOwner,
      repo: config.repoName,
      prNumber: config.prNumber,
      commentIds: state.currentIterationFindingCommentIds,
      token: config.githubToken,
    });
  } catch (resolveError) {
    deps.warning(
      `[post-fix] Unexpected error resolving fixed review threads (continuing): ${
        resolveError instanceof Error ? resolveError.message : String(resolveError)
      }`,
    );
  }

  deps.info("[post-fix] Posting @codex review request...");
  // TY-334: capture the baseline before posting so any Codex activity that
  // arrives between the post and the poll window is treated as an ACK.
  const codexRequestedAt = new Date().toISOString();
  try {
    const reviewRequestId = await deps.postCodexReviewRequest(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      config.codexReviewRequestToken,
    );
    const updatedWaitingState: ReviewState = {
      ...waitingState,
      lastCodexRequestCommentId: reviewRequestId,
    };
    // TY-286 #A: the 2nd write only records `lastCodexRequestCommentId` for
    // idempotency. The hidden state was already advanced to `waiting_codex`
    // by the 1st write and the `@codex review` comment has been posted, so
    // the loop is healthy regardless of this write's outcome. Surfacing a
    // `state_conflict` ⚠️ stop here would falsely tell operators the
    // LoopPilot halted while it is actually still waiting for the next
    // Codex review trigger.
    //
    // A 412 is handled informationally by the `onConflict` warn below. A
    // non-412 transient error (5xx / 429 / network), however, makes
    // `updateStateCommentLocked` re-throw — and because this call sits inside
    // the outer `try` that wraps the `@codex review` post, the throw would land
    // in the catch below and falsely demote a healthy `waiting_codex` loop to
    // `stopped/codex_request_failed`, claiming the review post failed even
    // though it succeeded. Catch it here and treat it the same as the 412 path:
    // warn and return, leaving the state at `waiting_codex` for the next Codex
    // review trigger to reconcile.
    let requestIdPersisted: boolean;
    try {
      requestIdPersisted = await updateStateCommentLocked(
        updatedWaitingState,
        "Could not persist the Codex review request comment id.",
        {
          onConflict: async (detail) => {
            deps.warning(
              `[post-fix] ${detail} LoopPilot state remains waiting_codex; ` +
                "the next Codex review trigger will reconcile.",
            );
          },
        },
      );
    } catch (recordError) {
      const message =
        recordError instanceof Error ? recordError.message : String(recordError);
      deps.warning(
        `[post-fix] Failed to persist the Codex review request comment id (non-conflict error): ${message}. ` +
          "The repair commit is pushed and @codex review was posted; LoopPilot state remains waiting_codex and the next Codex review trigger will reconcile.",
      );
      return;
    }
    if (!requestIdPersisted) {
      return;
    }

    // TY-334: poll for a Codex ACK (👀 reaction or new Codex activity) while
    // this job is still alive; repost up to CODEX_ACK_MAX_REPOSTS times if the
    // request is silently dropped. On exhaustion, demote to
    // stopped/codex_request_failed (reusing the TY-273 #B5 path below) so the
    // loop is not wedged at waiting_codex with no restart trigger. The pushed
    // repair commit is preserved on the branch regardless.
    const ack = await deps.ensureCodexAck({
      owner: config.repoOwner,
      repo: config.repoName,
      pr: config.prNumber,
      commentId: reviewRequestId,
      requestedAt: codexRequestedAt,
      codexBotLogin: config.codexBotLogin,
      readToken: config.githubToken,
      token: config.codexReviewRequestToken,
      timeoutSeconds: config.codexAckTimeoutSeconds,
      pollIntervalSeconds: config.codexAckPollIntervalSeconds,
      maxReposts: config.codexAckMaxReposts,
    });
    if (!ack.acked) {
      const stoppedState: ReviewState = {
        ...updatedWaitingState,
        lastCodexRequestCommentId: ack.lastCommentId,
        status: "stopped",
        stopReason: "codex_request_failed",
      };
      if (
        !(await updateStateCommentLocked(
          stoppedState,
          "Could not record codex_request_failed stop after no Codex ACK.",
          {
            onConflict: async (detail) => {
              deps.warning(
                `[post-fix] ${detail} State was advanced by a concurrent run; ACK-demotion write skipped.`,
              );
            },
          },
        ))
      ) {
        return;
      }
      try {
        await deps.postStopComment(
          config.repoOwner,
          config.repoName,
          config.prNumber,
          "codex_request_failed",
          inputs.triggerCommentId,
          0,
          `Codex did not acknowledge the @codex review request after ${config.codexAckMaxReposts} repost(s) (≈${config.codexAckTimeoutSeconds}s per attempt). The repair commit is preserved on the branch; run /restart-review once Codex is reachable to resume.`,
          config.githubToken,
          deriveIterationProgress(stoppedState, config.maxReviewIterations),
        );
      } catch (notifyError) {
        const msg =
          notifyError instanceof Error ? notifyError.message : String(notifyError);
        deps.warning(
          `[post-fix] Demoted to stopped/codex_request_failed after no Codex ACK but failed to post the stop notification: ${msg}.`,
        );
      }
      return;
    }
    if (ack.reposts > 0 && ack.lastCommentId !== reviewRequestId) {
      // Best-effort: record the latest @codex review comment id after reposts.
      // A failure here is harmless — the state is already waiting_codex and the
      // reposted request has been posted — so swallow it rather than letting it
      // reach the outer catch, which would wrongly demote an ACKed loop to
      // codex_request_failed.
      try {
        await updateStateCommentLocked(
          { ...updatedWaitingState, lastCodexRequestCommentId: ack.lastCommentId },
          "Could not persist the reposted Codex review request comment id.",
          {
            onConflict: async (detail) => {
              deps.warning(
                `[post-fix] ${detail} Auto-review state remains waiting_codex; ` +
                  "the next Codex review trigger will reconcile.",
              );
            },
          },
        );
      } catch (repostWriteError) {
        const msg =
          repostWriteError instanceof Error
            ? repostWriteError.message
            : String(repostWriteError);
        deps.warning(
          `[post-fix] Failed to persist the reposted Codex review request id ${ack.lastCommentId}: ${msg}. ` +
            "Auto-review state remains waiting_codex; the next Codex review trigger will reconcile.",
        );
      }
    }
    deps.info(
      `[post-fix] Phase 4 complete. Status: waiting_codex. Review request: ${ack.lastCommentId}`,
    );
  } catch (error) {
    // TY-273 #B5: when @codex review re-request fails, leaving status at
    // `waiting_codex` with the stale `lastCodexRequestCommentId` deadlocks
    // the loop (no new Codex review will arrive, no trigger fires). Downgrade
    // to `stopped/codex_request_failed` so `postTerminalNotification` surfaces
    // a top-level comment and operators can `/restart-review` once Codex is
    // reachable again. The committed repair is preserved on the branch — we
    // only roll back the *pending* re-review request.
    const message = error instanceof Error ? error.message : String(error);
    deps.error(
      `[post-fix] Failed to post Codex review request: ${message}. Downgrading to stopped/codex_request_failed.`,
    );
    const stoppedState: ReviewState = {
      ...waitingState,
      status: "stopped",
      stopReason: "codex_request_failed",
    };
    if (
      !(await updateStateCommentLocked(
        stoppedState,
        "Could not record codex_request_failed stop.",
      ))
    ) {
      return;
    }
    await deps.postStopComment(
      config.repoOwner,
      config.repoName,
      config.prNumber,
      "codex_request_failed",
      inputs.triggerCommentId,
      0,
      `Failed to post @codex review after the repair commit: ${message}`,
      config.githubToken,
      deriveIterationProgress(stoppedState, config.maxReviewIterations),
    );
  }
}

async function run(): Promise<void> {
  await runPostFix(loadInitConfig());
}

runIfNotVitest(run, () => demoteFixingOnCrash("post-fix"));
