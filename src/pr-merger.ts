import { setTimeout as sleep } from "node:timers/promises";
import type { AutoMergeSkipKind } from "./comment-poster.js";
import { ghApi } from "./gh.js";

export interface MergerLogger {
  info: (message: string) => void;
  warning: (message: string) => void;
}

export type { AutoMergeSkipKind } from "./comment-poster.js";

/**
 * Workflow run subset that `mergeIfChecksPass` cares about. Mirrors the
 * shape returned by `GET /repos/{owner}/{repo}/actions/runs?head_sha=…`.
 */
export interface WorkflowRunSummary {
  id: number;
  /** Stable numeric identifier for the workflow definition (file). Two runs of the same
   * workflow file share the same workflow_id even if the display name is changed. */
  workflow_id: number;
  name: string;
  /** Relative path of the workflow file, e.g. `.github/workflows/ci.yml`. Unique per workflow
   * file; two files that share the same display name will have different paths. */
  path?: string;
  /** queued, in_progress, completed, waiting, requested, pending. */
  status: string;
  /** success, failure, cancelled, neutral, skipped, timed_out, action_required, startup_failure, stale, or null. */
  conclusion: string | null;
  head_sha: string;
  /** GitHub event that triggered this run (e.g. push, pull_request, workflow_dispatch). */
  event: string;
}

/**
 * ES-426 #2: a check run from `GET /repos/{owner}/{repo}/commits/{ref}/check-runs`.
 * External CI providers (CircleCI, Jenkins, …) integrate via the Checks API as
 * GitHub Apps and are NOT visible in `/actions/runs`. GitHub Actions jobs ALSO
 * appear here (app slug `github-actions`) but are already covered — and
 * self-excluded — by the workflow-runs path, so the merge gate consults only
 * non-`github-actions` check runs to avoid double-counting and, critically, to
 * avoid the loop's own in-progress job blocking its own merge.
 */
export interface CheckRunSummary {
  name: string;
  /** queued | in_progress | completed. */
  status: string;
  /** success | failure | neutral | cancelled | timed_out | action_required | stale | skipped | null. */
  conclusion: string | null;
  /** The integrating GitHub App's slug, e.g. "github-actions", "circleci". */
  appSlug: string;
}

