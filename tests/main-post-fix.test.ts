import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import {
  countUntrackedAddedLines,
  decodeLsFilesPath,
  logSecretScanWarnings,
  runPostFix,
  SECRET_WARN_LOG_CAP,
  type PostFixDeps,
  type PostFixInputs,
} from "../src/main-post-fix.js";
import type { SecretScanFinding, SecretScanResult } from "../src/secret-scanner.js";
import {
  StateUpdateConflictError,
  createInitialState,
} from "../src/state-manager.js";
import type { ReadStateResult } from "../src/state-manager.js";
import type { ReviewState } from "../src/types.js";

const baseConfig: Config = {
  maxReviewIterations: 20,
  debounceSeconds: 0,
  checkCommand: "npm run check",
  buildCommand: "",
  codexBotLogin: "chatgpt-codex-connector[bot]",
  stabilizeIntervalSeconds: 1,
  stabilizeCount: 1,
  codexReviewRequestToken: "codex-token",
  autoReviewPushToken: "",
  anthropicApiKey: "",
  claudeCodeOauthToken: "",
  githubToken: "github-token",
  repoOwner: "edereship",
  repoName: "loop-pilot",
  prNumber: 99,
  triggerCommentId: 1234,
  triggerCommentBody: "",
  triggerUserLogin: "",
  triggerEventName: "",
  prHeadRef: "linear/TY-237",
  prTitle: "TY-237",
  autoReviewLabel: "loop-pilot",
  autoReviewFullAuto: false,
  autoReviewRestartRoles: "author,write,maintain,admin",
  claudeCodeModelBase: "claude-sonnet-4-6",
  claudeCodeModelEscalated: "claude-opus-4-6",
  autoMergeOnClean: false,
  autoMergePollSeconds: 15,
  autoMergeTimeoutMinutes: 10,
  severityThreshold: "P2",
  autoReviewBlockPaths: "",
  scopeMaxFiles: 0,
  scopeMaxLines: 0,
  autoRetryEscalateMaxTurns: false,
  codexAckTimeoutSeconds: 90,
  codexAckPollIntervalSeconds: 15,
  codexAckMaxReposts: 2,
};

const baseInputs: PostFixInputs = {
  commentId: 100,
  iteration: 2,
  checkCommand: "npm run check",
  prHeadRef: "linear/TY-237",
  triggerCommentId: 1234,
  actionOutcome: "success",
  actionExecutionFile: "",
};

function makeState(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    ...createInitialState(),
    status: "fixing",
    iterationCount: 2,
    findingsHashHistory: [
      { iteration: 1, hash: "aaaaaaaaaaaaaaaa" },
      { iteration: 2, hash: "bbbbbbbbbbbbbbbb" },
    ],
    lastFindingsHash: "bbbbbbbbbbbbbbbb",
    ...overrides,
  };
}

interface DepRecord {
  readonly resetCalls: number;
  readonly stagedPaths: string[][];
  readonly commitMessages: string[];
  readonly pushCalls: Array<{ owner: string; repo: string; ref: string; token: string }>;
  readonly intentToAddCalls: string[][];
  readonly resetIntentToAddCalls: string[][];
}

function makeDeps(
  readResult: ReadStateResult,
  overrides: Partial<PostFixDeps> = {},
): PostFixDeps & DepRecord {
  const counters = {
    resetCalls: 0,
    stagedPaths: [] as string[][],
    commitMessages: [] as string[],
    pushCalls: [] as Array<{ owner: string; repo: string; ref: string; token: string }>,
    intentToAddCalls: [] as string[][],
    resetIntentToAddCalls: [] as string[][],
  };
  const deps: PostFixDeps = {
    readState: vi.fn().mockResolvedValue(readResult),
    updateStateComment: vi.fn().mockResolvedValue({ updatedAt: "2026-05-14T12:30:00Z" }),
    runCheckCommand: vi.fn().mockResolvedValue({ success: true, output: "ok" }),
    runBuildCommand: vi.fn().mockResolvedValue({ success: true, output: "" }),
    postClaudeCodeActionFixSummary: vi.fn().mockResolvedValue(11),
    postCodexReviewRequest: vi.fn().mockResolvedValue(22),
    postComment: vi.fn().mockResolvedValue(55),
    ensureCodexAck: vi.fn().mockResolvedValue({
      acked: true,
      reason: "eyes",
      reposts: 0,
      lastCommentId: 22,
    }),
    resolveFindingThreads: vi.fn().mockResolvedValue({
      resolved: 0,
      alreadyResolved: 0,
      failed: 0,
      unmatched: 0,
    }),
    postStopComment: vi.fn().mockResolvedValue(33),
    postTestFailureComment: vi.fn().mockResolvedValue(44),
    postTerminalNotification: vi.fn().mockResolvedValue(undefined),
    setSecret: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    setFailed: vi.fn(),
    demoteFixingOnCrash: vi.fn().mockResolvedValue(undefined),
    gitDiffNumstat: () => "5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n",
    gitDiffHead: () => "",
    gitListUntracked: () => "",
    readWorkingTreeFile: () => null,
    readHeadSha: () => "abc1234",
    resetWorkingTree: () => {
      counters.resetCalls += 1;
    },
    stagePaths: (paths) => {
      counters.stagedPaths.push([...paths]);
    },
    intentToAdd: (paths) => {
      counters.intentToAddCalls.push([...paths]);
    },
    resetIntentToAdd: (paths) => {
      counters.resetIntentToAddCalls.push([...paths]);
    },
    hasStagedChanges: () => true,
    commit: (msg) => {
      counters.commitMessages.push(msg);
    },
    push: (owner, repo, ref, token) => {
      counters.pushCalls.push({ owner, repo, ref, token });
    },
    readActionExecutionFile: () => null,
    ...overrides,
  };
  // Expose counters as live getters so post-call assertions see the latest
  // values; spreading a number snapshots it at definition time.
  return Object.defineProperties(deps, {
    resetCalls: { get: () => counters.resetCalls },
    stagedPaths: { get: () => counters.stagedPaths },
    commitMessages: { get: () => counters.commitMessages },
    pushCalls: { get: () => counters.pushCalls },
    intentToAddCalls: { get: () => counters.intentToAddCalls },
    resetIntentToAddCalls: { get: () => counters.resetIntentToAddCalls },
  }) as PostFixDeps & DepRecord;
}