export interface MergerDeps {
  /** Returns the PR's current HEAD sha. */
  getPrHeadSha: (owner: string, name: string, pr: number, token: string) => Promise<string>;
  /**
   * Returns the PR's current merge commit sha, or null when unavailable.
   * `pull_request`/`pull_request_review` CI runs index themselves under this
   * sha rather than the head branch sha, so we must query both to avoid
   * missing those runs.
   */
  getPrMergeSha?: (owner: string, name: string, pr: number, token: string) => Promise<string | null>;
  /** Returns all workflow runs that target the given commit. */
  listWorkflowRuns: (
    owner: string,
    name: string,
    sha: string,
    token: string,
  ) => Promise<WorkflowRunSummary[]>;
  /**
   * ES-426 #2: returns the check runs on the given commit (external CI via the
   * Checks API). Optional: when absent, the merge gate considers only
   * `/actions/runs` (the pre-ES-426 behaviour). `mergeIfChecksPass` filters out
   * `github-actions` check runs (already covered by listWorkflowRuns) and gates
   * on the remaining external ones.
   */
  listCheckRuns?: (
    owner: string,
    name: string,
    sha: string,
    token: string,
  ) => Promise<CheckRunSummary[]>;
  /**
   * Runs `gh pr merge <pr> --auto --squash --match-head-commit <sha> --repo …`.
   * Throws on failure. `expectedHeadSha` is the sha we verified the CI on;
   * `--match-head-commit` makes GitHub refuse the merge if HEAD moved
   * between our last poll and this call (race between push and merge).
   * `--auto` queues the merge when required checks are still pending (e.g.,
   * when this workflow is itself a required status check); GitHub executes the
   * queued merge once all required checks pass.
   *
   * Prerequisite (TY-288): Repository Settings → General → "Allow auto-merge"
   * must be enabled. When disabled, `gh pr merge --auto` fails immediately
   * with "Pull request merging is not enabled for this repository" and
   * `mergeIfChecksPass` skips with a warning + a `merge_call_failed` PR
   * notification (TY-295) so operators see the prerequisite directly on
   * the PR. The docs (`docs/operations/stop-and-recovery.md` and the
   * README input table) surface this so operators don't get stuck
   * wondering why auto-merge "isn't firing" on a clean run.
   */
  mergeSquash: (
    owner: string,
    name: string,
    pr: number,
    expectedHeadSha: string,
    token: string,
  ) => Promise<void>;
  /** Sleep helper (overridden in tests). */
  sleep: (ms: number) => Promise<void>;
  /** Wall-clock source for the timeout budget. */
  now: () => number;
  /**
   * `GITHUB_RUN_ID` of the loop-pilot run invoking this. The matching
   * workflow run is excluded from the pending / failure check so the loop
   * does not wait for itself. Empty string disables self-exclusion.
   */
  selfRunId: string;
  /**
   * `GITHUB_WORKFLOW` name of the loop-pilot workflow. Used to exclude
   * all previous loop runs when the current run is not found by its run ID
   * (e.g. issue_comment triggers set GITHUB_SHA to the default-branch commit,
   * so the current run is absent from PR head/merge-sha run queries). Empty
   * string disables this name-based fallback.
   */
  selfWorkflowName: string;
  /**
   * Workflow file path extracted from `GITHUB_WORKFLOW_REF`
   * (e.g. `.github/workflows/looppilot-loop.yml`). When non-empty, used
   * together with `selfWorkflowName` in the name-based fallback to
   * disambiguate workflows that share the same display name but live in
   * different files.  Empty string falls back to name-only matching.
   */
  selfWorkflowPath: string;
  /** Poll interval between check-status reads. */
  pollIntervalMs: number;
  /** Hard budget for the entire wait. Skip + warn after this elapses. */
  timeoutMs: number;
  /**
   * Minimum wall-clock time that must elapse before treating `!hasCi` (no
   * workflow runs AND no external check runs) as "no CI configured" and merging.
   * Guards against premature merges in environments where CI registration
   * takes longer than a couple of poll intervals (self-hosted runner
   * cold-start, large `workflow_run` provenance chains, actions/runs API
   * replication lag). Default {@link DEFAULT_NO_CI_DELAY_MS} (60s).
   */
  noCiConfiguredDelayMs: number;
  /**
   * Best-effort PR notification for skip events (TY-295). When absent
   * (e.g. unit tests not exercising the notification path), the eleven
   * skip paths in `mergeIfChecksPass` stay warning-only. Production
   * wiring in `main-pre-fix.ts` passes a binding of
   * `postAutoMergeSkipNotification` so operators can see why auto-merge
   * did not happen directly from the PR instead of digging through
   * Actions logs. The hook is awaited but failures must not propagate —
   * the production implementation swallows errors internally and emits
   * `core.warning` so the skip decision itself is never blocked by a
   * notification problem.
   */
  postSkipNotification?: (kind: AutoMergeSkipKind) => Promise<void>;
}

/**
 * Conclusions that we treat as "CI failed" and refuse to auto-merge.
 *
 * `cancelled` is included because operators routinely cancel runs they no
 * longer trust; auto-merging a PR with a cancelled required job would be
 * surprising. `action_required` and `startup_failure` indicate the run
 * could not produce a verdict and must not be silently treated as green.
 */
const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
]);

/**
 * ES-426 #2: "blocking rank" of a check run, used to dedup the same external
 * check appearing on both the head and merge refs — keep the most-blocking
 * (failed > pending > green) so a green head check cannot mask a pending or
 * failed merge-ref check.
 */
function rankCheck(c: CheckRunSummary): number {
  if (c.conclusion !== null && FAILED_CONCLUSIONS.has(c.conclusion)) return 2;
  if (c.status !== "completed") return 1;
  return 0;
}

export const DEFAULT_AUTO_MERGE_POLL_INTERVAL_MS = 15 * 1000;
export const DEFAULT_AUTO_MERGE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_NO_CI_DELAY_MS = 60 * 1000;

function defaultMergerDeps(overrides: Partial<MergerDeps> = {}): MergerDeps {
  return {
    getPrHeadSha: async (owner, name, pr, token) => {
      const stdout = await ghApi(
        [
          "api",
          `/repos/${owner}/${name}/pulls/${pr}`,
          "--jq",
          ".head.sha",
        ],
        token,
      );
      return stdout.trim();
    },
    getPrMergeSha: async (owner, name, pr, token) => {
      const stdout = await ghApi(
        [
          "api",
          `/repos/${owner}/${name}/pulls/${pr}`,
          "--jq",
          ".merge_commit_sha // empty",
        ],
        token,
      );
      const trimmed = stdout.trim();
      return trimmed || null;
    },
    listWorkflowRuns: async (owner, name, sha, token) => {
      // `--paginate` follows Link headers so PRs with > 100 workflow runs
      // still surface every failure / pending entry. Without it a failure on
      // page 2+ would be invisible and re-introduce the merge-through-CI
      // bypass this guard exists to prevent.
      //
      // `gh api --paginate` concatenates each page's JSON object verbatim
      // (one object per line of stdout when the response is an object).
      // Use `--jq` to extract `workflow_runs[]` from every page and rebuild
      // the array on our side, which works regardless of how `gh` decides
      // to concatenate the page envelopes.
      const stdout = await ghApi(
        [
          "api",
          "--paginate",
          `/repos/${owner}/${name}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`,
          "--jq",
          ".workflow_runs[]",
        ],
        token,
      );
      const runs: WorkflowRunSummary[] = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          runs.push(JSON.parse(trimmed) as WorkflowRunSummary);
        } catch {
          // A line we cannot parse could be a pending/failed run; dropping it
          // would make the gate fail open.  Throw so the caller aborts the
          // merge with a warning (fail-closed).
          throw new Error(`Failed to parse workflow-run record: ${trimmed}`);
        }
      }
      return runs;
    },
    listCheckRuns: async (owner, name, sha, token) => {
      // The check-runs endpoint returns `{ total_count, check_runs: [...] }`.
      // `--paginate` + `--jq ".check_runs[]"` rebuilds the array across pages,
      // same pattern as listWorkflowRuns. `.app.slug` identifies the integrating
      // App so the caller can exclude github-actions (self-coverage).
      const stdout = await ghApi(
        [
          "api",
          "--paginate",
          // `filter=latest` (the API default, pinned explicitly) returns only
          // the most recent run per check name, so a stale failed re-run does
          // not over-block. Relying on the implicit default would silently
          // change behaviour if GitHub ever flips it to `all`.
          `/repos/${owner}/${name}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100&filter=latest`,
          "--jq",
          '.check_runs[] | {name: .name, status: .status, conclusion: .conclusion, appSlug: (.app.slug // "")}',
        ],
        token,
      );
      const checks: CheckRunSummary[] = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          checks.push(JSON.parse(trimmed) as CheckRunSummary);
        } catch {
          // Fail-closed, same rationale as listWorkflowRuns: an unparseable
          // line could be a failed/pending external check; dropping it would
          // make the gate fail open.
          throw new Error(`Failed to parse check-run record: ${trimmed}`);
        }
      }
      return checks;
    },
    mergeSquash: async (owner, name, pr, expectedHeadSha, token) => {
      await ghApi(
        [
          "pr",
          "merge",
          String(pr),
          "--auto",
          "--squash",
          "--match-head-commit",
          expectedHeadSha,
          "--repo",
          `${owner}/${name}`,
        ],
        token,
      );
    },
    sleep: (ms) => sleep(ms),
    now: () => Date.now(),
    selfRunId: process.env.GITHUB_RUN_ID ?? "",
    selfWorkflowName: process.env.GITHUB_WORKFLOW ?? "",
    selfWorkflowPath: (() => {
      // GITHUB_WORKFLOW_REF has the form "owner/repo/.github/workflows/ci.yml@refs/…".
      // Extract just the path segment so we can match against WorkflowRunSummary.path.
      const ref = process.env.GITHUB_WORKFLOW_REF ?? "";
      const m = ref.match(/^[^/]+\/[^/]+\/(.+)@/);
      return m ? m[1] : "";
    })(),
    pollIntervalMs: DEFAULT_AUTO_MERGE_POLL_INTERVAL_MS,
    timeoutMs: DEFAULT_AUTO_MERGE_TIMEOUT_MS,
    noCiConfiguredDelayMs: DEFAULT_NO_CI_DELAY_MS,
    ...overrides,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Auto-merge guard (TY-277).
 *
 * Replaces the previous `enableAutoMergeSquash` path that delegated CI gating
 * to GitHub's native auto-merge: `gh pr merge --auto` only waits for required
 * checks defined in branch protection, so a repo without required-check
 * configuration would silently merge through a failing CI.
 *
 * Behaviour:
 *   1. Read the PR's current HEAD sha.
 *   2. List workflow runs targeting that sha; exclude the run hosting this
 *      pre-/post-fix step (`GITHUB_RUN_ID`).
 *   3. If any non-self run has a failed conclusion → skip + warn.
 *   4. If all non-self runs are completed (none failed) → `gh pr merge --squash`
 *      and return.
 *   5. Otherwise (something still pending) → sleep `pollIntervalMs` and
 *      revisit. Before each poll, re-read the HEAD sha and bail with a warning
 *      if it changed (a human pushed a new commit while we were waiting; the
 *      old CI verdict no longer reflects what would be merged).
 *   6. If the wait exceeds `timeoutMs`, skip + warn.
 *
 * All failure paths are non-fatal: the workflow finishes `success` and a
 * human can merge manually. The cost of refusing to merge is low; the cost
 * of merging through a failing CI is high.
 */