describe("runPostFix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // TY-325 #D: a normal run where post-CHECK enumeration is non-empty (the
  // default gitDiffNumstat returns the same non-empty value on every call)
  // must still commit and re-request Codex review — the net-zero guard must
  // not fire here.
  it("commits, pushes, and transitions to waiting_codex on a clean run", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState({ previousCheckFailure: "stale tail" }),
    });

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.stagedPaths).toEqual([["src/foo.ts", "tests/foo.test.ts"]]);
    expect(deps.commitMessages[0]).toContain("(iteration 2)");
    expect(deps.pushCalls).toEqual([
      {
        owner: "edereship",
        repo: "loop-pilot",
        ref: "linear/TY-237",
        token: "",
      },
    ]);
    expect(deps.postClaudeCodeActionFixSummary).toHaveBeenCalled();
    expect(deps.postCodexReviewRequest).toHaveBeenCalled();
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({
        status: "waiting_codex",
        // TY-258: clean commit clears stopReason so escalation is one-shot.
        stopReason: null,
        previousCheckFailure: null,
        lastClaudeCommitSha: "abc1234",
      }),
      "github-token",
      expect.any(Object),
    );
  });

  it("TY-360: resolves the iteration's in-scope finding threads after a clean push (github-token)", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState({ currentIterationFindingCommentIds: [501, 502] }),
    });

    await runPostFix(baseConfig, deps, baseInputs);

    // Resolve is invoked with the in-scope finding ids from the (fixing) state
    // and the github-token (pull-requests:write), NOT the push token.
    expect(deps.resolveFindingThreads).toHaveBeenCalledWith({
      owner: "edereship",
      repo: "loop-pilot",
      prNumber: 99,
      commentIds: [501, 502],
      token: "github-token",
    });
    // It runs after the repair was committed/pushed and before the re-review.
    expect(deps.commitMessages.length).toBe(1);
    expect(deps.pushCalls.length).toBe(1);
    expect(deps.postCodexReviewRequest).toHaveBeenCalled();
  });

  it("TY-360: a resolve failure is best-effort — the loop still re-requests Codex and reaches waiting_codex", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState({ currentIterationFindingCommentIds: [501] }),
    });
    // Even if the (already best-effort) resolver somehow throws, post-fix must
    // not let it break the commit / @codex review / state transition.
    (deps.resolveFindingThreads as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("graphql exploded"),
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.pushCalls.length).toBe(1);
    expect(deps.postCodexReviewRequest).toHaveBeenCalled();
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({ status: "waiting_codex" }),
      "github-token",
      expect.any(Object),
    );
  });

  it("TY-327: a non-412 waiting_codex write failure after a successful push preserves the committed iteration (no rollback)", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState(), // iterationCount 2, findingsHashHistory length 2
    });
    // 1st Phase 4 write (waiting_codex) rejects with a NON-conflict error
    // (transient 5xx); the fallback stopped write succeeds.
    (deps.updateStateComment as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("HTTP 500: server error"))
      .mockResolvedValue({ updatedAt: "2026-05-14T12:31:00Z" });

    await runPostFix(baseConfig, deps, baseInputs);

    // The repair commit was committed AND pushed.
    expect(deps.commitMessages.length).toBe(1);
    expect(deps.pushCalls.length).toBe(1);

    // The fallback write records stopped/codex_request_failed WITHOUT rolling
    // back the pushed iteration: iterationCount stays 2 and history stays length 2.
    const calls = (deps.updateStateComment as ReturnType<typeof vi.fn>).mock.calls;
    const lastState = calls[calls.length - 1][3] as ReviewState;
    expect(lastState).toMatchObject({
      status: "stopped",
      stopReason: "codex_request_failed",
      iterationCount: 2,
    });
    expect(lastState.findingsHashHistory).toHaveLength(2);

    // crash-recovery rollback must NOT run on this (non-throwing) path.
    expect(deps.demoteFixingOnCrash).not.toHaveBeenCalled();
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "codex_request_failed",
      expect.any(Number),
      0,
      expect.stringContaining("pushed"),
      "github-token",
      expect.any(Object),
    );
  });

  it("TY-329 #2: stops with action_no_op (no @codex review) when `git add` stages nothing despite a non-empty change set", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      { hasStagedChanges: () => false },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    const calls = (deps.updateStateComment as ReturnType<typeof vi.fn>).mock.calls;
    const lastState = calls[calls.length - 1][3] as ReviewState;
    expect(lastState).toMatchObject({
      status: "stopped",
      stopReason: "action_no_op",
      // failureExit's rollbackFixingClaim rewinds the optimistic Phase 3 claim.
      iterationCount: 1,
    });
    expect(lastState.findingsHashHistory).toHaveLength(1);
    expect(deps.postClaudeCodeActionFixSummary).not.toHaveBeenCalled();
    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
  });

  it("TY-360: clears currentIterationFindingCommentIds on the failureExit stop path (no commit pushed)", async () => {
    // The failureExit clear at main-post-fix.ts is load-bearing:
    // `rollbackFixingClaim` does NOT touch the comment ids, so without the
    // explicit `[]` a stop reached without a pushed commit would carry the
    // in-scope ids into the stopped state. A soft /restart-review would then
    // resolve threads for findings this iteration never actually repaired.
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState({ currentIterationFindingCommentIds: [9001, 9002] }),
      },
      { hasStagedChanges: () => false },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    const calls = (deps.updateStateComment as ReturnType<typeof vi.fn>).mock.calls;
    const lastState = calls[calls.length - 1][3] as ReviewState;
    expect(lastState.status).toBe("stopped");
    expect(lastState.stopReason).toBe("action_no_op");
    expect(lastState.currentIterationFindingCommentIds).toEqual([]);
    // No commit was pushed, so the resolve pass must never run on this path.
    expect(deps.resolveFindingThreads).not.toHaveBeenCalled();
  });

  it("TY-286 #A: does NOT emit state_conflict ⚠️ when the Phase 4 2nd write conflicts; warns instead", async () => {
    // The 1st write (waiting_codex) succeeded and `@codex review` was
    // posted, so the loop is already healthy. A 412 on the 2nd write (which
    // only records `lastCodexRequestCommentId`) must not surface a top-level
    // stop comment that contradicts the live state — operators would
    // otherwise see "⚠️ LoopPilot stopped" while the next Codex review
    // trigger silently reconciles.
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState(),
    });
    (deps.updateStateComment as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ updatedAt: "2026-05-14T12:30:00Z" })
      .mockRejectedValueOnce(
        new StateUpdateConflictError("412 Precondition Failed"),
      );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.postCodexReviewRequest).toHaveBeenCalledTimes(1);
    expect(deps.postStopComment).not.toHaveBeenCalled();
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        "LoopPilot state remains waiting_codex; the next Codex review trigger will reconcile.",
      ),
    );
  });

  it("clears max_turns_exceeded stopReason carried over from /restart-review on a clean commit (TY-258)", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      // Simulates the state right after pre-fix transitions from
      // `waiting_codex(stopReason: max_turns_exceeded)` to `fixing` —
      // `stopReason` is intentionally carried through `applyRestartToState`
      // and only cleared once a successful repair lands.
      state: makeState({ stopReason: "max_turns_exceeded" }),
    });

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({
        status: "waiting_codex",
        stopReason: null,
      }),
      "github-token",
      expect.any(Object),
    );
  });

  it("reverts and stops with scope_violation when the diff hits hard-blocked paths", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "10\t0\t.github/workflows/looppilot-loop.yml\n",
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.resetCalls).toBe(1);
    expect(deps.runCheckCommand).not.toHaveBeenCalled();
    expect(deps.commitMessages).toEqual([]);
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "scope_violation",
        // Failed attempt: iteration + history rolled back.
        iterationCount: 1,
        findingsHashHistory: [{ iteration: 1, hash: "aaaaaaaaaaaaaaaa" }],
      }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "scope_violation",
      1234,
      0,
      expect.stringContaining(".github/workflows/looppilot-loop.yml"),
      "github-token",
    expect.any(Object),
    );
  });

  it("reverts and stops with secret_leak_suspected when a hard-fail pattern is in the diff (TY-274 #1)", async () => {
    // Diff-based: only `+`-prefixed lines from the unified diff are scanned.
    // The matching content here is an added line in src/foo.ts.
    //
    // The token literal is split with `+` so this source file does not contain
    // a contiguous match for the scanner's own `ghp_[A-Za-z0-9]{20,}` regex —
    // otherwise post-fix scans of this very test file (when claude-code-action
    // touches it) would treat the literal as a re-introduced leak.
    const fakeGhp = "g" + "hp_abcdefghijklmnopqrstuv0123456789";
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      `+export const t = '${fakeGhp}';`,
    ].join("\n");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "5\t2\tsrc/foo.ts\n",
        gitDiffHead: () => diff,
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    // Working tree reverted, CHECK_COMMAND skipped, no commit/push.
    expect(deps.resetCalls).toBe(1);
    expect(deps.runCheckCommand).not.toHaveBeenCalled();
    expect(deps.commitMessages).toEqual([]);
    expect(deps.pushCalls).toEqual([]);

    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "secret_leak_suspected",
      }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "secret_leak_suspected",
      1234,
      0,
      // Detail must surface pattern + path but NEVER the matched secret value
      // (asserted both ways).
      expect.stringContaining("github-pat-classic in src/foo.ts"),
      "github-token",
    expect.any(Object),
    );
    const detailArg = (deps.postStopComment as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[6] as string;
    expect(detailArg).not.toMatch(/ghp_[A-Za-z0-9]{8,}/);
  });

  it("does not stop on warning-only secret patterns (TY-274 #1)", async () => {
    // High-entropy warning pattern in an added diff line — should log a
    // warning but allow the loop to continue to CHECK_COMMAND.
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      "+export const HASH = 'Ab12CdEfGh34IjKlMnOp56QrStUvWxYz_a-b-c-d';",
    ].join("\n");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "1\t0\tsrc/foo.ts\n",
        gitDiffHead: () => diff,
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.runCheckCommand).toHaveBeenCalled();
    expect(deps.resetCalls).toBe(0);
    expect(deps.postStopComment).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "secret_leak_suspected",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("ignores secret-shaped content that pre-existed in HEAD (only scans added diff lines, TY-274 #1)", async () => {
    // Empty diff — the working tree somehow has the same numstat-listed file
    // but with no actual additions in this iteration. This models the
    // scanner's own source / fixture files: they already contain matching
    // patterns in HEAD, so the diff has no `+` lines and they must not
    // false-positive. CHECK_COMMAND must still run.
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "5\t2\tsrc/secret-scanner.ts\n",
        // No `+` lines → no added content scanned → no findings.
        gitDiffHead: () => "",
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.resetCalls).toBe(0);
    expect(deps.runCheckCommand).toHaveBeenCalled();
  });

  it("treats entire content of untracked files as added and scans them via intent-to-add diff (TY-274 #1 / TY-287 #2 follow-up)", async () => {
    // claude-code-action added a brand-new file containing a hard-fail
    // pattern. Under the TY-287 #2 follow-up, post-fix promotes untracked
    // paths to intent-to-add before running gitDiffHead so git's rename
    // detection can pair low-similarity renames with their tracked-side
    // deletions. As a side-effect, the untracked file's full contents
    // appear in the diff as `+` lines, and the secret-scanner consumes
    // them through the unified-diff path rather than the readFile path.
    //
    // Token literal split with `+` to avoid self-matching the scanner regex in
    // this source file (see the diff-based scan rationale above).
    const fakeGhp = "g" + "hp_abcdefghijklmnopqrstuv0123456789";
    const intentToAddDiff = [
      "diff --git a/src/new-leak.ts b/src/new-leak.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new-leak.ts",
      "@@ -0,0 +1 @@",
      `+export const t = '${fakeGhp}';`,
    ].join("\n");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "",
        // Real git: empty before intent-to-add, populated after. The mock
        // returns the post-intent-to-add diff straight from the first call
        // because the pre-check scan happens after `intentToAdd` is invoked.
        gitDiffHead: () => intentToAddDiff,
        gitListUntracked: () => "src/new-leak.ts\n",
        // The untracked-changes enumeration (used for scope check + line
        // counting) still reads the file directly; the scanner itself now
        // consumes the file via the post-intent-to-add diff above.
        readWorkingTreeFile: (path) =>
          path === "src/new-leak.ts"
            ? `export const t = '${fakeGhp}';`
            : null,
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    // TY-287 #2 follow-up: untracked paths must be intent-to-add'd before
    // the scan so low-similarity renames are paired with their deletions,
    // and the markers must be reset afterwards so the subsequent
    // `stagePaths` flow does not surface stale index entries.
    expect(deps.intentToAddCalls).toContainEqual(["src/new-leak.ts"]);
    expect(deps.resetIntentToAddCalls).toContainEqual(["src/new-leak.ts"]);

    expect(deps.resetCalls).toBe(1);
    expect(deps.runCheckCommand).not.toHaveBeenCalled();
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "secret_leak_suspected",
      1234,
      0,
      expect.stringContaining("github-pat-classic in src/new-leak.ts"),
      "github-token",
    expect.any(Object),
    );
  });

  it("re-scans secrets after CHECK_COMMAND on the no-build path (Codex P1 r3256220740)", async () => {
    // Pre-check scan saw the agent's edit (clean). CHECK_COMMAND's `--fix`
    // pass then rewrote src/foo.ts and injected a hard-fail token. With no
    // buildCommand, there was previously no second scan before staging, so
    // the leaked content would have been committed and pushed. The
    // pre-commit scan must catch this and stop with secret_leak_suspected.
    const fakeGhp = "g" + "hp_abcdefghijklmnopqrstuv0123456789";
    const cleanDiff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      "+const v = 1;",
    ].join("\n");
    const dirtyDiff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      `+const v = '${fakeGhp}';`,
    ].join("\n");
    const diffHead = vi
      .fn()
      .mockReturnValueOnce(cleanDiff) // pre-check scan: clean
      .mockReturnValueOnce(dirtyDiff); // pre-commit scan: CHECK_COMMAND injected leak
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "5\t2\tsrc/foo.ts\n",
        gitDiffHead: diffHead,
        gitListUntracked: () => "",
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.runCheckCommand).toHaveBeenCalled();
    // Pre-commit scan tripped → revert + secret_leak_suspected, no commit.
    expect(deps.resetCalls).toBe(1);
    expect(deps.commitMessages).toEqual([]);
    expect(deps.pushCalls).toEqual([]);
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "secret_leak_suspected",
      1234,
      0,
      expect.stringContaining("github-pat-classic in src/foo.ts"),
      "github-token",
    expect.any(Object),
    );
  });

  it("TY-287 #2 follow-up (Codex P2 r3263061946): low-similarity rename emits only the changed lines via intent-to-add + rename detection", async () => {
    // Scenario: claude-code-action moves `tests/fixtures/old.json` to
    // `tests/fixtures/new.json` and rewrites ~70% of the body. The source
    // file already contained a secret-shaped sample (the unchanged half).
    //
    // Before the TY-287 #2 follow-up: `git diff HEAD` saw only the
    // deletion (the destination was untracked, not in the index), so
    // `--find-renames=20%` could not pair them and the destination was
    // read in full via `readWorkingTreeFile` — re-emitting the
    // pre-existing secret-shaped line and hard-failing the scanner.
    //
    // After the follow-up: post-fix calls `intentToAdd` on the untracked
    // destination before the scan, the rename pair is detected, and only
    // the genuinely changed `+` lines surface as additions. The
    // pre-existing fixture content stays out of the scan input.
    const fakeGhp = "g" + "hp_abcdefghijklmnopqrstuv0123456789";
    const renameDiff = [
      // Rename header pair emitted by `--find-renames=20%` (with intent-to-add).
      "diff --git a/tests/fixtures/old-config.json b/tests/fixtures/new-config.json",
      "similarity index 28%",
      "rename from tests/fixtures/old-config.json",
      "rename to tests/fixtures/new-config.json",
      "--- a/tests/fixtures/old-config.json",
      "+++ b/tests/fixtures/new-config.json",
      "@@ -2 +2 @@",
      // Only the genuinely rewritten line — the pre-existing secret-shape
      // line in the file body is NOT here. It would have been re-emitted
      // had git treated this as delete + add.
      `-  "label": "old-${fakeGhp.slice(0, 12)}"`,
      `+  "label": "new-value"`,
    ].join("\n");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        // numstat sees the rename source as a deletion (numstat is invoked
        // before intent-to-add). The exact shape is not the focus of this
        // test; what matters is the scan path's behaviour.
        gitDiffNumstat: () => "5\t10\ttests/fixtures/old-config.json\n",
        // Mock the post-intent-to-add diff so the scanner consumes the
        // rename-headered hunks rather than reading the destination in full.
        gitDiffHead: () => renameDiff,
        gitListUntracked: () => "tests/fixtures/new-config.json\n",
        // Provide content so the untracked-changes enumeration treats this
        // as a non-binary text file; the scanner itself never sees this
        // value because it runs off the rename-headered diff above.
        readWorkingTreeFile: (path) =>
          path === "tests/fixtures/new-config.json"
            ? `{\n  "label": "new-value",\n  "other": "stays"\n}\n`
            : null,
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.intentToAddCalls).toContainEqual([
      "tests/fixtures/new-config.json",
    ]);
    expect(deps.resetIntentToAddCalls).toContainEqual([
      "tests/fixtures/new-config.json",
    ]);
    // The pre-existing secret-shape line is in the `-` half of the rename
    // diff, so the scanner never sees it as an addition. No hard failure,
    // no working-tree reset.
    expect(deps.resetCalls).toBe(0);
    expect(deps.postStopComment).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "secret_leak_suspected",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(deps.runCheckCommand).toHaveBeenCalled();
  });

  it("scans untracked files whose names contain ' => ' via intent-to-add diff (Codex P2 r3256517009 / TY-287 #2 follow-up)", async () => {
    // `git ls-files --others` returns real filesystem paths verbatim, never
    // rename notation (that's a `git diff --numstat` artefact). The TY-287
    // #2 follow-up routes the untracked-file scan through `gitDiffHead`
    // (via intent-to-add) so rename detection can pair low-similarity
    // renames with their deletions. Pre-existing fixtures whose names
    // contain ` => ` must still be scanned end-to-end through that path.
    const fakeGhp = "g" + "hp_abcdefghijklmnopqrstuv0123456789";
    const untrackedListings = vi
      .fn()
      // Initial enumeration (before CHECK_COMMAND): clean.
      .mockReturnValueOnce("")
      // Post-CHECK enumeration (TY-297 #1): CHECK_COMMAND created the file.
      .mockReturnValueOnce("data/a => b.json\n")
      // Pre-commit enumeration: untracked file with ` => ` in its name.
      .mockReturnValueOnce("data/a => b.json\n");
    const preCommitDiff = [
      `diff --git a/data/a => b.json b/data/a => b.json`,
      "new file mode 100644",
      `--- /dev/null`,
      `+++ b/data/a => b.json`,
      "@@ -0,0 +1 @@",
      `+{ "token": "${fakeGhp}" }`,
    ].join("\n");
    const diffHead = vi
      .fn()
      // Pre-check scan: nothing changed yet aside from the tracked file.
      .mockReturnValueOnce("")
      // Pre-commit scan: intent-to-add has promoted the untracked file
      // into the diff.
      .mockReturnValueOnce(preCommitDiff);
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "1\t0\tsrc/foo.ts\n",
        gitDiffHead: diffHead,
        gitListUntracked: untrackedListings,
        // TY-297 #1: the hoisted post-CHECK enumeration reads the working-tree
        // file to count lines. Return non-null content so the file is treated
        // as a normal text addition rather than a binary marker (the latter
        // would trip the post-CHECK scope check before the pre-commit scanner
        // could detect the embedded token).
        readWorkingTreeFile: (path) =>
          path === "data/a => b.json" ? `{ "token": "${fakeGhp}" }` : null,
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.intentToAddCalls).toContainEqual(["data/a => b.json"]);
    expect(deps.resetIntentToAddCalls).toContainEqual(["data/a => b.json"]);
    expect(deps.resetCalls).toBe(1);
    expect(deps.commitMessages).toEqual([]);
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "secret_leak_suspected",
      1234,
      0,
      // Path with " => " in its name must surface in the stop detail.
      expect.stringContaining("github-pat-classic in data/a => b.json"),
      "github-token",
    expect.any(Object),
    );
  });

  it("saves CHECK_COMMAND failure tail to previousCheckFailure and stops with test_failure", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        runCheckCommand: vi.fn().mockResolvedValue({
          success: false,
          output: "tsc error: unexpected token",
        }),
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.commitMessages).toEqual([]);
    // Untracked files written by claude-code-action would survive
    // check-runner's per-path rollback; post-fix must reset + clean.
    expect(deps.resetCalls).toBe(1);
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "test_failure",
        previousCheckFailure: "tsc error: unexpected token",
        // Iteration + findings hash were claimed by pre-fix on the way in;
        // since no commit was pushed, they must be rolled back so a soft
        // /restart-review with the same Codex findings doesn't loop-detect
        // immediately.
        iterationCount: 1,
        findingsHashHistory: [{ iteration: 1, hash: "aaaaaaaaaaaaaaaa" }],
        lastFindingsHash: "aaaaaaaaaaaaaaaa",
      }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postTestFailureComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "tsc error: unexpected token",
      "github-token",
    expect.any(Object),
    );
    // TY-290 #2: status-comment edit does not fire GitHub notifications, so
    // `failureExit` must follow `postTestFailureComment` (status update) with
    // an explicit top-level ⚠️ comment so operators see CHECK_COMMAND
    // failures in their inbox / mobile push.
    expect(deps.postTerminalNotification).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      44,
      {
        kind: "stopped",
        stopReason: "test_failure",
      },
      "github-token",
    );
  });

  it("includes new files from gitListUntracked in scope check + commit", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "5\t2\tsrc/foo.ts\n",
        gitListUntracked: () => "src/new-helper.ts\ntests/new-helper.test.ts\n",
        readWorkingTreeFile: (path) => {
          if (path === "src/new-helper.ts") {
            return "export const helper = () => 42;\n";
          }
          if (path === "tests/new-helper.test.ts") {
            return "import { helper } from '../src/new-helper.js';\n";
          }
          return null;
        },
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    // Both the tracked edit AND the two new files must be staged together.
    expect(deps.stagedPaths).toEqual([
      ["src/foo.ts", "src/new-helper.ts", "tests/new-helper.test.ts"],
    ]);
    expect(deps.commitMessages.length).toBe(1);
    expect(deps.pushCalls).toEqual([
      {
        owner: "edereship",
        repo: "loop-pilot",
        ref: "linear/TY-237",
        token: "",
      },
    ]);
    // The fix summary surfaces every changed file, not just the tracked subset.
    expect(deps.postClaudeCodeActionFixSummary).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      2,
      ["src/foo.ts", "src/new-helper.ts", "tests/new-helper.test.ts"],
      "abc1234",
      "github-token",
    expect.any(Object),
    );
  });

  it("TY-334: demotes to stopped/codex_request_failed and notifies when Codex never ACKs the re-review", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "5\t2\tsrc/foo.ts\n",
        gitListUntracked: () => "",
        ensureCodexAck: vi.fn().mockResolvedValue({
          acked: false,
          reason: "exhausted",
          reposts: 2,
          lastCommentId: 999,
        }),
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    const calls = (deps.updateStateComment as ReturnType<typeof vi.fn>).mock
      .calls as unknown as Array<[string, string, number, ReviewState, string]>;
    const stoppedWrite = calls.find(
      (c) => c[3]?.status === "stopped" && c[3]?.stopReason === "codex_request_failed",
    );
    expect(stoppedWrite).toBeDefined();
    expect(stoppedWrite?.[3].lastCodexRequestCommentId).toBe(999);

    const stopCalls = (deps.postStopComment as ReturnType<typeof vi.fn>).mock
      .calls as unknown as Array<[string, string, number, string, number, number, string]>;
    const stopCall = stopCalls.find((c) => c[3] === "codex_request_failed");
    expect(stopCall).toBeDefined();
    expect(stopCall?.[6]).toContain("did not acknowledge");
  });

  it("renders the operator-configured iteration cap in the fix-summary status comment (TY-337)", async () => {
    // Guards the plumbing fixed in TY-337: post-fix must use
    // config.maxReviewIterations (forwarded from the loop composite) for the
    // status comment's **Iterations** header, not the hard-coded default 20.
    // baseConfig pins 20, so a distinct cap proves the value flows from config
    // through deriveIterationProgress into the posted summary.
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "5\t2\tsrc/foo.ts\n",
        gitListUntracked: () => "",
      },
    );

    await runPostFix({ ...baseConfig, maxReviewIterations: 5 }, deps, baseInputs);

    expect(deps.postClaudeCodeActionFixSummary).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      2,
      expect.any(Array),
      expect.any(String),
      "github-token",
      expect.objectContaining({ maxIterations: 5 }),
    );
  });

  it("flags binary new files via readWorkingTreeFile=null and stops with binary scope violation", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "",
        gitListUntracked: () => "src/blob.bin\n",
        // null indicates binary or unreadable content.
        readWorkingTreeFile: () => null,
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.resetCalls).toBe(1);
    expect(deps.runCheckCommand).not.toHaveBeenCalled();
    expect(deps.commitMessages).toEqual([]);
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "scope_violation" }),
      "github-token",
      expect.any(Object),
    );
  });

  it("treats action outcome=cancelled as action_timeout", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState(),
    });

    await runPostFix(baseConfig, deps, { ...baseInputs, actionOutcome: "cancelled" });

    expect(deps.resetCalls).toBe(1);
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "action_timeout" }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "action_timeout",
      1234,
      0,
      expect.stringContaining("cancelled"),
      "github-token",
    expect.any(Object),
    );
  });

  it("detects max_turns_exceeded from the action execution file", async () => {
    // TY-324 #C: a non-JSON execution file still classifies via the
    // verb-anchored human-readable fallback ("Reached" + "max_turns").
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        readActionExecutionFile: () => "Error: Reached max_turns limit",
      },
    );

    await runPostFix(baseConfig, deps, {
      ...baseInputs,
      actionOutcome: "failure",
      actionExecutionFile: "/tmp/execution.json",
    });

    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "max_turns_exceeded" }),
      "github-token",
      expect.any(Object),
    );
  });

  it("falls back to action_failure when execution file does not indicate max_turns", async () => {
    // TY-324 #D: default readActionExecutionFile returns null (missing file).
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState(),
    });

    await runPostFix(baseConfig, deps, {
      ...baseInputs,
      actionOutcome: "failure",
    });

    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "action_failure" }),
      "github-token",
      expect.any(Object),
    );
  });

  it("TY-324 #B: classifies a structured error_max_turns result as max_turns_exceeded", async () => {
    // Real claude-code-action execution file: a JSON array of Claude Agent SDK
    // messages terminated by a `type: "result"` message whose `subtype` is the
    // authoritative stop reason.
    const executionFile = JSON.stringify([
      { type: "system", subtype: "init", session_id: "sess-b", model: "claude-opus-4-6" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "working" }] } },
      { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 40, duration_ms: 120000 },
    ]);
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        readActionExecutionFile: () => executionFile,
      },
    );

    await runPostFix(baseConfig, deps, {
      ...baseInputs,
      actionOutcome: "failure",
      actionExecutionFile: "/tmp/execution.json",
    });

    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "max_turns_exceeded" }),
      "github-token",
      expect.any(Object),
    );
  });

  it("TY-324 #A: a generic failure whose execution file echoes the max_turns config is action_failure, not max_turns_exceeded", async () => {
    // Regression for the loose `includes("max_turns")` heuristic: the
    // `--max-turns 40` config echo is present in the log, but the terminal
    // result subtype is `error_during_execution` (a generic failure). The old
    // substring scan misclassified this as max_turns_exceeded, which TY-258
    // then carried across /restart-review to force an unnecessary Opus tier.
    const executionFile = JSON.stringify([
      {
        type: "system",
        subtype: "init",
        session_id: "sess-a",
        model: "claude-opus-4-6",
        max_turns: 40,
      },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "boom" }] } },
      { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 3, duration_ms: 5000 },
    ]);
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        readActionExecutionFile: () => executionFile,
      },
    );

    await runPostFix(baseConfig, deps, {
      ...baseInputs,
      actionOutcome: "failure",
      actionExecutionFile: "/tmp/execution.json",
    });

    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "action_failure" }),
      "github-token",
      expect.any(Object),
    );
  });

  it("stops with action_no_op when claude-code-action made no changes (TY-284)", async () => {
    // TY-284 replaced the TY-273 #B3 auto-retry path: a no-op success outcome
    // is now treated as a stop condition. CHECK_COMMAND is skipped, no Codex
    // re-request is posted, and the operator resumes via `/restart-review`.
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "",
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.runCheckCommand).not.toHaveBeenCalled();
    expect(deps.commitMessages).toEqual([]);
    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "action_no_op" }),
      "github-token",
      expect.any(Object),
    );
  });

  // TY-302 #2: non-test_failure failure paths preserve the previousCheckFailure
  // tail saved by a prior iteration's test_failure stop. Old behavior cleared
  // it to null, which dropped the repair prompt's Previous Failure section and
  // `selectModel`'s `previous_check_failure` escalation reason — operator's
  // next `/restart-review` would lose the original test failure context.
  describe("TY-302 #2: preserves previousCheckFailure across non-test_failure stops", () => {
    const PRIOR_TAIL = "tsc error: prior tail";

    it("action_failure preserves previousCheckFailure carried over from a prior test_failure stop", async () => {
      const deps = makeDeps({
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState({ previousCheckFailure: PRIOR_TAIL }),
      });

      await runPostFix(baseConfig, deps, {
        ...baseInputs,
        actionOutcome: "failure",
      });

      expect(deps.updateStateComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        100,
        expect.objectContaining({
          status: "stopped",
          stopReason: "action_failure",
          previousCheckFailure: PRIOR_TAIL,
        }),
        "github-token",
        expect.any(Object),
      );
    });

    it("action_no_op preserves previousCheckFailure", async () => {
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T12:00:00Z",
          state: makeState({ previousCheckFailure: PRIOR_TAIL }),
        },
        {
          gitDiffNumstat: () => "",
        },
      );

      await runPostFix(baseConfig, deps, baseInputs);

      expect(deps.updateStateComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        100,
        expect.objectContaining({
          status: "stopped",
          stopReason: "action_no_op",
          previousCheckFailure: PRIOR_TAIL,
        }),
        "github-token",
        expect.any(Object),
      );
    });

    it("scope_violation preserves previousCheckFailure", async () => {
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T12:00:00Z",
          state: makeState({ previousCheckFailure: PRIOR_TAIL }),
        },
        {
          gitDiffNumstat: () => "10\t0\t.github/workflows/looppilot-loop.yml\n",
        },
      );

      await runPostFix(baseConfig, deps, baseInputs);

      expect(deps.updateStateComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        100,
        expect.objectContaining({
          status: "stopped",
          stopReason: "scope_violation",
          previousCheckFailure: PRIOR_TAIL,
        }),
        "github-token",
        expect.any(Object),
      );
    });

    it("max_turns_exceeded preserves previousCheckFailure", async () => {
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T12:00:00Z",
          state: makeState({ previousCheckFailure: PRIOR_TAIL }),
        },
        {
          readActionExecutionFile: () => "Error: Reached max_turns limit",
        },
      );

      await runPostFix(baseConfig, deps, {
        ...baseInputs,
        actionOutcome: "failure",
        actionExecutionFile: "/tmp/execution.json",
      });

      expect(deps.updateStateComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        100,
        expect.objectContaining({
          status: "stopped",
          stopReason: "max_turns_exceeded",
          previousCheckFailure: PRIOR_TAIL,
        }),
        "github-token",
        expect.any(Object),
      );
    });

    it("secret_leak_suspected preserves previousCheckFailure", async () => {
      const fakeGhp = "g" + "hp_abcdefghijklmnopqrstuv0123456789";
      const diff = [
        "diff --git a/src/foo.ts b/src/foo.ts",
        "--- a/src/foo.ts",
        "+++ b/src/foo.ts",
        "@@ -1 +1 @@",
        `+export const t = '${fakeGhp}';`,
      ].join("\n");
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T12:00:00Z",
          state: makeState({ previousCheckFailure: PRIOR_TAIL }),
        },
        {
          gitDiffNumstat: () => "5\t2\tsrc/foo.ts\n",
          gitDiffHead: () => diff,
        },
      );

      await runPostFix(baseConfig, deps, baseInputs);

      expect(deps.updateStateComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        100,
        expect.objectContaining({
          status: "stopped",
          stopReason: "secret_leak_suspected",
          previousCheckFailure: PRIOR_TAIL,
        }),
        "github-token",
        expect.any(Object),
      );
    });

    it("test_failure still overwrites previousCheckFailure with the new CHECK_COMMAND failure tail (regression)", async () => {
      // test_failure passes `preservePreviousCheckFailure: true` with a fresh
      // body, so the stale prior tail must be replaced — not kept.
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T12:00:00Z",
          state: makeState({ previousCheckFailure: "outdated tail" }),
        },
        {
          runCheckCommand: vi.fn().mockResolvedValue({
            success: false,
            output: "tsc error: fresh tail",
          }),
        },
      );

      await runPostFix(baseConfig, deps, baseInputs);

      expect(deps.updateStateComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        100,
        expect.objectContaining({
          status: "stopped",
          stopReason: "test_failure",
          previousCheckFailure: "tsc error: fresh tail",
        }),
        "github-token",
        expect.any(Object),
      );
    });
  });

  it("LOOPPILOT_BLOCK_PATHS=!package.json lets package.json pass the scope check (TY-271)", async () => {
    // The new block-list lets operators opt specific defaults out via `!path`.
    // After the override, `package.json` is no longer blocked — the diff
    // should reach CHECK_COMMAND and commit normally.
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "3\t1\tpackage.json\n",
      },
    );

    await runPostFix(
      { ...baseConfig, autoReviewBlockPaths: "!package.json" },
      deps,
      baseInputs,
    );

    expect(deps.info).toHaveBeenCalledWith(
      '[scope-check] LOOPPILOT_BLOCK_PATHS: "!package.json"',
    );
    expect(deps.postStopComment).not.toHaveBeenCalled();
    expect(deps.commitMessages.length).toBe(1);
  });

  it("still hard-blocks .github/ even when LOOPPILOT_BLOCK_PATHS=!.github/... is set (TY-271)", async () => {
    // .github/ is locked. The `!.github/...` removal is silently dropped,
    // and the scope check refuses the diff with `hard_block_path`.
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "1\t0\t.github/workflows/looppilot-loop.yml\n",
      },
    );

    await runPostFix(
      {
        ...baseConfig,
        autoReviewBlockPaths: "!.github/workflows/looppilot-loop.yml",
      },
      deps,
      baseInputs,
    );

    const warnCalls = (deps.warning as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => String(c[0]),
    );
    expect(
      warnCalls.some((m: string) =>
        m.includes(".github/") && m.includes("locked"),
      ),
    ).toBe(true);
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "scope_violation",
      1234,
      0,
      expect.stringContaining(".github/workflows/looppilot-loop.yml"),
      "github-token",
    expect.any(Object),
    );
  });

  it("scope_violation comment includes actionable LOOPPILOT_BLOCK_PATHS hint (TY-271)", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: () => "5\t0\tdist/post-fix/index.cjs\n",
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    const stopCall = (
      deps.postStopComment as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    const detail = String(stopCall[6]);
    expect(detail).toContain("dist/post-fix/index.cjs");
    expect(detail).toContain("LOOPPILOT_BLOCK_PATHS");
    expect(detail).toContain("!dist/");
    expect(detail).toContain("docs/operations/scope-policy.md");
  });

  it("skips when state is no longer 'fixing' (manual intervention)", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState({ status: "stopped", stopReason: "max_iterations" }),
    });

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.runCheckCommand).not.toHaveBeenCalled();
    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
  });

  // TY-284: claude-code-action returning zero edits is treated as a stop
  // condition (`action_no_op`). The Phase 3 bookkeeping rolls back through
  // `failureExit` so soft `/restart-review` can replay the same findings.

  it("TY-284: no-op claude-code-action stops with action_no_op and rolls back Phase 3 bookkeeping", async () => {
    const stateAfterPhase3 = makeState({
      iterationCount: 2,
      findingsHashHistory: [
        { iteration: 1, hash: "aaaaaaaaaaaaaaaa", modelTier: "base" },
        { iteration: 2, hash: "bbbbbbbbbbbbbbbb", modelTier: "base" },
      ],
      lastFindingsHash: "bbbbbbbbbbbbbbbb",
      fixingStartedAt: "2026-05-17T00:00:00Z",
    });
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: stateAfterPhase3,
      },
      { gitDiffNumstat: () => "" },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    // failureExit writes `stopped/action_no_op` with iteration / history
    // rolled back to the pre-Phase-3 baseline so a soft restart resumes the
    // same Codex findings without consuming an iteration or poisoning loop
    // detection.
    const calls = (deps.updateStateComment as ReturnType<typeof vi.fn>).mock.calls;
    const lastState = calls[calls.length - 1][3];
    expect(lastState).toMatchObject({
      status: "stopped",
      stopReason: "action_no_op",
      iterationCount: 1,
      lastFindingsHash: "aaaaaaaaaaaaaaaa",
      fixingStartedAt: null,
    });
    expect(lastState.findingsHashHistory).toEqual([
      { iteration: 1, hash: "aaaaaaaaaaaaaaaa", modelTier: "base" },
    ]);
    // Stop notification is posted; the no-op path no longer re-requests
    // Codex review (the auto-retry behavior from TY-273 #B3 was removed).
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "action_no_op",
      1234,
      0,
      expect.stringContaining("no file changes"),
      "github-token",
    expect.any(Object),
    );
    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
  });

  // TY-325: on the no-build path, claude's edits can pass the scope check and
  // CHECK_COMMAND yet be normalized back to HEAD by a formatter / codegen step
  // (net-zero diff). Without a guard the flow would fall through with an empty
  // staging set, post a misleading "no files changed" summary, and re-request
  // Codex review on unchanged code. These cases assert the symmetric
  // action_no_op stop and that the build path is unaffected.
  describe("TY-325: post-CHECK net-zero on the no-build path stops with action_no_op", () => {
    function makeNetZeroDeps(
      state: ReviewState,
      overrides: Partial<PostFixDeps> = {},
    ): PostFixDeps & DepRecord {
      // gitDiffNumstat is called twice on the no-build success path: 1st =
      // pre-CHECK enumeration (non-empty, so the :850 guard passes), 2nd =
      // post-CHECK re-enumeration (empty, the net-zero condition under test).
      let numstatCalls = 0;
      return makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T12:00:00Z",
          state,
        },
        {
          gitDiffNumstat: () => {
            numstatCalls += 1;
            return numstatCalls === 1 ? "5\t2\tsrc/foo.ts\n" : "";
          },
          gitListUntracked: () => "",
          ...overrides,
        },
      );
    }

    it("#A: stops with action_no_op and does not re-request Codex review", async () => {
      const deps = makeNetZeroDeps(makeState());

      await runPostFix(baseConfig, deps, baseInputs);

      // CHECK_COMMAND ran (pre-CHECK changes were non-empty) but reverted
      // everything; the run stops instead of committing or re-requesting review.
      expect(deps.runCheckCommand).toHaveBeenCalled();
      expect(deps.commitMessages).toEqual([]);
      expect(deps.postClaudeCodeActionFixSummary).not.toHaveBeenCalled();
      expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();

      const calls = (deps.updateStateComment as ReturnType<typeof vi.fn>).mock.calls;
      const lastState = calls[calls.length - 1][3];
      expect(lastState).toMatchObject({ status: "stopped", stopReason: "action_no_op" });
    });

    it("#B: rolls back Phase 3 bookkeeping via failureExit (TY-302 #1)", async () => {
      const stateAfterPhase3 = makeState({
        iterationCount: 2,
        findingsHashHistory: [
          { iteration: 1, hash: "aaaaaaaaaaaaaaaa", modelTier: "base" },
          { iteration: 2, hash: "bbbbbbbbbbbbbbbb", modelTier: "base" },
        ],
        lastFindingsHash: "bbbbbbbbbbbbbbbb",
        fixingStartedAt: "2026-05-17T00:00:00Z",
      });
      const deps = makeNetZeroDeps(stateAfterPhase3);

      await runPostFix(baseConfig, deps, baseInputs);

      const calls = (deps.updateStateComment as ReturnType<typeof vi.fn>).mock.calls;
      const lastState = calls[calls.length - 1][3];
      // iteration / history rewound to the pre-Phase-3 baseline so a soft
      // /restart-review replays the same findings without consuming a slot.
      expect(lastState).toMatchObject({
        status: "stopped",
        stopReason: "action_no_op",
        iterationCount: 1,
        lastFindingsHash: "aaaaaaaaaaaaaaaa",
        fixingStartedAt: null,
      });
      expect(lastState.findingsHashHistory).toEqual([
        { iteration: 1, hash: "aaaaaaaaaaaaaaaa", modelTier: "base" },
      ]);
    });

    it("#C: build path net-zero still stops with action_failure (no regression)", async () => {
      // With buildCommand set, the new no-build guard must NOT fire. The
      // working tree survives CHECK_COMMAND (post-CHECK non-empty) but
      // BUILD_COMMAND erases it (post-BUILD empty) → existing action_failure.
      let numstatCalls = 0;
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T12:00:00Z",
          state: makeState(),
        },
        {
          gitDiffNumstat: () => {
            numstatCalls += 1;
            // 1st = pre-CHECK, 2nd = post-CHECK (both non-empty), 3rd = post-BUILD (empty)
            return numstatCalls <= 2 ? "5\t2\tsrc/foo.ts\n" : "";
          },
          gitListUntracked: () => "",
        },
      );

      await runPostFix({ ...baseConfig, buildCommand: "npm run build" }, deps, baseInputs);

      expect(deps.runBuildCommand).toHaveBeenCalled();
      const calls = (deps.updateStateComment as ReturnType<typeof vi.fn>).mock.calls;
      const lastState = calls[calls.length - 1][3];
      expect(lastState).toMatchObject({ status: "stopped", stopReason: "action_failure" });
    });
  });

  // TY-273 #B5: codex_request_failed downgrade.

  it("TY-273 #B5: downgrades to stopped/codex_request_failed when re-posting @codex review throws", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState(),
    });
    (deps.postCodexReviewRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("HTTP 403: forbidden"),
    );

    await runPostFix(baseConfig, deps, baseInputs);

    // The status comment ends up in stopped/codex_request_failed so the next
    // pre-fix run does NOT re-enter `waiting_codex` and deadlock.
    const calls = (deps.updateStateComment as ReturnType<typeof vi.fn>).mock.calls;
    const lastState = calls[calls.length - 1][3];
    expect(lastState).toMatchObject({
      status: "stopped",
      stopReason: "codex_request_failed",
    });
    // The operator gets a top-level notification with the underlying error so
    // they can fix Codex auth and `/restart-review` once it's reachable.
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "codex_request_failed",
      expect.any(Number),
      0,
      expect.stringContaining("HTTP 403: forbidden"),
      "github-token",
    expect.any(Object),
    );
  });

  // A transient status-comment failure after the repair is committed + pushed
  // must NOT propagate (which would reach demoteFixingOnCrash via onError, roll
  // back the pushed iteration, and falsely report workflow_crashed). The run
  // should warn and still advance to waiting_codex + re-request Codex review.
  it("does not crash or roll back when postClaudeCodeActionFixSummary throws after push", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState(),
    });
    (deps.postClaudeCodeActionFixSummary as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("HTTP 502: bad gateway"),
    );

    // Must resolve (no propagated throw → no false crash recovery).
    await expect(runPostFix(baseConfig, deps, baseInputs)).resolves.toBeUndefined();

    // The repair commit + push already happened before the status update.
    expect(deps.commitMessages.length).toBe(1);
    expect(deps.pushCalls.length).toBe(1);
    // The run still advances to waiting_codex and re-requests Codex review.
    expect(deps.postCodexReviewRequest).toHaveBeenCalled();
    const calls = (deps.updateStateComment as ReturnType<typeof vi.fn>).mock.calls;
    const waitingWrite = calls.find((c) => c[3]?.status === "waiting_codex");
    expect(waitingWrite).toBeDefined();
    // iterationCount is NOT rolled back — the pushed iteration counts.
    expect(waitingWrite?.[3]?.iterationCount).toBe(2);
    // No write demotes to a stopped state.
    expect(calls.find((c) => c[3]?.status === "stopped")).toBeUndefined();
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining("Failed to update the auto-fix status comment"),
    );
  });

  // A non-412 failure on the *informational* lastCodexRequestCommentId write
  // (after @codex review was already posted) must NOT be misattributed to a
  // failed @codex review post and demote a healthy waiting_codex loop to
  // stopped/codex_request_failed.
  it("does not demote to codex_request_failed when recording the review-request id fails (non-412)", async () => {
    const update = vi
      .fn()
      .mockResolvedValueOnce({ updatedAt: "2026-05-14T12:30:00Z" }) // waitingState write OK
      .mockRejectedValueOnce(new Error("HTTP 500: internal server error")); // id-record write fails (non-412)
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      { updateStateComment: update },
    );

    await expect(runPostFix(baseConfig, deps, baseInputs)).resolves.toBeUndefined();

    // @codex review WAS posted before the failing id-record write.
    expect(deps.postCodexReviewRequest).toHaveBeenCalledTimes(1);
    // The loop is healthy: no stop comment, no stopped-state write.
    expect(deps.postStopComment).not.toHaveBeenCalled();
    expect(update.mock.calls.find((c) => c[3]?.status === "stopped")).toBeUndefined();
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        "Failed to persist the Codex review request comment id (non-conflict error)",
      ),
    );
  });

  // TY-273 #B4: fixingStartedAt clearing on terminal transitions.

  it("TY-273 #B4: clears fixingStartedAt on the clean waiting_codex transition", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState({ fixingStartedAt: "2026-05-17T00:00:00Z" }),
    });

    await runPostFix(baseConfig, deps, baseInputs);

    const calls = (deps.updateStateComment as ReturnType<typeof vi.fn>).mock.calls;
    const lastState = calls[calls.length - 1][3];
    expect(lastState.fixingStartedAt).toBeNull();
  });

  // TY-297 #2: post-fix must surface a top-level failure (not a silent
  // `return`) when the hidden state comment is missing or corrupted at
  // entry. Without `setFailed`, the workflow step ends in `success` and the
  // looppilot-loop.yml #2B fail-safe never fires, leaving `status: fixing`
  // dangling until pre-fix's 30-min stale-detector eventually recovers — the
  // operator gets no signal in the meantime.
  it("TY-297 #2: marks the step as failed when hidden state is missing (no-comment case)", async () => {
    const deps = makeDeps({
      found: false,
      corrupted: false,
      commentId: null,
    });

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.setFailed).toHaveBeenCalledTimes(1);
    expect((deps.setFailed as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      "Hidden state comment is missing or corrupted",
    );
    // None of the write-side spies must fire after a silent-failure entry.
    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.commitMessages).toEqual([]);
    expect(deps.pushCalls).toEqual([]);
    expect(deps.postStopComment).not.toHaveBeenCalled();
    expect(deps.runCheckCommand).not.toHaveBeenCalled();
  });

  it("TY-297 #2: marks the step as failed when hidden state is corrupted (parse-failure case)", async () => {
    const deps = makeDeps({
      found: false,
      corrupted: true,
      commentId: 123,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
    });

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.setFailed).toHaveBeenCalledTimes(1);
    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.commitMessages).toEqual([]);
    expect(deps.pushCalls).toEqual([]);
    expect(deps.postStopComment).not.toHaveBeenCalled();
  });

  // TY-310 #2: the `setFailed + return` exit does not throw, so
  // `runIfNotVitest`'s onError (which calls demoteFixingOnCrash) never runs.
  // post-fix must therefore demote a still-`fixing` hidden state itself.
  it("TY-310 #2: demotes a stuck fixing state via demoteFixingOnCrash when hidden state is not found", async () => {
    const deps = makeDeps({
      found: false,
      corrupted: false,
      commentId: null,
    });

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.demoteFixingOnCrash).toHaveBeenCalledTimes(1);
    expect(deps.demoteFixingOnCrash).toHaveBeenCalledWith("post-fix");
    expect(deps.setFailed).toHaveBeenCalledTimes(1);
  });

  it("TY-310 #2: setFailed message tells the operator to verify LOOPPILOT_STATE_COMMENT_AUTHORS", async () => {
    const deps = makeDeps({
      found: false,
      corrupted: false,
      commentId: null,
    });

    await runPostFix(baseConfig, deps, baseInputs);

    const message = (deps.setFailed as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(message).toContain("LOOPPILOT_STATE_COMMENT_AUTHORS");
    expect(message).toContain("/restart-review");
  });

  // TY-297 #1: the post-CHECK enumeration must run on every path (not just
  // when BUILD_COMMAND is configured) so CHECK_COMMAND's own writes —
  // formatter `--fix` output, snapshot regeneration, etc. — actually land in
  // the commit. And the same re-enumeration enforces the scope policy
  // against locked paths the agent never touched directly.
  it("TY-297 #1: stages snapshot files written by CHECK_COMMAND on the no-build path", async () => {
    // Pre-CHECK numstat sees claude's edit only; post-CHECK numstat picks up
    // the snapshot file that CHECK_COMMAND regenerated. Without the hoist
    // the snapshot is silently dropped and re-appears at the next iteration.
    const numstatMock = vi
      .fn()
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n")
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n3\t1\t__snapshots__/foo.snap\n");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: numstatMock,
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.stagedPaths).toEqual([["src/foo.ts", "__snapshots__/foo.snap"]]);
    expect(deps.commitMessages.length).toBe(1);
    expect(deps.pushCalls.length).toBe(1);
  });

  it("TY-297 #1: stops with scope_violation when CHECK_COMMAND writes to a locked path on the no-build path", async () => {
    // Pre-CHECK is clean (claude only edited src/foo.ts). CHECK_COMMAND then
    // touches `.github/workflows/foo.yml` — a locked path the pre-CHECK
    // scope check never saw. The post-CHECK scope check must catch this.
    const numstatMock = vi
      .fn()
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n")
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n3\t1\t.github/workflows/foo.yml\n");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: numstatMock,
      },
    );

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.resetCalls).toBe(1);
    expect(deps.commitMessages).toEqual([]);
    expect(deps.pushCalls).toEqual([]);
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "scope_violation" }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "scope_violation",
      1234,
      0,
      expect.stringContaining(".github/workflows/foo.yml"),
      "github-token",
      expect.any(Object),
    );
  });

  // TY-281: BUILD_COMMAND integration. Four cases cover the configurable
  // post-CHECK_COMMAND build step that keeps committed build artifacts in
  // sync with src/ for repos that ship `dist/`.

  it("TY-281: skips BUILD_COMMAND entirely when buildCommand is empty", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T12:00:00Z",
      state: makeState(),
    });

    await runPostFix(baseConfig, deps, baseInputs);

    expect(deps.runBuildCommand).not.toHaveBeenCalled();
    // Behavior matches the clean-run case: stage claude's two files, commit, push.
    expect(deps.stagedPaths).toEqual([["src/foo.ts", "tests/foo.test.ts"]]);
    expect(deps.commitMessages.length).toBe(1);
  });

  it("TY-281: runs BUILD_COMMAND after CHECK_COMMAND and includes generated artifacts in the commit", async () => {
    const numstatMock = vi.fn();
    numstatMock
      // Initial enumeration (claude's edits only).
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n")
      // Post-CHECK enumeration (same — CHECK_COMMAND did not add new files).
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n")
      // Post-build enumeration (claude's edits + regenerated dist).
      .mockReturnValueOnce(
        "5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n200\t150\tdist/post-fix/index.cjs\n",
      );
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: numstatMock,
      },
    );

    // TY-281: post-build re-check uses `checkScopeBuildMode`, which skips
    // unlocked default block patterns (including `dist/`). The user no
    // longer needs `LOOPPILOT_BLOCK_PATHS=!dist/` just to commit build
    // artifacts under `dist/`.
    const configWithBuild = {
      ...baseConfig,
      buildCommand: "npm run bundle",
    };
    await runPostFix(configWithBuild, deps, baseInputs);

    expect(deps.runBuildCommand).toHaveBeenCalledWith("npm run bundle");
    expect(deps.stagedPaths).toEqual([
      ["src/foo.ts", "tests/foo.test.ts", "dist/post-fix/index.cjs"],
    ]);
    expect(deps.commitMessages.length).toBe(1);
    expect(deps.commitMessages[0]).toContain("Files: 3, lines:");
    expect(deps.pushCalls.length).toBe(1);
  });

  it("TY-281: BUILD_COMMAND that produces no new changes leaves the staging set unchanged", async () => {
    // Both enumeration calls return the same numstat — `npm run bundle` ran
    // but produced no diff (dist/ was already in sync with src/).
    const numstatMock = vi
      .fn()
      .mockReturnValue("5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: numstatMock,
      },
    );

    const configWithBuild = { ...baseConfig, buildCommand: "npm run bundle" };
    await runPostFix(configWithBuild, deps, baseInputs);

    expect(deps.runBuildCommand).toHaveBeenCalledWith("npm run bundle");
    expect(deps.stagedPaths).toEqual([["src/foo.ts", "tests/foo.test.ts"]]);
    expect(deps.commitMessages.length).toBe(1);
  });

  it("TY-281: BUILD_COMMAND that erases all changes stops with action_failure", async () => {
    // The first numstat call returns claude's edits; the second (post-CHECK)
    // returns the same — CHECK_COMMAND made no additional changes; the third
    // (post-BUILD) returns empty — the build script erased everything back to
    // HEAD. Re-queuing would allow the loop to spin indefinitely because
    // loop-detection accounting is never advanced. Instead the run must stop
    // so the operator is notified.
    const numstatMock = vi
      .fn()
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n")
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n")
      .mockReturnValueOnce("");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: numstatMock,
      },
    );

    const configWithBuild = { ...baseConfig, buildCommand: "npm run bundle" };
    await runPostFix(configWithBuild, deps, baseInputs);

    expect(deps.runBuildCommand).toHaveBeenCalledWith("npm run bundle");
    // No commit or push — nothing to stage.
    expect(deps.commitMessages).toEqual([]);
    expect(deps.pushCalls).toEqual([]);
    // Stopped with action_failure; failureExit rolls back iteration accounting.
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "action_failure",
        iterationCount: 1,
        findingsHashHistory: [{ iteration: 1, hash: "aaaaaaaaaaaaaaaa" }],
      }),
      "github-token",
      expect.any(Object),
    );
    // No Codex review re-requested — the loop stops here.
    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
    // Stop comment posted.
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "action_failure",
      1234,
      0,
      expect.stringContaining("BUILD_COMMAND erased all working-tree changes"),
      "github-token",
    expect.any(Object),
    );
  });

  it("TY-281: BUILD_COMMAND non-zero exit resets the working tree and stops with action_failure", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        runBuildCommand: vi.fn().mockResolvedValue({
          success: false,
          output: "esbuild error: Cannot resolve './missing'",
        }),
      },
    );

    const configWithBuild = { ...baseConfig, buildCommand: "npm run bundle" };
    await runPostFix(configWithBuild, deps, baseInputs);

    expect(deps.runBuildCommand).toHaveBeenCalledWith("npm run bundle");
    // Build failure ⇒ working tree reset, no commit, no push.
    expect(deps.resetCalls).toBe(1);
    expect(deps.commitMessages).toEqual([]);
    expect(deps.pushCalls).toEqual([]);
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "action_failure",
        // Iteration + findings hash were claimed by pre-fix; since no commit
        // landed, they must roll back so a soft /restart-review with the
        // same Codex findings doesn't loop-detect immediately.
        iterationCount: 1,
        findingsHashHistory: [{ iteration: 1, hash: "aaaaaaaaaaaaaaaa" }],
      }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "action_failure",
      1234,
      0,
      expect.stringContaining("BUILD_COMMAND failed"),
      "github-token",
    expect.any(Object),
    );
  });

  it("TY-281: CHECK_COMMAND-modified files use strict scope, not relaxed build-mode scope (Finding 1)", async () => {
    // Claude only changes src/foo.ts (passes initial scope check).
    // CHECK_COMMAND also modifies package.json (a default-blocked path).
    // Without the post-CHECK re-enumeration fix, package.json would be
    // classified as a buildDeltaFile and pass the relaxed checkScopeBuildMode.
    // With the fix, package.json is in postCheckChangedFiles → preBuildFiles →
    // strict checkScope → scope_violation.
    const numstatMock = vi
      .fn()
      // Initial enumeration: only Claude's edit.
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n")
      // Post-CHECK enumeration: CHECK_COMMAND also touched package.json.
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n3\t1\tpackage.json\n")
      // Post-BUILD enumeration: same + dist artifact.
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n3\t1\tpackage.json\n200\t150\tdist/index.cjs\n");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      { gitDiffNumstat: numstatMock },
    );

    const configWithBuild = { ...baseConfig, buildCommand: "npm run bundle" };
    await runPostFix(configWithBuild, deps, baseInputs);

    // package.json is in preBuildFiles → strict checkScope → scope_violation.
    expect(deps.resetCalls).toBe(1);
    expect(deps.commitMessages).toEqual([]);
    expect(deps.pushCalls).toEqual([]);
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "scope_violation" }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "scope_violation",
      1234,
      0,
      expect.stringContaining("package.json"),
      "github-token",
    expect.any(Object),
    );
  });

  it("TY-281: BUILD_COMMAND that reverts all repairs but produces an artifact stops with action_failure (Finding 2)", async () => {
    // Claude changes src/foo.ts; CHECK_COMMAND passes without further changes.
    // BUILD_COMMAND reverts src/foo.ts (restores it to HEAD) but creates
    // dist/artifact.js. postBuildChangedFiles.length === 1 > 0, so the
    // existing all-erased guard does not fire. preBuildFiles is empty because
    // src/foo.ts no longer differs from HEAD — the new guard must catch this.
    const numstatMock = vi
      .fn()
      // Initial enumeration: Claude's edit.
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n")
      // Post-CHECK enumeration: same.
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n")
      // Post-BUILD enumeration: BUILD_COMMAND reverted src/foo.ts and produced dist artifact.
      .mockReturnValueOnce("200\t150\tdist/artifact.js\n");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      { gitDiffNumstat: numstatMock },
    );

    const configWithBuild = { ...baseConfig, buildCommand: "npm run bundle" };
    await runPostFix(configWithBuild, deps, baseInputs);

    expect(deps.runBuildCommand).toHaveBeenCalledWith("npm run bundle");
    // No commit or push — the repair was reverted.
    expect(deps.commitMessages).toEqual([]);
    expect(deps.pushCalls).toEqual([]);
    expect(deps.resetCalls).toBe(1);
    // Stopped with action_failure; failureExit rolls back iteration accounting.
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "action_failure",
        iterationCount: 1,
        findingsHashHistory: [{ iteration: 1, hash: "aaaaaaaaaaaaaaaa" }],
      }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "action_failure",
      1234,
      0,
      expect.stringContaining("BUILD_COMMAND reverted all repair edits"),
      "github-token",
    expect.any(Object),
    );
  });

  it("TY-281: BUILD_COMMAND that reverts a subset of repairs stops with action_failure (Finding 3)", async () => {
    // Claude changes src/fix1.ts and src/fix2.ts; CHECK_COMMAND passes without
    // further changes. BUILD_COMMAND keeps src/fix1.ts but reverts src/fix2.ts
    // (restores it to HEAD) and produces dist/artifact.js.
    // postBuildChangedFiles = [src/fix1.ts, dist/artifact.js] so:
    //   - postBuildChangedFiles.length > 0 → all-erased guard does not fire
    //   - preBuildFiles = [src/fix1.ts] (non-empty) → all-reverted guard does not fire
    //   - revertedPaths = [src/fix2.ts] → new partial-revert guard must catch this
    const numstatMock = vi
      .fn()
      // Initial enumeration: both of Claude's edits.
      .mockReturnValueOnce("5\t2\tsrc/fix1.ts\n3\t0\tsrc/fix2.ts\n")
      // Post-CHECK enumeration: same.
      .mockReturnValueOnce("5\t2\tsrc/fix1.ts\n3\t0\tsrc/fix2.ts\n")
      // Post-BUILD enumeration: fix2.ts reverted, dist artifact added.
      .mockReturnValueOnce("5\t2\tsrc/fix1.ts\n200\t150\tdist/artifact.js\n");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      { gitDiffNumstat: numstatMock },
    );

    const configWithBuild = { ...baseConfig, buildCommand: "npm run bundle" };
    await runPostFix(configWithBuild, deps, baseInputs);

    expect(deps.runBuildCommand).toHaveBeenCalledWith("npm run bundle");
    // No commit or push — the partial repair must not land.
    expect(deps.commitMessages).toEqual([]);
    expect(deps.pushCalls).toEqual([]);
    expect(deps.resetCalls).toBe(1);
    // Stopped with action_failure; failureExit rolls back iteration accounting.
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "action_failure",
        iterationCount: 1,
        findingsHashHistory: [{ iteration: 1, hash: "aaaaaaaaaaaaaaaa" }],
      }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "action_failure",
      1234,
      0,
      expect.stringContaining("BUILD_COMMAND reverted some repair edits"),
      "github-token",
    expect.any(Object),
    );
  });

  it("TY-281: CHECK_COMMAND scratch files cleaned up by BUILD_COMMAND do not trigger action_failure", async () => {
    // Claude changes src/fix.ts. CHECK_COMMAND passes and creates a scratch
    // file (tmp/check-report.json) as an untracked side-effect. BUILD_COMMAND
    // removes the scratch file (does not restore it) while producing the real
    // dist artifact. Without the fix, the scratch file disappearing from
    // postBuildPathSet would trigger the partial-revert guard even though
    // src/fix.ts (the real repair) is intact in post-BUILD.
    const numstatMock = vi
      .fn()
      // Initial enumeration: Claude's edit.
      .mockReturnValueOnce("5\t2\tsrc/fix.ts\n")
      // Post-CHECK enumeration: same (CHECK_COMMAND did not modify tracked files).
      .mockReturnValueOnce("5\t2\tsrc/fix.ts\n")
      // Post-BUILD enumeration: repair intact + dist artifact.
      .mockReturnValueOnce("5\t2\tsrc/fix.ts\n200\t100\tdist/bundle.cjs\n");
    const untrackedMock = vi
      .fn()
      // Initial enumeration: no untracked files.
      .mockReturnValueOnce("")
      // Post-CHECK enumeration: CHECK_COMMAND wrote a scratch report.
      .mockReturnValueOnce("tmp/check-report.json\n")
      // Post-BUILD enumeration: BUILD_COMMAND cleaned up the scratch file.
      .mockReturnValueOnce("")
      // Pre-commit secret scan enumeration (TY-274 follow-up).
      .mockReturnValueOnce("");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: numstatMock,
        gitListUntracked: untrackedMock,
        // TY-297 #1: the hoisted post-CHECK enumeration calls
        // `readWorkingTreeFile` for every untracked path. Give the scratch
        // file a text body so it is not flagged as a binary scope violation
        // before BUILD_COMMAND has a chance to clean it up.
        readWorkingTreeFile: (path) =>
          path === "tmp/check-report.json" ? "{}\n" : null,
      },
    );

    const configWithBuild = { ...baseConfig, buildCommand: "npm run bundle" };
    await runPostFix(configWithBuild, deps, baseInputs);

    // Scratch-file cleanup by BUILD_COMMAND is not a revert of the repair.
    // The run must succeed: commit and push happen, no reset.
    expect(deps.runBuildCommand).toHaveBeenCalledWith("npm run bundle");
    expect(deps.resetCalls).toBe(0);
    expect(deps.commitMessages.length).toBe(1);
    expect(deps.pushCalls.length).toBe(1);
  });

  it("TY-297 #2: CHECK_COMMAND scratch file exceeding maxFiles does not cause scope_violation when buildCommand is configured", async () => {
    // Claude edits src/fix.ts (1 file). CHECK_COMMAND creates a scratch report
    // (tmp/check-report.json), pushing the post-CHECK count to 2 files.
    // scopeMaxFiles: 1 means the early post-CHECK gate would fire a false
    // scope_violation before BUILD_COMMAND even runs. BUILD_COMMAND removes the
    // scratch file and creates dist/bundle.cjs. Only src/fix.ts (1 file) is a
    // preBuildFile, which is within the limit.
    const numstatMock = vi
      .fn()
      // Initial enumeration: claude's edit.
      .mockReturnValueOnce("5\t2\tsrc/fix.ts\n")
      // Post-CHECK enumeration: same (CHECK_COMMAND did not modify tracked files).
      .mockReturnValueOnce("5\t2\tsrc/fix.ts\n")
      // Post-BUILD enumeration: repair intact + dist artifact.
      .mockReturnValueOnce("5\t2\tsrc/fix.ts\n200\t100\tdist/bundle.cjs\n");
    const untrackedMock = vi
      .fn()
      // Initial enumeration: no untracked files.
      .mockReturnValueOnce("")
      // Post-CHECK enumeration: CHECK_COMMAND wrote a scratch report.
      .mockReturnValueOnce("tmp/check-report.json\n")
      // Post-BUILD enumeration: BUILD_COMMAND cleaned up the scratch file.
      .mockReturnValueOnce("")
      // Pre-commit secret scan enumeration.
      .mockReturnValueOnce("");
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: numstatMock,
        gitListUntracked: untrackedMock,
        readWorkingTreeFile: (path) =>
          path === "tmp/check-report.json" ? "{}\n" : null,
      },
    );

    // scopeMaxFiles: 1 — the single repair file is within budget, but the
    // transient scratch file (present only between CHECK and BUILD) would push
    // the count to 2 and fire the pre-build gate without this fix.
    const configWithBuild = { ...baseConfig, buildCommand: "npm run bundle", scopeMaxFiles: 1 };
    await runPostFix(configWithBuild, deps, baseInputs);

    // The run must succeed: BUILD_COMMAND runs, commit and push happen, no reset.
    expect(deps.runBuildCommand).toHaveBeenCalledWith("npm run bundle");
    expect(deps.resetCalls).toBe(0);
    expect(deps.commitMessages.length).toBe(1);
    expect(deps.pushCalls.length).toBe(1);
  });

  it("TY-281: post-build scope check rejects build artifacts that land in blocked paths", async () => {
    // A misconfigured BUILD_COMMAND that writes into the locked `.github/`
    // tree must trip the post-build scope re-check rather than slip into
    // the commit. `.github/` is locked (TY-271) so even `!.github/...` is
    // ignored — there is no override path.
    const numstatMock = vi
      .fn()
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n")
      // Post-CHECK enumeration (same — CHECK_COMMAND did not add new files).
      .mockReturnValueOnce("5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n")
      .mockReturnValueOnce(
        "5\t2\tsrc/foo.ts\n3\t0\ttests/foo.test.ts\n10\t0\t.github/workflows/leaked.yml\n",
      );
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState(),
      },
      {
        gitDiffNumstat: numstatMock,
      },
    );

    const configWithBuild = { ...baseConfig, buildCommand: "npm run bundle" };
    await runPostFix(configWithBuild, deps, baseInputs);

    expect(deps.runBuildCommand).toHaveBeenCalledWith("npm run bundle");
    // Build "succeeded" (non-zero exit was not the trigger) but produced a
    // scope-violating artifact → reset, no commit, scope_violation stop.
    expect(deps.resetCalls).toBe(1);
    expect(deps.commitMessages).toEqual([]);
    expect(deps.pushCalls).toEqual([]);
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "scope_violation",
      }),
      "github-token",
      expect.any(Object),
    );
  });

  // TY-306 #1: `intentToAdd` must sit inside the try block so a partway
  // failure (the second of N paths throws) still hits the finally that
  // calls `resetIntentToAdd`. Previously the call was outside the try, so
  // a throw skipped cleanup and let stale intent-to-add entries pollute
  // the index across the `demoteFixingOnCrash` path.
  describe("TY-306 #1: scanWithIntentToAdd cleans up after intentToAdd partway failure", () => {
    it("#A: resetIntentToAdd is invoked even when intentToAdd throws synchronously", async () => {
      const resetCalls: string[][] = [];
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T12:00:00Z",
          state: makeState(),
        },
        {
          gitDiffNumstat: () => "",
          gitListUntracked: () => "src/new-leak.ts\nsrc/new-other.ts\n",
          readWorkingTreeFile: () => "",
          intentToAdd: () => {
            throw new Error("git add --intent-to-add failed on path 2");
          },
          resetIntentToAdd: (paths) => {
            resetCalls.push([...paths]);
          },
        },
      );

      await expect(runPostFix(baseConfig, deps, baseInputs)).rejects.toThrow(
        "git add --intent-to-add failed on path 2",
      );

      // finally must have fired with the full path list so stale index
      // entries (if any partial intent-to-add succeeded) get cleaned up.
      expect(resetCalls).toContainEqual([
        "src/new-leak.ts",
        "src/new-other.ts",
      ]);
    });

    it("#B: re-throws the original intentToAdd error (caller error handling regression)", async () => {
      const originalError = new Error("intent-to-add hardware error");
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T12:00:00Z",
          state: makeState(),
        },
        {
          gitDiffNumstat: () => "",
          gitListUntracked: () => "src/new.ts\n",
          readWorkingTreeFile: () => "",
          intentToAdd: () => {
            throw originalError;
          },
        },
      );

      await expect(runPostFix(baseConfig, deps, baseInputs)).rejects.toBe(
        originalError,
      );
    });

    it("#C: happy path still calls intentToAdd then resetIntentToAdd in order (regression)", async () => {
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T12:00:00Z",
          state: makeState(),
        },
        {
          gitDiffNumstat: () => "",
          gitListUntracked: () => "src/new.ts\n",
          gitDiffHead: () => "",
          readWorkingTreeFile: () => "",
        },
      );

      await runPostFix(baseConfig, deps, baseInputs);

      expect(deps.intentToAddCalls).toContainEqual(["src/new.ts"]);
      expect(deps.resetIntentToAddCalls).toContainEqual(["src/new.ts"]);
    });
  });
});

function makeWarn(path: string, pattern = "high-entropy-long-string"): SecretScanFinding {
  return { pattern, severity: "warn", path };
}

function makeHard(path: string, pattern = "github-pat-classic"): SecretScanFinding {
  return { pattern, severity: "hard", path };
}

describe("logSecretScanWarnings (TY-298 #2)", () => {
  it("suppresses WARN lines for hash-bearing paths and emits a summary instead", async () => {
    const result: SecretScanResult = {
      hardFailures: [],
      warnings: [
        makeWarn("package-lock.json"),
        makeWarn("pnpm-lock.yaml"),
        makeWarn("yarn.lock"),
        makeWarn("Cargo.lock"),
        makeWarn("poetry.lock"),
        makeWarn("Pipfile.lock"),
        makeWarn("composer.lock"),
        makeWarn("dist/post-fix/index.cjs"),
        makeWarn("dist/init/index.cjs.map"),
        makeWarn("tests/__snapshots__/foo.snap"),
        makeWarn("client/bun.lockb"),
        makeWarn("nested/path/package-lock.json"),
      ],
    };
    const info = vi.fn();

    logSecretScanWarnings(result, "pre-check", { info });

    // No individual WARN line should be emitted for any of these paths.
    const individualLines = info.mock.calls
      .map((c) => c[0])
      .filter((m) => m.startsWith("[secret-scan] WARN stage="));
    expect(individualLines).toEqual([]);
    // A single summary line must surface the suppression count.
    const summaries = info.mock.calls
      .map((c) => c[0])
      .filter((m) => m.startsWith("[secret-scan] WARN summary"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("stage=pre-check");
    expect(summaries[0]).toContain("logged=0");
    expect(summaries[0]).toContain("suppressed_by_path=12");
    expect(summaries[0]).toContain("capped_over=0");
  });

  it("caps the per-stage log volume at SECRET_WARN_LOG_CAP and folds the rest into the summary", async () => {
    const warnings: SecretScanFinding[] = Array.from(
      { length: SECRET_WARN_LOG_CAP + 10 },
      (_, i) => makeWarn(`src/file-${i}.ts`),
    );
    const info = vi.fn();

    logSecretScanWarnings({ hardFailures: [], warnings }, "pre-commit", { info });

    const individualLines = info.mock.calls
      .map((c) => c[0])
      .filter((m) => m.startsWith("[secret-scan] WARN stage="));
    expect(individualLines).toHaveLength(SECRET_WARN_LOG_CAP);
    // Each individual line carries the per-finding stage / path / pattern.
    expect(individualLines[0]).toContain("path=src/file-0.ts");
    expect(individualLines[SECRET_WARN_LOG_CAP - 1]).toContain(
      `path=src/file-${SECRET_WARN_LOG_CAP - 1}.ts`,
    );

    const summaries = info.mock.calls
      .map((c) => c[0])
      .filter((m) => m.startsWith("[secret-scan] WARN summary"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("stage=pre-commit");
    expect(summaries[0]).toContain(`logged=${SECRET_WARN_LOG_CAP}`);
    expect(summaries[0]).toContain("suppressed_by_path=0");
    expect(summaries[0]).toContain("capped_over=10");
  });

  it("ignores hard-fail findings — they are logged by the caller via deps.error and must not surface as WARN lines", async () => {
    // The function intentionally consumes only `result.warnings`. Putting hard
    // findings in the same struct should not cause them to leak into the
    // warning log stream — the caller already prints them via `deps.error`.
    const result: SecretScanResult = {
      hardFailures: [
        makeHard("src/leak.ts"),
        makeHard("src/another-leak.ts"),
      ],
      warnings: [],
    };
    const info = vi.fn();

    logSecretScanWarnings(result, "pre-check", { info });

    // No WARN line, no summary line (nothing to summarize when both counters
    // are zero) — the log is entirely silent.
    expect(info).not.toHaveBeenCalled();
  });

  it("does not emit a summary line when every WARN was logged and nothing was suppressed", async () => {
    const result: SecretScanResult = {
      hardFailures: [],
      warnings: [makeWarn("src/foo.ts"), makeWarn("src/bar.ts")],
    };
    const info = vi.fn();

    logSecretScanWarnings(result, "pre-check", { info });

    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[0][0]).toContain("path=src/foo.ts");
    expect(info.mock.calls[1][0]).toContain("path=src/bar.ts");
    // No summary noise on the common no-suppression path.
    const summaries = info.mock.calls
      .map((c) => c[0])
      .filter((m) => m.startsWith("[secret-scan] WARN summary"));
    expect(summaries).toEqual([]);
  });

  // TY-304: the cap is per-pattern, not shared. A noisy pattern saturating
  // its own budget must NOT push the first observation of a low-FP pattern
  // out of the log — otherwise the "WARN observation → HARD promote" track
  // record breaks for the pattern operators care most about.
  describe("TY-304: per-pattern cap keeps low-FP patterns observable", () => {
    it("#A: credential-assignment is still logged when high-entropy-long-string saturates its own cap", () => {
      const warnings: SecretScanFinding[] = [
        ...Array.from({ length: SECRET_WARN_LOG_CAP + 5 }, (_, i) =>
          makeWarn(`src/foo-${i}.ts`, "high-entropy-long-string"),
        ),
        makeWarn("src/bar.ts", "credential-assignment"),
      ];
      const info = vi.fn();

      logSecretScanWarnings({ hardFailures: [], warnings }, "pre-check", {
        info,
      });

      const individualLines = info.mock.calls
        .map((c) => c[0])
        .filter((m: string) => m.startsWith("[secret-scan] WARN stage="));
      const credentialLines = individualLines.filter((m: string) =>
        m.includes("pattern=credential-assignment"),
      );
      expect(credentialLines).toHaveLength(1);
      expect(credentialLines[0]).toContain("path=src/bar.ts");
    });

    it("#B: total individual log lines = SECRET_WARN_LOG_CAP per saturated pattern + each non-saturated pattern's full count", () => {
      const warnings: SecretScanFinding[] = [
        ...Array.from({ length: SECRET_WARN_LOG_CAP + 5 }, (_, i) =>
          makeWarn(`src/foo-${i}.ts`, "high-entropy-long-string"),
        ),
        makeWarn("src/bar.ts", "credential-assignment"),
      ];
      const info = vi.fn();

      logSecretScanWarnings({ hardFailures: [], warnings }, "pre-check", {
        info,
      });

      const individualLines = info.mock.calls
        .map((c) => c[0])
        .filter((m: string) => m.startsWith("[secret-scan] WARN stage="));
      // SECRET_WARN_LOG_CAP entropy lines + 1 credential line.
      expect(individualLines).toHaveLength(SECRET_WARN_LOG_CAP + 1);
      // Plus exactly one summary line because some entropy entries were
      // capped (= capped_over > 0).
      expect(info).toHaveBeenCalledTimes(SECRET_WARN_LOG_CAP + 1 + 1);
    });

    it("#C: summary line lists only the patterns that hit their cap", () => {
      const warnings: SecretScanFinding[] = [
        ...Array.from({ length: SECRET_WARN_LOG_CAP + 3 }, (_, i) =>
          makeWarn(`src/foo-${i}.ts`, "high-entropy-long-string"),
        ),
        makeWarn("src/bar.ts", "credential-assignment"),
      ];
      const info = vi.fn();

      logSecretScanWarnings({ hardFailures: [], warnings }, "pre-check", {
        info,
      });

      const summaries = info.mock.calls
        .map((c) => c[0])
        .filter((m: string) => m.startsWith("[secret-scan] WARN summary"));
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toContain(
        "capped patterns: high-entropy-long-string",
      );
      expect(summaries[0]).not.toContain("credential-assignment");
      expect(summaries[0]).toContain("capped_over=3");
    });

    it("#D: path suppression is still honored independently of the per-pattern cap (regression)", () => {
      // Hash-bearing paths must remain fully suppressed regardless of pattern,
      // and must not consume any pattern's logging budget.
      const warnings: SecretScanFinding[] = [
        makeWarn("package-lock.json", "high-entropy-long-string"),
        makeWarn("pnpm-lock.yaml", "credential-assignment"),
        makeWarn("src/foo.ts", "high-entropy-long-string"),
      ];
      const info = vi.fn();

      logSecretScanWarnings({ hardFailures: [], warnings }, "pre-check", {
        info,
      });

      const individualLines = info.mock.calls
        .map((c) => c[0])
        .filter((m: string) => m.startsWith("[secret-scan] WARN stage="));
      expect(individualLines).toHaveLength(1);
      expect(individualLines[0]).toContain("path=src/foo.ts");

      const summaries = info.mock.calls
        .map((c) => c[0])
        .filter((m: string) => m.startsWith("[secret-scan] WARN summary"));
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toContain("suppressed_by_path=2");
      expect(summaries[0]).toContain("capped_over=0");
      expect(summaries[0]).not.toContain("capped patterns:");
    });

    it("#E: hard-fail findings are unaffected — still ignored by this helper (regression)", () => {
      const result: SecretScanResult = {
        hardFailures: [
          makeHard("src/leak.ts", "github-pat-classic"),
          makeHard("src/another-leak.ts", "github-pat-classic"),
        ],
        warnings: [],
      };
      const info = vi.fn();

      logSecretScanWarnings(result, "pre-check", { info });

      expect(info).not.toHaveBeenCalled();
    });
  });
});

// TY-326 #2 (BUG-04): untracked added-line counts must match `git diff
// --numstat` so the scope maxLines budget is symmetric with tracked files.
describe("countUntrackedAddedLines", () => {
  it("does not over-count the trailing newline (matches git's added-line count)", () => {
    // git reports 2 additions for "a\nb\n"; split("\n") would yield 3.
    expect(countUntrackedAddedLines("a\nb\n")).toBe(2);
  });

  it("counts a file with no trailing newline by its line count", () => {
    expect(countUntrackedAddedLines("a\nb")).toBe(2);
    expect(countUntrackedAddedLines("only-one-line")).toBe(1);
  });

  it("returns 0 for empty content", () => {
    expect(countUntrackedAddedLines("")).toBe(0);
  });

  it("counts a single trailing-newline line as 1", () => {
    expect(countUntrackedAddedLines("a\n")).toBe(1);
  });
});

// BUG-3: `git ls-files --others` C-quotes paths with control characters even
// under `core.quotepath=false`. The untracked builders must decode those the
// same way `parseGitNumstat` does for tracked paths (TY-306 #2); otherwise the
// quoted literal hits `readWorkingTreeFile` → ENOENT → marked binary → spurious
// scope_violation.
describe("decodeLsFilesPath", () => {
  it("returns ordinary unquoted paths unchanged (no-op)", () => {
    expect(decodeLsFilesPath("src/foo.ts")).toBe("src/foo.ts");
    expect(decodeLsFilesPath("tests/fixtures/a b.json")).toBe(
      "tests/fixtures/a b.json",
    );
  });

  it("leaves an unquoted name containing ' => ' intact", () => {
    // ls-files never emits rename notation; ' => ' is a legitimate filename
    // substring and must not be touched.
    expect(decodeLsFilesPath("src/arrow => fn.ts")).toBe("src/arrow => fn.ts");
  });

  it("decodes a C-quoted path with embedded tab / newline / quote", () => {
    expect(decodeLsFilesPath('"src/foo\\tbar.ts"')).toBe("src/foo\tbar.ts");
    expect(decodeLsFilesPath('"src/foo\\nbar.ts"')).toBe("src/foo\nbar.ts");
    expect(decodeLsFilesPath('"a\\"b.ts"')).toBe('a"b.ts');
  });
});

describe("runPostFix — ES-496 max_turns escalated auto-retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const retryConfig: Config = { ...baseConfig, autoRetryEscalateMaxTurns: true };
  const maxTurnsInputs: PostFixInputs = {
    ...baseInputs,
    actionOutcome: "failure",
    actionExecutionFile: "/tmp/execution.json",
  };
  // Last iteration ran the base tier → auto-retry is eligible.
  const baseTierState = () =>
    makeState({
      findingsHashHistory: [
        { iteration: 1, hash: "aaaaaaaaaaaaaaaa", modelTier: "base" },
        { iteration: 2, hash: "bbbbbbbbbbbbbbbb", modelTier: "base" },
      ],
    });
  const detectsMaxTurns = { readActionExecutionFile: () => "Error: Reached max_turns limit" };

  const findWrite = (deps: PostFixDeps, pred: (s: ReviewState) => boolean) =>
    vi
      .mocked(deps.updateStateComment)
      .mock.calls.map((c) => c[3] as ReviewState)
      .find(pred);

  it("re-requests @codex review and returns to waiting_codex (no stop) on a base-tier max_turns_exceeded", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: baseTierState(),
      },
      detectsMaxTurns,
    );

    await runPostFix(retryConfig, deps, maxTurnsInputs);

    // Working tree reverted; no stop comment; escalated retry requested.
    expect(deps.resetCalls).toBe(1);
    expect(deps.postCodexReviewRequest).toHaveBeenCalledTimes(1);
    expect(deps.postComment).toHaveBeenCalled();
    const auditBody = vi.mocked(deps.postComment).mock.calls[0]?.[3] as string;
    // The operator-facing content that matters: why @codex review reappeared
    // without /restart-review, and which tier the retry uses.
    expect(auditBody).toContain("auto-retry");
    expect(auditBody).toContain("/restart-review");
    expect(auditBody).toContain(baseConfig.claudeCodeModelEscalated);
    expect(deps.postStopComment).not.toHaveBeenCalled();

    // waiting_codex preserving stopReason, with the base iteration rolled back
    // and the re-review request id persisted.
    const waiting = findWrite(deps, (s) => s.status === "waiting_codex");
    expect(waiting).toBeDefined();
    expect(waiting?.stopReason).toBe("max_turns_exceeded");
    expect(waiting?.iterationCount).toBe(1);
    expect(waiting?.findingsHashHistory).toHaveLength(1);
    expect(
      findWrite(
        deps,
        (s) => s.status === "waiting_codex" && s.lastCodexRequestCommentId === 22,
      ),
    ).toBeDefined();
    // Never wrote a stopped state.
    expect(findWrite(deps, (s) => s.status === "stopped")).toBeUndefined();
  });

  it("does NOT auto-retry when the last iteration already ran the escalated tier (one-shot)", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: makeState({
          findingsHashHistory: [
            { iteration: 1, hash: "aaaaaaaaaaaaaaaa", modelTier: "base" },
            { iteration: 2, hash: "bbbbbbbbbbbbbbbb", modelTier: "escalated" },
          ],
        }),
      },
      detectsMaxTurns,
    );

    await runPostFix(retryConfig, deps, maxTurnsInputs);

    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
    expect(findWrite(deps, (s) => s.status === "stopped" && s.stopReason === "max_turns_exceeded")).toBeDefined();
  });

  it("does NOT auto-retry when the toggle is off (default)", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: baseTierState(),
      },
      detectsMaxTurns,
    );

    await runPostFix(baseConfig, deps, maxTurnsInputs);

    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
    expect(findWrite(deps, (s) => s.status === "stopped" && s.stopReason === "max_turns_exceeded")).toBeDefined();
  });

  it("does NOT auto-retry when base and escalated models are identical", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: baseTierState(),
      },
      detectsMaxTurns,
    );

    await runPostFix(
      { ...retryConfig, claudeCodeModelEscalated: baseConfig.claudeCodeModelBase },
      deps,
      maxTurnsInputs,
    );

    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
    expect(findWrite(deps, (s) => s.status === "stopped" && s.stopReason === "max_turns_exceeded")).toBeDefined();
  });

  it("does NOT auto-retry a non-max_turns action failure (e.g. action_failure)", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: baseTierState(),
      },
      // default readActionExecutionFile returns null → not max_turns
    );

    await runPostFix(retryConfig, deps, { ...baseInputs, actionOutcome: "failure" });

    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
    expect(findWrite(deps, (s) => s.status === "stopped" && s.stopReason === "action_failure")).toBeDefined();
  });

  it("demotes to stopped/codex_request_failed when the auto-retry @codex review post fails", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: baseTierState(),
      },
      {
        ...detectsMaxTurns,
        postCodexReviewRequest: vi.fn().mockRejectedValue(new Error("gh down")),
      },
    );

    await runPostFix(retryConfig, deps, maxTurnsInputs);

    expect(findWrite(deps, (s) => s.status === "stopped" && s.stopReason === "codex_request_failed")).toBeDefined();
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "codex_request_failed",
      1234,
      0,
      expect.any(String),
      "github-token",
      expect.any(Object),
    );
  });

  it("demotes to stopped/codex_request_failed when Codex does not ACK the auto-retry", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T12:00:00Z",
        state: baseTierState(),
      },
      {
        ...detectsMaxTurns,
        ensureCodexAck: vi.fn().mockResolvedValue({
          acked: false,
          reason: "timeout",
          reposts: 2,
          lastCommentId: 77,
        }),
      },
    );

    await runPostFix(retryConfig, deps, maxTurnsInputs);

    expect(deps.postCodexReviewRequest).toHaveBeenCalledTimes(1);
    const stopped = findWrite(deps, (s) => s.status === "stopped" && s.stopReason === "codex_request_failed");
    expect(stopped).toBeDefined();
    expect(stopped?.lastCodexRequestCommentId).toBe(77);
  });
});