export async function mergeIfChecksPass(
  owner: string,
  name: string,
  pr: number,
  token: string,
  log: MergerLogger,
  overrides: Partial<MergerDeps> = {},
): Promise<void> {
  const deps = defaultMergerDeps(overrides);

  let initialHeadSha: string;
  try {
    initialHeadSha = await deps.getPrHeadSha(owner, name, pr, token);
  } catch (err) {
    await deps.postSkipNotification?.({
      kind: "transient_error",
      detail: `failed to read PR HEAD sha (${errMessage(err)})`,
    });
    log.warning(
      `[pr-merger] Skipping auto-merge for PR #${pr}: failed to read PR HEAD sha (${errMessage(err)}).`,
    );
    return;
  }
  if (initialHeadSha === "") {
    await deps.postSkipNotification?.({ kind: "head_empty" });
    log.warning(
      `[pr-merger] Skipping auto-merge for PR #${pr}: empty HEAD sha.`,
    );
    return;
  }

  log.info(
    `[pr-merger] Auto-merge check for PR #${pr} at ${initialHeadSha} (poll ${Math.round(deps.pollIntervalMs / 1000)}s, timeout ${Math.round(deps.timeoutMs / 60000)} min).`,
  );

  const startedAt = deps.now();
  let pollCount = 0;

  while (true) {
    if (pollCount > 0) {
      // Re-read HEAD sha so a new push during the wait aborts the auto-merge
      // instead of using stale CI evidence.
      let currentSha: string;
      try {
        currentSha = await deps.getPrHeadSha(owner, name, pr, token);
      } catch (err) {
        await deps.postSkipNotification?.({
          kind: "transient_error",
          detail: `failed to re-read PR HEAD during polling (${errMessage(err)})`,
        });
        log.warning(
          `[pr-merger] Skipping auto-merge for PR #${pr}: failed to re-read PR HEAD during polling (${errMessage(err)}).`,
        );
        return;
      }
      if (currentSha !== initialHeadSha) {
        await deps.postSkipNotification?.({
          kind: "head_changed",
          oldSha: initialHeadSha,
          newSha: currentSha,
        });
        log.warning(
          `[pr-merger] Skipping auto-merge for PR #${pr}: PR HEAD changed during CI wait (${initialHeadSha} → ${currentSha}). The new commit needs its own review/CI cycle; re-trigger via /restart-review.`,
        );
        return;
      }
    }

    let runs: WorkflowRunSummary[];
    try {
      runs = await deps.listWorkflowRuns(owner, name, initialHeadSha, token);
    } catch (err) {
      await deps.postSkipNotification?.({
        kind: "transient_error",
        detail: `failed to list workflow runs (${errMessage(err)})`,
      });
      log.warning(
        `[pr-merger] Skipping auto-merge for PR #${pr}: failed to list workflow runs (${errMessage(err)}).`,
      );
      return;
    }

    // Re-read the merge commit sha each iteration so that base-branch moves
    // (which change the merge ref even when PR HEAD is unchanged) are reflected
    // in the run query rather than evaluated against a stale sha.
    let mergeSha: string | null = null;
    // True when getPrMergeSha is available but returned null/empty, meaning
    // GitHub has not yet computed the merge commit sha (transient state).
    // While this flag is set we must not apply the "two empty polls = no CI"
    // shortcut: repos whose CI runs only on the pull_request merge ref would
    // produce zero runs for the head sha during this window and could be
    // merged prematurely.
    let mergeShaLookupNull = false;
    if (deps.getPrMergeSha) {
      try {
        const ms = await deps.getPrMergeSha(owner, name, pr, token);
        if (ms && ms !== initialHeadSha) {
          mergeSha = ms;
        } else if (!ms) {
          mergeShaLookupNull = true;
        }
      } catch (err) {
        await deps.postSkipNotification?.({
          kind: "transient_error",
          detail: `failed to read PR merge commit sha (${errMessage(err)})`,
        });
        log.warning(
          `[pr-merger] Skipping auto-merge for PR #${pr}: failed to read PR merge commit sha (${errMessage(err)}).`,
        );
        return;
      }
    }

    // Combine with runs indexed under the merge commit sha (pull_request CI).
    let allRuns = runs;
    if (mergeSha) {
      let mergeRuns: WorkflowRunSummary[];
      try {
        mergeRuns = await deps.listWorkflowRuns(owner, name, mergeSha, token);
      } catch (err) {
        await deps.postSkipNotification?.({
          kind: "transient_error",
          detail: `failed to list workflow runs (${errMessage(err)})`,
        });
        log.warning(
          `[pr-merger] Skipping auto-merge for PR #${pr}: failed to list workflow runs (${errMessage(err)}).`,
        );
        return;
      }
      const seenIds = new Set(runs.map((r) => r.id));
      allRuns = [...runs];
      for (const r of mergeRuns) {
        if (!seenIds.has(r.id)) allRuns.push(r);
      }
    }

    // ES-426 #2: external CI (CircleCI/Jenkins/… via the Checks API) is invisible
    // to /actions/runs, so gate on non-github-actions check runs too. Fetched for
    // head + merge sha and deduped by name+appSlug (a given external check has one
    // entry per sha; the same check reported on both refs is the same check). Only
    // external checks are kept — github-actions check runs duplicate the
    // self-excluded workflow runs and the loop's own in-progress job would
    // otherwise block its own merge. Fail-closed on fetch error like the
    // workflow-runs path: refusing to merge when external CI cannot be verified.
    let externalChecks: CheckRunSummary[] = [];
    if (deps.listCheckRuns) {
      try {
        const headChecks = await deps.listCheckRuns(owner, name, initialHeadSha, token);
        const mergeChecks = mergeSha
          ? await deps.listCheckRuns(owner, name, mergeSha, token)
          : [];
        const byKey = new Map<string, CheckRunSummary>();
        for (const c of [...headChecks, ...mergeChecks]) {
          if (c.appSlug === "github-actions") continue;
          // Keep the most "blocking" entry per check when it appears on both
          // refs: prefer a pending/failed status over a completed/success one so
          // a green head check cannot mask a still-pending merge-ref check.
          const key = `${c.appSlug}:${c.name}`;
          const existing = byKey.get(key);
          if (existing === undefined || rankCheck(c) > rankCheck(existing)) {
            byKey.set(key, c);
          }
        }
        externalChecks = Array.from(byKey.values());
      } catch (err) {
        await deps.postSkipNotification?.({
          kind: "transient_error",
          detail: `failed to list check runs (${errMessage(err)})`,
        });
        log.warning(
          `[pr-merger] Skipping auto-merge for PR #${pr}: failed to list check runs (${errMessage(err)}).`,
        );
        return;
      }
    }

    // Exclude the loop-pilot workflow entirely (not just the current run)
    // so that previous loop attempts on the same commit (e.g. transient infra
    // failures that left a `failure`/`cancelled` conclusion) do not permanently
    // block auto-merge. We identify the loop's workflow by the workflow_id of
    // the current run; if the current run isn't in the list (e.g. issue_comment
    // triggers set GITHUB_SHA to the default-branch commit, not the PR HEAD SHA,
    // so the current run is absent from the head/merge-sha run queries), infer
    // our workflow's id from a stale loop run visible in the list. workflow_id
    // is a stable numeric identifier per workflow file and is unique across
    // different files even when they share the same display name, so filtering
    // by it avoids incorrectly excluding a different workflow that happens to
    // have the same name as the loop workflow.
    const selfWorkflowId = deps.selfRunId !== ""
      ? allRuns.find((r) => String(r.id) === deps.selfRunId)?.workflow_id
      : undefined;

    const others: WorkflowRunSummary[] = selfWorkflowId !== undefined
      ? allRuns.filter((r) => r.workflow_id !== selfWorkflowId)
      : deps.selfRunId !== "" && deps.selfWorkflowName !== ""
        ? (() => {
            // Self run absent from list (e.g. issue_comment trigger). Infer our
            // workflow's stable id from the first matching stale run. When
            // selfWorkflowPath is available (from GITHUB_WORKFLOW_REF) we
            // require the run's path to match as well, so a different workflow
            // file that happens to share the same display name is not
            // incorrectly identified as ours and excluded.
            const inferredId = allRuns.find((r) =>
              r.name === deps.selfWorkflowName &&
              (deps.selfWorkflowPath === "" || (r.path !== undefined && r.path.replace(/@.*$/, "") === deps.selfWorkflowPath))
            )?.workflow_id;
            return inferredId !== undefined
              ? allRuns.filter((r) => r.workflow_id !== inferredId)
              : allRuns;
          })()
        : deps.selfRunId !== ""
          ? allRuns.filter((r) => String(r.id) !== deps.selfRunId)
          : allRuns;

    // Keep only the latest run per (workflow_id, event) pair so that an older
    // failed run that was subsequently re-triggered succeeding does not
    // permanently block auto-merge. Re-runs share the same event type as the
    // original run, so they're collapsed correctly. Two concurrent runs of the
    // same workflow file triggered by *different* events (e.g. push and
    // pull_request) are treated as independent entries and both evaluated —
    // collapsing them by workflow_id alone would allow a failure on one event
    // to be hidden by a success on another, making this gate fail-open.
    const latestByWorkflowAndEvent = new Map<string, WorkflowRunSummary>();
    for (const r of others) {
      const key = `${r.workflow_id}:${r.event}`;
      const existing = latestByWorkflowAndEvent.get(key);
      if (!existing || r.id > existing.id) {
        latestByWorkflowAndEvent.set(key, r);
      }
    }
    const deduped = Array.from(latestByWorkflowAndEvent.values());

    // ES-426 #2: evaluate GitHub Actions workflow runs AND external check runs
    // (CircleCI/Jenkins/…) together. `hasCi` gates the "no CI configured"
    // fast-path so a repo whose ONLY signal is an external check is not merged
    // before that check reports.
    const hasCi = deduped.length > 0 || externalChecks.length > 0;
    const failed: Array<{ name: string; conclusion: string | null }> = [
      ...deduped.filter(
        (r) => r.conclusion !== null && FAILED_CONCLUSIONS.has(r.conclusion),
      ),
      ...externalChecks.filter(
        (c) => c.conclusion !== null && FAILED_CONCLUSIONS.has(c.conclusion),
      ),
    ];
    if (failed.length > 0) {
      const names = failed
        .map((r) => `${r.name} (${r.conclusion})`)
        .join(", ");
      await deps.postSkipNotification?.({
        kind: "ci_failed",
        failures: failed.map((r) => ({
          name: r.name,
          conclusion: r.conclusion ?? "unknown",
        })),
      });
      log.warning(
        `[pr-merger] Skipping auto-merge for PR #${pr}: ${failed.length} CI run(s) failed: ${names}.`,
      );
      return;
    }

    const pending: Array<{ name: string }> = [
      ...deduped.filter((r) => r.status !== "completed"),
      ...externalChecks.filter((c) => c.status !== "completed"),
    ];
    // P2: merge when all current runs are complete (no pending). If there are
    // no non-self runs yet, wait at least `noCiConfiguredDelayMs` of wall-clock
    // time before treating their absence as "no CI configured" and merging.
    // A poll-count threshold alone (the previous `pollCount >= 2`) fires after
    // ~2×pollIntervalMs (~30s), which is shorter than CI registration on slow
    // self-hosted runners / large workflow_run chains / actions/runs API
    // replication lag — risking a merge before a required check appears (TY-308).
    const elapsedMs = deps.now() - startedAt;
    if (elapsedMs >= deps.timeoutMs) {
      const timeoutMinutes = Math.round(deps.timeoutMs / 60000);
      // TY-330: this timeout gate is evaluated BEFORE the normal merge gate
      // (`pending.length === 0`, below). If CI completes green on the same poll
      // the timeout elapses, falling through here would skip a fully-mergeable
      // PR with a misleading `timeout_pending` notification carrying an empty
      // pending list. When every non-self run is complete and green, let the
      // merge win — failures were already rejected at the `failed.length > 0`
      // gate above, and `!mergeShaLookupNull` confirms GitHub settled the merge
      // ref. The no-CI (`!hasCi`) case keeps its own dedicated handling below.
      if (hasCi && pending.length === 0 && !mergeShaLookupNull) {
        try {
          await deps.mergeSquash(owner, name, pr, initialHeadSha, token);
          log.info(
            `[pr-merger] Auto-merge (squash) succeeded for PR #${pr} at ${initialHeadSha} (all non-self CI green as the ${timeoutMinutes} min timeout elapsed).`,
          );
        } catch (err) {
          await deps.postSkipNotification?.({
            kind: "merge_call_failed",
            detail: errMessage(err),
          });
          log.warning(
            `[pr-merger] Failed to merge PR #${pr} (non-fatal): ${errMessage(err)}.`,
          );
        }
        return;
      }
      if (!hasCi) {
        // TY-328: no non-self CI run ever appeared within the full timeout
        // budget. The fast-path no-CI merge below only fires once
        // `elapsedMs >= noCiConfiguredDelayMs` (default 60s); when the operator
        // configures `LOOPPILOT_AUTO_MERGE_TIMEOUT_MINUTES` at or below that
        // delay (the input minimum is 1 min == 60s), this timeout gate is
        // reached first and the fast path is never evaluated — so a genuinely
        // CI-less repo would skip auto-merge forever. Treat "waited the whole
        // budget, still zero non-self runs" as "no CI configured" and merge,
        // provided GitHub has already computed the merge commit sha
        // (`!mergeShaLookupNull`); otherwise CI may still be pending on the
        // merge ref, so fall through to the skip notification.
        if (!mergeShaLookupNull) {
          try {
            await deps.mergeSquash(owner, name, pr, initialHeadSha, token);
            log.info(
              `[pr-merger] Auto-merge (squash) succeeded for PR #${pr} at ${initialHeadSha} (no non-self CI appeared within the ${timeoutMinutes} min budget; treated as no CI configured).`,
            );
          } catch (err) {
            await deps.postSkipNotification?.({
              kind: "merge_call_failed",
              detail: errMessage(err),
            });
            log.warning(
              `[pr-merger] Failed to merge PR #${pr} (non-fatal): ${errMessage(err)}.`,
            );
          }
          return;
        }
        await deps.postSkipNotification?.({
          kind: "timeout_no_runs",
          timeoutMinutes,
        });
        log.warning(
          `[pr-merger] Skipping auto-merge for PR #${pr}: timed out after ${timeoutMinutes} min waiting for the merge commit sha to settle.`,
        );
      } else if (pending.length === 0) {
        // hasCi is true and pending is empty, yet the green-merge branch
        // above did not fire — so `mergeShaLookupNull` must be true (GitHub has
        // not produced a merge commit sha; the PR is likely unmergeable due to
        // base-branch conflicts). Reporting `timeout_pending` here would emit a
        // contradictory "0 CI run(s) still pending" message; surface the real
        // blocker instead. The skip itself is correct — refusing to merge a PR
        // with no settled merge commit is the safe outcome.
        await deps.postSkipNotification?.({
          kind: "merge_sha_unsettled",
          timeoutMinutes,
        });
        log.warning(
          `[pr-merger] Skipping auto-merge for PR #${pr}: timed out after ${timeoutMinutes} min — CI on HEAD is green but GitHub has not produced a merge commit (the PR may have base-branch conflicts).`,
        );
      } else {
        const pendingNames = pending.map((r) => r.name);
        await deps.postSkipNotification?.({
          kind: "timeout_pending",
          timeoutMinutes,
          pending: pendingNames,
        });
        log.warning(
          `[pr-merger] Skipping auto-merge for PR #${pr}: timed out after ${timeoutMinutes} min with ${pending.length} CI run(s) still pending: ${pendingNames.join(", ")}.`,
        );
      }
      return;
    }

    if (pending.length === 0 && !mergeShaLookupNull) {
      const elapsedSufficient =
        hasCi || elapsedMs >= deps.noCiConfiguredDelayMs;
      if (elapsedSufficient) {
        try {
          await deps.mergeSquash(owner, name, pr, initialHeadSha, token);
          log.info(
            `[pr-merger] Auto-merge (squash) succeeded for PR #${pr} at ${initialHeadSha}.`,
          );
        } catch (err) {
          await deps.postSkipNotification?.({
            kind: "merge_call_failed",
            detail: errMessage(err),
          });
          log.warning(
            `[pr-merger] Failed to merge PR #${pr} (non-fatal): ${errMessage(err)}.`,
          );
        }
        return;
      }
    }
    // !hasCi and elapsed < noCiConfiguredDelayMs: CI may not have
    // been queued yet; fall through to sleep and retry.

    pollCount += 1;
    if (!hasCi) {
      log.info(
        `[pr-merger] Waiting for non-self CI runs to appear for PR #${pr} (poll ${pollCount}).`,
      );
    } else {
      const pendingNames = pending.map((r) => r.name).join(", ");
      log.info(
        `[pr-merger] Waiting for ${pending.length} CI run(s) on PR #${pr} (poll ${pollCount}): ${pendingNames}.`,
      );
    }
    await deps.sleep(deps.pollIntervalMs);
  }
}
