import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { runPreFix, type PreFixDeps, type PreFixOutputName } from "../src/main-pre-fix.js";
import { createInitialState } from "../src/state-manager.js";
import type { ReadStateResult } from "../src/state-manager.js";
import { computeFindingsHash } from "../src/findings-hash.js";
import { filterAndParseComments } from "../src/review-collector.js";
import { MAX_FINDINGS_PER_REQUEST } from "../src/claude-code-repair-request.js";
import type { RawReviewComment, ReviewState } from "../src/types.js";

const baseConfig: Config = {
  maxReviewIterations: 20,
  debounceSeconds: 0,
  checkCommand: "npm run check",
  buildCommand: "",
  codexBotLogin: "chatgpt-codex-connector[bot]",
  stabilizeIntervalSeconds: 1,
  stabilizeCount: 1,
  codexReviewRequestToken: "codex-token",
  autoReviewPushToken: "github-token",
  anthropicApiKey: "anthropic-key",
  claudeCodeOauthToken: "",
  githubToken: "github-token",
  repoOwner: "edereship",
  repoName: "loop-pilot",
  prNumber: 99,
  triggerCommentId: 1234,
  triggerCommentBody: "Codex Review summary",
  triggerUserLogin: "chatgpt-codex-connector[bot]",
  triggerEventName: "issue_comment",
  prHeadRef: "linear/TY-237",
  prTitle: "TY-237: split main-loop",
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

function makeState(overrides: Partial<ReviewState> = {}): ReviewState {
  return { ...createInitialState(), ...overrides };
}

interface OutputRecord {
  outputs: Record<string, string>;
}

function makeDeps(
  readResult: ReadStateResult,
  reviewComments: RawReviewComment[] = [],
): PreFixDeps & OutputRecord {
  const outputs: Record<string, string> = {};
  return {
    readState: vi.fn().mockResolvedValue(readResult),
    updateStateComment: vi.fn().mockResolvedValue({ updatedAt: "2026-05-14T12:00:00Z" }),
    fetchReviewComments: vi.fn().mockResolvedValue(reviewComments),
    stabilizeReviewComments: vi.fn().mockResolvedValue(reviewComments),
    postCompletionComment: vi.fn().mockResolvedValue(1),
    postFixingStartComment: vi.fn().mockResolvedValue(4),
    postStopComment: vi.fn().mockResolvedValue(2),
    postInitIncompleteComment: vi.fn().mockResolvedValue(3),
    postAutoMergeSkipNotification: vi.fn().mockResolvedValue(undefined),
    mergeIfChecksPass: vi.fn().mockResolvedValue(undefined),
    fetchPrLabels: vi.fn().mockResolvedValue(["loop-pilot"]),
    validateRestartCommand: vi.fn().mockResolvedValue({ valid: false, handled: false }),
    executeRestartWithCodexReview: vi.fn().mockResolvedValue(undefined),
    handleRestartWithRepair: vi.fn().mockResolvedValue(null),
    fetchUnresolvedCodexFindings: vi.fn().mockResolvedValue({ findings: [], latestOutdatedAt: null }),
    setSecret: vi.fn(),
    setOutput: (name: PreFixOutputName, value: string) => {
      outputs[name] = value;
    },
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    sleep: vi.fn().mockResolvedValue(undefined),
    now: () => new Date("2026-05-14T12:00:00Z"),
    readHeadSha: () => "deadbeef",
    checkoutBranch: vi.fn(),
    fetchPrHeadRepoFullName: vi
      .fn()
      .mockResolvedValue("edereship/loop-pilot"),
    // ES-506: default to "the triggering review reviewed HEAD" (readHeadSha
    // returns "deadbeef") so a review-triggered no-findings run reaches `done`.
    // Comment-triggered runs bypass the guard and never call this.
    fetchReviewCommitById: vi.fn().mockResolvedValue("deadbeef"),
    outputs,
  };
}

describe("runPreFix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["attacker/loop-pilot", "fork head repo"],
    ["", "deleted/unknown head repo"],
  ])(
    "refuses to run (should_run=false, no state mutation) for a %s",
    async (headRepo) => {
      const deps = makeDeps({
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      });
      deps.fetchPrHeadRepoFullName = vi.fn().mockResolvedValue(headRepo);

      await runPreFix(baseConfig, deps);

      expect(deps.outputs.should_run).toBe("false");
      expect(deps.updateStateComment).not.toHaveBeenCalled();
      expect(deps.validateRestartCommand).not.toHaveBeenCalled();
      expect(deps.fetchPrLabels).not.toHaveBeenCalled();
      expect(deps.error).toHaveBeenCalled();
    },
  );

  it("allows a case-drifted same-repo head repo (case-insensitive match)", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({ status: "done" }),
    });
    deps.fetchPrHeadRepoFullName = vi
      .fn()
      .mockResolvedValue("Edereship/Loop-Pilot");

    await runPreFix(baseConfig, deps);

    // Passes the fork guard; proceeds to the normal `done` skip (no error).
    expect(deps.error).not.toHaveBeenCalled();
    expect(deps.fetchPrLabels).toHaveBeenCalled();
  });

  it("emits should_run=false when the gate label is missing", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({ status: "waiting_codex" }),
    });
    deps.fetchPrLabels = vi.fn().mockResolvedValue([]);

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.postStopComment).not.toHaveBeenCalled();
  });

  it("returns silently when no hidden state exists", async () => {
    const deps = makeDeps({ found: false, corrupted: false, commentId: null });

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.postStopComment).not.toHaveBeenCalled();
  });

  it.each(["stopped", "done"] as const)(
    "skips when status is %s",
    async (status) => {
      const deps = makeDeps({
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status }),
      });

      await runPreFix(baseConfig, deps);

      expect(deps.outputs.should_run).toBe("false");
      expect(deps.updateStateComment).not.toHaveBeenCalled();
    },
  );

  it("recovers stale 'fixing' state via workflow_crashed so /restart-review can resume (TY-282 #1B)", async () => {
    const staleStartedAt = new Date("2026-05-14T10:00:00Z").toISOString();
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({
        status: "fixing",
        // TY-273 #B4: stale detection now anchors on `fixingStartedAt`. The
        // legacy fallback to `lastCodexReviewReceivedAt` is still exercised
        // here to confirm pre-TY-273 state comments keep recovering.
        lastCodexReviewReceivedAt: staleStartedAt,
      }),
    });

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("false");
    // TY-282 #1B: stale recovery used to write state_corrupted, which
    // applyRestartToState rejects. Switched to workflow_crashed so the
    // operator can /restart-review without manual hidden-comment surgery.
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "workflow_crashed",
        fixingStartedAt: null,
      }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postStopComment).toHaveBeenCalled();
    expect((deps.postStopComment as ReturnType<typeof vi.fn>).mock.calls[0][3]).toBe(
      "workflow_crashed",
    );
  });

  it("TY-302 #1: stale 'fixing' recovery rolls back the orphan iteration / findings-hash entry pre-fix Phase 3 claimed", async () => {
    // The stale-fixing recovery used to only flip status + clear
    // fixingStartedAt, leaving the orphan iterationCount + findingsHashHistory
    // entry pre-fix Phase 3 had claimed before the prior workflow died.
    // The first soft `/restart-review` would then `loop_detected` immediately
    // because next pre-fix's hash matched the orphan entry. Now the rollback
    // shares `rollbackFixingClaim` with `demoteFixingOnCrash` / failureExit.
    const staleStartedAt = new Date("2026-05-14T10:00:00Z").toISOString();
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({
        status: "fixing",
        fixingStartedAt: staleStartedAt,
        iterationCount: 3,
        findingsHashHistory: [
          { iteration: 1, hash: "aaaaaaaaaaaaaaaa", modelTier: "base" },
          { iteration: 2, hash: "bbbbbbbbbbbbbbbb", modelTier: "base" },
          { iteration: 3, hash: "cccccccccccccccc", modelTier: "escalated" },
        ],
        lastFindingsHash: "cccccccccccccccc",
        // TY-360: the crashed iteration claimed these ids; recovery must clear
        // them so a soft /restart-review does not resolve unrepaired threads.
        currentIterationFindingCommentIds: [9001, 9002],
      }),
    });

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "workflow_crashed",
        iterationCount: 2,
        findingsHashHistory: [
          { iteration: 1, hash: "aaaaaaaaaaaaaaaa", modelTier: "base" },
          { iteration: 2, hash: "bbbbbbbbbbbbbbbb", modelTier: "base" },
        ],
        lastFindingsHash: "bbbbbbbbbbbbbbbb",
        fixingStartedAt: null,
        currentIterationFindingCommentIds: [],
      }),
      "github-token",
      expect.any(Object),
    );
  });

  // TY-273 #B4: `fixingStartedAt` is the authoritative stale-detection
  // timestamp once a state comment has been written by post-TY-273 code.

  it("TY-273 #B4: prefers fixingStartedAt over lastCodexReviewReceivedAt for stale detection", async () => {
    // lastCodexReviewReceivedAt looks ancient (would trip stale recovery),
    // but a fresh fixingStartedAt means the fixing claim is recent so the
    // loop should skip without downgrading.
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({
        status: "fixing",
        lastCodexReviewReceivedAt: "2026-05-14T10:00:00Z",
        fixingStartedAt: "2026-05-14T11:55:00Z",
      }),
    });

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.postStopComment).not.toHaveBeenCalled();
  });

  it("TY-273 #B4: persists fixingStartedAt = now() on the Phase 3 fixing transition", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 300,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P1 Missing null guard\n\nGuard the dereference.",
        path: "src/foo.ts",
        line: 9,
        createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex", iterationCount: 1 }),
      },
      findings,
    );

    await runPreFix(baseConfig, deps);

    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({
        status: "fixing",
        // mock now() returns 2026-05-14T12:00:00Z.
        fixingStartedAt: "2026-05-14T12:00:00.000Z",
        // TY-360: the in-scope finding's source comment id is persisted so
        // post-fix can resolve the matching review thread after the repair.
        currentIterationFindingCommentIds: [300],
      }),
      "github-token",
      expect.any(Object),
    );
    // TY-291 #2 (UX-05): the fixing transition must also refresh the visible
    // status comment so operators see "Fixing — iteration N starting" during
    // the multi-minute claude-code-action run.
    expect(deps.postFixingStartComment).toHaveBeenCalledTimes(1);
    expect(deps.postFixingStartComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      2,
      expect.stringMatching(/^(base|escalated)$/),
      20,
      1, // findings.length from the single finding in this test
      "github-token",
    );
  });

  it("TY-360: persists only the embedded (top-MAX) finding comment ids when findings overflow the cap", async () => {
    // Build MAX_FINDINGS_PER_REQUEST + 1 in-scope P1 findings. Only the
    // top-MAX make it into the repair request, so only their source comment
    // ids may be persisted — the dropped lowest-priority finding's id must not
    // be carried into post-fix, or post-fix would resolve a thread that was
    // never sent to the repair agent.
    const overflow = MAX_FINDINGS_PER_REQUEST + 1;
    const findings: RawReviewComment[] = Array.from({ length: overflow }, (_, i) => {
      const n = String(i).padStart(3, "0");
      return {
        id: 1000 + i,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: `P1 finding ${n}\n\nbody ${n}`,
        path: `src/file-${n}.ts`,
        line: 9,
        createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
      };
    });
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex", iterationCount: 1 }),
      },
      findings,
    );

    await runPreFix(baseConfig, deps);

    const fixingCall = vi
      .mocked(deps.updateStateComment)
      .mock.calls.find(
        (c) => (c[3] as Partial<ReviewState> | undefined)?.status === "fixing",
      );
    expect(fixingCall).toBeDefined();
    const ids = (fixingCall![3] as ReviewState).currentIterationFindingCommentIds;
    expect(ids).toHaveLength(MAX_FINDINGS_PER_REQUEST);
    // The dropped (lowest-priority, last-sorted) finding's id must be excluded.
    expect(ids).not.toContain(1000 + MAX_FINDINGS_PER_REQUEST);
    // The persisted ids must be exactly the embedded top-MAX set (ids 1000..),
    // not merely "the right length minus the dropped id" — pin the membership so
    // a future reorder of selectEmbeddedFindings cannot silently persist a
    // different subset than the one forwarded for repair.
    expect([...ids].sort((a, b) => a - b)).toEqual(
      Array.from({ length: MAX_FINDINGS_PER_REQUEST }, (_, i) => 1000 + i),
    );
  });

  it("does not double-process the same trigger comment", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({
        status: "waiting_codex",
        lastProcessedReviewId: baseConfig.triggerCommentId,
      }),
    });

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.fetchReviewComments).not.toHaveBeenCalled();
  });

  it("marks done when no findings are returned", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      [], // no comments → no findings
    );

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({ status: "done", stopReason: "no_findings" }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postCompletionComment).toHaveBeenCalled();
    expect(deps.mergeIfChecksPass).not.toHaveBeenCalled();
  });

  // The premature-done race is driven by a `pull_request_review` trigger, so
  // these ES-506 tests run with triggerEventName = "pull_request_review".
  const reviewTriggerConfig: Config = {
    ...baseConfig,
    triggerEventName: "pull_request_review",
    triggerCommentId: 4630710284,
  };

  it("ES-506: does NOT mark done when the triggering Codex review reviewed a commit older than HEAD", async () => {
    // Reproduces the premature-done race: a concurrent run already consumed the
    // findings, pushed a fix (HEAD is now "fixsha1"), and requested a fresh
    // @codex review that has not arrived. This serialized run is triggered by a
    // stale/duplicate review that reviewed the pre-fix commit ("oldsha0"), NOT
    // HEAD, and sees 0 new findings. Marking done here would swallow the genuine
    // HEAD re-review as `Status is 'done'. Skipping.`.
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        // HEAD is LoopPilot's own just-pushed fix (a re-review is pending).
        state: makeState({
          status: "waiting_codex",
          lastClaudeCommitSha: "fixsha1",
        }),
      },
      [], // no new findings
    );
    deps.readHeadSha = () => "fixsha1";
    deps.fetchReviewCommitById = vi.fn().mockResolvedValue("oldsha0");

    await runPreFix(reviewTriggerConfig, deps);

    // Looks up the TRIGGERING review by its id, not "the latest review".
    expect(deps.fetchReviewCommitById).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      4630710284,
      "github-token",
    );
    // Must skip, not mark done: no `done` state write, no completion comment.
    expect(deps.outputs.should_run).toBe("false");
    const doneWrite = vi
      .mocked(deps.updateStateComment)
      .mock.calls.find((c) => c[3]?.status === "done");
    expect(doneWrite).toBeUndefined();
    expect(deps.postCompletionComment).not.toHaveBeenCalled();
  });

  it("ES-506: marks done when the triggering review reviewed HEAD", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          lastClaudeCommitSha: "headsha",
        }),
      },
      [],
    );
    deps.readHeadSha = () => "headsha";
    deps.fetchReviewCommitById = vi.fn().mockResolvedValue("headsha");

    await runPreFix(reviewTriggerConfig, deps);

    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({ status: "done", stopReason: "no_findings" }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postCompletionComment).toHaveBeenCalled();
  });

  it("ES-506: marks done on an issue_comment clean verdict WITHOUT consulting review commits", async () => {
    // Codex's clean/no-findings verdict is routinely an `issue_comment` (no
    // commit_id). On a multi-iteration PR the last *formal review* is the older
    // findings review on a prior commit, so a review-commit-vs-HEAD check would
    // wrongly strand the loop. The guard must bypass entirely for comment
    // triggers — even when a review-commit lookup *would* mismatch.
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      [],
    );
    deps.readHeadSha = () => "fixsha1";
    deps.fetchReviewCommitById = vi.fn().mockResolvedValue("oldsha0");

    // baseConfig.triggerEventName === "issue_comment"
    await runPreFix(baseConfig, deps);

    expect(deps.fetchReviewCommitById).not.toHaveBeenCalled();
    expect(deps.postCompletionComment).toHaveBeenCalled();
    const doneWrite = vi
      .mocked(deps.updateStateComment)
      .mock.calls.find((c) => c[3]?.status === "done");
    expect(doneWrite).toBeDefined();
  });

  it("ES-506: fails open (marks done) when the review-commit lookup throws", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          lastClaudeCommitSha: "headsha",
        }),
      },
      [],
    );
    deps.readHeadSha = () => "headsha";
    deps.fetchReviewCommitById = vi
      .fn()
      .mockRejectedValue(new Error("api down"));

    await runPreFix(reviewTriggerConfig, deps);

    expect(deps.warning).toHaveBeenCalled();
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({ status: "done", stopReason: "no_findings" }),
      "github-token",
      expect.any(Object),
    );
  });

  it("ES-506: fails open (marks done) when the review has no commit_id (null)", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          lastClaudeCommitSha: "headsha",
        }),
      },
      [],
    );
    deps.readHeadSha = () => "headsha";
    deps.fetchReviewCommitById = vi.fn().mockResolvedValue(null);

    await runPreFix(reviewTriggerConfig, deps);

    expect(deps.postCompletionComment).toHaveBeenCalled();
    const doneWrite = vi
      .mocked(deps.updateStateComment)
      .mock.calls.find((c) => c[3]?.status === "done");
    expect(doneWrite).toBeDefined();
  });

  it("ES-506: marks done on a first-pass clean review (no LoopPilot fix yet, lastClaudeCommitSha null)", async () => {
    // Before any Claude fix, lastClaudeCommitSha is null, so the guard's
    // `lastClaudeCommitSha === headSha` precondition is false and a clean review
    // on the PR head marks done without consulting the review commit.
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          lastClaudeCommitSha: null,
        }),
      },
      [],
    );
    deps.readHeadSha = () => "headsha";
    deps.fetchReviewCommitById = vi.fn().mockResolvedValue("oldsha0");

    await runPreFix(reviewTriggerConfig, deps);

    expect(deps.fetchReviewCommitById).not.toHaveBeenCalled();
    expect(deps.postCompletionComment).toHaveBeenCalled();
    const doneWrite = vi
      .mocked(deps.updateStateComment)
      .mock.calls.find((c) => c[3]?.status === "done");
    expect(doneWrite).toBeDefined();
  });

  it("ES-506: marks done (does NOT strand) when HEAD advanced past LoopPilot's fix for an external reason", async () => {
    // Regression guard: Codex reviewed a commit, but HEAD is NOT LoopPilot's own
    // just-pushed fix (lastClaudeCommitSha "loopB" != HEAD "externalC" — e.g. a
    // human push or a base-branch merge moved HEAD). No fresh @codex review is
    // necessarily coming, so the guard must NOT skip; marking done preserves the
    // pre-ES-506 behaviour and avoids a permanent waiting_codex strand. The
    // review-commit lookup must not even be consulted.
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          lastClaudeCommitSha: "loopB",
        }),
      },
      [],
    );
    deps.readHeadSha = () => "externalC";
    deps.fetchReviewCommitById = vi.fn().mockResolvedValue("oldsha0");

    await runPreFix(reviewTriggerConfig, deps);

    expect(deps.fetchReviewCommitById).not.toHaveBeenCalled();
    expect(deps.postCompletionComment).toHaveBeenCalled();
    const doneWrite = vi
      .mocked(deps.updateStateComment)
      .mock.calls.find((c) => c[3]?.status === "done");
    expect(doneWrite).toBeDefined();
  });

  it("second-truncates the now() fallback for lastCodexReviewReceivedAt (TY-359 / #150)", async () => {
    // With no relevant Codex comments, lastCodexReviewReceivedAt falls back to
    // now(). It must be second-precision (matching GitHub's createdAt) so a
    // /restart-review that preserves it does not lexicographically re-process an
    // already-seen same-second comment. The now() mock is ...12:00:00Z, whose
    // toISOString() is ...12:00:00.000Z without the truncation.
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      [],
    );

    await runPreFix(baseConfig, deps);

    const calls = vi.mocked(deps.updateStateComment).mock.calls;
    const doneWrite = calls.find((c) => c[3]?.status === "done");
    expect(doneWrite).toBeDefined();
    expect(doneWrite?.[3]?.lastCodexReviewReceivedAt).toBe("2026-05-14T12:00:00Z");
  });

  it("enables auto-merge on done/no_findings when LOOPPILOT_AUTO_MERGE is true", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      [],
    );

    await runPreFix({ ...baseConfig, autoMergeOnClean: true }, deps);

    expect(deps.postCompletionComment).toHaveBeenCalled();
    expect(deps.mergeIfChecksPass).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "github-token",
      expect.objectContaining({ info: expect.any(Function), warning: expect.any(Function) }),
      expect.objectContaining({
        pollIntervalMs: expect.any(Number),
        timeoutMs: expect.any(Number),
        postSkipNotification: expect.any(Function),
      }),
    );
  });

  it("BUG-01 follow-up: withholds auto-merge and notifies when the no-findings result has unparseable Codex comments", async () => {
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      [
        {
          id: 300,
          user: { login: "chatgpt-codex-connector[bot]" },
          // No severity badge and no P0/P1 keyword → parseSeverity returns null
          // → counted as skipped.unparseable, findings stays empty.
          body: "General observation about naming conventions.",
          path: "src/x.ts",
          line: 5,
          createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
        },
      ],
    );

    await runPreFix({ ...baseConfig, autoMergeOnClean: true }, deps);

    // State transition is unchanged — still done/no_findings.
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({ status: "done", stopReason: "no_findings" }),
      "github-token",
      expect.any(Object),
    );
    // ...but auto-merge is withheld and the operator is notified instead.
    expect(deps.mergeIfChecksPass).not.toHaveBeenCalled();
    expect(deps.postAutoMergeSkipNotification).toHaveBeenCalledTimes(1);
    const call = vi.mocked(deps.postAutoMergeSkipNotification).mock.calls[0]!;
    expect(call[3]).toEqual({ kind: "unparseable_findings", count: 1 });
  });

  it("plumbs postAutoMergeSkipNotification through to mergeIfChecksPass via the postSkipNotification hook (TY-295)", async () => {
    // Invoking the bound hook must call postAutoMergeSkipNotification with
    // the PR triple, the kind, a non-empty runUrl (operator follow-up
    // link), and the github token. This pins the wiring so a future
    // refactor of mergeIfChecksPass cannot silently drop the notification.
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      [],
    );

    await runPreFix({ ...baseConfig, autoMergeOnClean: true }, deps);

    const mergeCall = vi.mocked(deps.mergeIfChecksPass).mock.calls[0]!;
    const overrides = mergeCall[5]!;
    expect(overrides.postSkipNotification).toBeDefined();

    await overrides.postSkipNotification!({
      kind: "ci_failed",
      failures: [{ name: "lint", conclusion: "failure" }],
    });

    expect(deps.postAutoMergeSkipNotification).toHaveBeenCalledTimes(1);
    const notifyCall = vi.mocked(deps.postAutoMergeSkipNotification).mock.calls[0]!;
    expect(notifyCall[0]).toBe("edereship");
    expect(notifyCall[1]).toBe("loop-pilot");
    expect(notifyCall[2]).toBe(99);
    expect(notifyCall[3]).toEqual({
      kind: "ci_failed",
      failures: [{ name: "lint", conclusion: "failure" }],
    });
    // runUrl must point at an Actions URL so the operator can jump straight
    // from the PR notification to the workflow log without grepping.
    expect(notifyCall[4]).toMatch(
      /^https:\/\/[^/]+\/edereship\/loop-pilot\/actions/,
    );
    expect(notifyCall[5]).toBe("github-token");
  });

  it("stops when iteration count is at the configured maximum", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 200,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P1 Race condition in cache eviction\n\nDescription.\n\nUseful?",
        path: "src/cache.ts",
        line: 12,
        createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex", iterationCount: 20 }),
      },
      findings,
    );

    await runPreFix({ ...baseConfig, autoMergeOnClean: true }, deps);

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "max_iterations" }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postStopComment).toHaveBeenCalled();
    // auto-merge must only fire on done/no_findings, not max_iterations.
    expect(deps.mergeIfChecksPass).not.toHaveBeenCalled();
  });

  // Also pins the TY-298 #1 docstring invariant: `checkoutBranch` must throw
  // on non-zero exit (the docstring no longer claims it is "non-fatal"). A
  // future stub that silently swallows the failure would break this test.
  it("propagates checkoutBranch failure so claude-code-action does not run on the wrong ref", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 400,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P1 Race in middleware\n\nSomething.",
        path: "src/middleware.ts",
        line: 10,
        createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      findings,
    );
    deps.checkoutBranch = vi.fn().mockImplementation(() => {
      throw new Error("error: pathspec 'linear/TY-237' did not match any file(s) known to git");
    });

    await expect(runPreFix(baseConfig, deps)).rejects.toThrow(/did not match/);

    // Pre-fix should never advance to emitting the run signal once the
    // working tree cannot be repositioned to the PR head.
    expect(deps.outputs.should_run).toBe("false");
    // TY-285 #4: checkout runs BEFORE the fixing state write, so a failed
    // checkout must not consume an iteration slot or append a hash entry.
    expect(deps.updateStateComment).not.toHaveBeenCalled();
  });

  it("TY-285 #3/#4: rejects argv-flag injection prHeadRef without mutating state", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 410,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P1 Bad ref\n\nSomething.",
        path: "src/foo.ts",
        line: 10,
        createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      findings,
    );

    await expect(
      runPreFix({ ...baseConfig, prHeadRef: "-rf" }, deps),
    ).rejects.toThrow(/Invalid branch name/);

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.checkoutBranch).not.toHaveBeenCalled();
    // Validation runs before the fixing state write — the throw must not
    // consume an iteration or append a hash entry.
    expect(deps.updateStateComment).not.toHaveBeenCalled();
  });

  it.each(["feature/..", ".."])(
    "TY-285 #3: rejects path-traversal prHeadRef %j",
    async (badRef) => {
      const findings: RawReviewComment[] = [
        {
          id: 411,
          user: { login: "chatgpt-codex-connector[bot]" },
          body: "P1 Bad ref\n\nSomething.",
          path: "src/foo.ts",
          line: 10,
          createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
        },
      ];
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T11:00:00Z",
          state: makeState({ status: "waiting_codex" }),
        },
        findings,
      );

      await expect(
        runPreFix({ ...baseConfig, prHeadRef: badRef }, deps),
      ).rejects.toThrow(/Invalid branch name/);

      expect(deps.checkoutBranch).not.toHaveBeenCalled();
      expect(deps.updateStateComment).not.toHaveBeenCalled();
    },
  );

  it.each([
    "機能/タスク-123",
    "feature/한국어",
    "feat/中文",
    "feat/絵文字-🚀",
  ])(
    "TY-285 #3: accepts non-ASCII prHeadRef %j and proceeds to fixing",
    async (goodRef) => {
      const findings: RawReviewComment[] = [
        {
          id: 412,
          user: { login: "chatgpt-codex-connector[bot]" },
          body: "P1 Some finding\n\nDetails.",
          path: "src/foo.ts",
          line: 10,
          createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
        },
      ];
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T11:00:00Z",
          state: makeState({ status: "waiting_codex" }),
        },
        findings,
      );

      await runPreFix({ ...baseConfig, prHeadRef: goodRef }, deps);

      expect(deps.checkoutBranch).toHaveBeenCalledWith(goodRef);
      expect(deps.outputs.should_run).toBe("true");
      expect(deps.outputs.pr_head_ref).toBe(goodRef);
      expect(deps.updateStateComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        100,
        expect.objectContaining({ status: "fixing" }),
        "github-token",
        expect.any(Object),
      );
    },
  );

  it("transitions to fixing and emits the prompt + outputs on a clean run", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 300,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P0 Token bypass in middleware\n\nThe middleware skips the auth check on prefetch.",
        path: "src/auth.ts",
        line: 42,
        createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          iterationCount: 1,
          previousCheckFailure: "previous tail",
        }),
      },
      findings,
    );

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("true");
    expect(deps.outputs.iteration).toBe("2");
    expect(deps.outputs.check_command).toBe("npm run check");
    expect(deps.outputs.pr_head_ref).toBe("linear/TY-237");
    expect(deps.outputs.head_sha).toBe("deadbeef");
    expect(deps.outputs.comment_id).toBe("100");
    expect(deps.outputs.findings_count).toBe("1");
    expect(deps.outputs.prompt).toContain("Codex Findings (1)");
    expect(deps.outputs.prompt).toContain("Token bypass in middleware");
    // previous tail surfaced in the prompt
    expect(deps.outputs.prompt).toContain("previous tail");
    // Default CHECK_COMMAND is already in the baseline, so no extra entry.
    expect(deps.outputs.allowed_bash_tools).toContain("Bash(npm run check)");
    expect(deps.outputs.allowed_bash_tools).toContain("Bash(git diff)");
    // P0 finding + previousCheckFailure both fire → escalated to Opus.
    expect(deps.outputs.model).toBe("claude-opus-4-6");

    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({ status: "fixing", iterationCount: 2 }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.checkoutBranch).toHaveBeenCalledWith("linear/TY-237");
  });

  it("warns when MAX_REVIEW_ITERATIONS exceeds the findings-hash history cap but still proceeds (TY-359 / #158)", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 320,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P2 Minor nit\n\nA comment is unclear.",
        path: "src/foo.ts",
        line: 7,
        createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      findings,
    );

    await runPreFix({ ...baseConfig, maxReviewIterations: 21 }, deps);

    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining("exceeds the findings-hash history cap"),
    );
    // Non-breaking: the iteration still proceeds to fixing.
    expect(deps.outputs.should_run).toBe("true");
  });

  it("does not warn about the history cap when MAX_REVIEW_ITERATIONS is within it (TY-359 / #158)", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 321,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P2 Minor nit\n\nA comment is unclear.",
        path: "src/foo.ts",
        line: 7,
        createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      findings,
    );

    await runPreFix({ ...baseConfig, maxReviewIterations: 20 }, deps);

    expect(deps.warning).not.toHaveBeenCalledWith(
      expect.stringContaining("exceeds the findings-hash history cap"),
    );
    expect(deps.outputs.should_run).toBe("true");
  });

  it("embeds the effective scope policy section in the prompt (TY-278)", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 310,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P2 Minor nit\n\nA comment is unclear.",
        path: "src/foo.ts",
        line: 7,
        createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      findings,
    );

    await runPreFix(
      {
        ...baseConfig,
        // Custom additions ("secrets/") + custom removal ("!package.json")
        // exercise the operator-spec → effective-list resolution.
        autoReviewBlockPaths: "secrets/,!package.json",
        scopeMaxFiles: 7,
        scopeMaxLines: 250,
      },
      deps,
    );

    expect(deps.outputs.should_run).toBe("true");
    expect(deps.outputs.prompt).toContain(
      "## Scope Policy (your edits must satisfy)",
    );
    // Locked default surfaces the structural-lock annotation.
    expect(deps.outputs.prompt).toContain(
      "  - .github/ (structurally locked, cannot be overridden)",
    );
    // Default unlocked entries still appear.
    expect(deps.outputs.prompt).toContain("  - dist/");
    // Operator addition appears.
    expect(deps.outputs.prompt).toContain("  - secrets/");
    // Operator removal of `package.json` from the defaults takes effect:
    // the prompt's blocked-paths block must not list it as a bullet item.
    expect(deps.outputs.prompt).not.toMatch(/^  - package\.json$/m);
    // Effective overrides for size budgets are surfaced.
    expect(deps.outputs.prompt).toContain("- Max files changed: 7");
    expect(deps.outputs.prompt).toContain(
      "- Max lines changed (added + deleted): 250",
    );
    // Root-dotfile wildcard is always surfaced. "!package.json" is not a dotfile
    // so it does not appear in the exemption list.
    expect(deps.outputs.prompt).toContain(
      "- Root dotfiles (any `.*` file at repo root): blocked",
    );
    expect(deps.outputs.prompt).not.toContain("exempted: package.json");
    // Section ordering: Findings → Scope Policy → Instructions.
    const findingsAt = deps.outputs.prompt.indexOf("## Codex Findings");
    const scopeAt = deps.outputs.prompt.indexOf("## Scope Policy");
    const instructionsAt = deps.outputs.prompt.indexOf("## Instructions");
    expect(scopeAt).toBeGreaterThan(findingsAt);
    expect(instructionsAt).toBeGreaterThan(scopeAt);
    expect(deps.warning).not.toHaveBeenCalled();
  });

  it("appends CHECK_COMMAND to the Bash allowlist when using a non-npm package manager", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 301,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P1 Missing null guard\n\nA path can dereference null.",
        path: "src/foo.ts",
        line: 7,
        createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      findings,
    );

    await runPreFix(
      { ...baseConfig, checkCommand: "pnpm run check" },
      deps,
    );

    expect(deps.outputs.should_run).toBe("true");
    expect(deps.outputs.allowed_bash_tools).toContain("Bash(pnpm run check)");
    expect(deps.warning).not.toHaveBeenCalled();
  });

  it("uses the base model when no escalation signal fires", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 320,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P2 Minor nit\n\nA comment is unclear.",
        path: "src/foo.ts",
        line: 12,
        createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex", previousCheckFailure: null }),
      },
      findings,
    );

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("true");
    expect(deps.outputs.model).toBe("claude-sonnet-4-6");
  });

  it("escalates to the escalated tier when the previous base-tier iteration produced the same findings hash (TY-243)", async () => {
    const comments: RawReviewComment[] = [
      {
        id: 510,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P1 Lingering null guard\n\nPath still dereferences null.",
        path: "src/foo.ts",
        line: 7,
        createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
      },
    ];
    const { findings: parsed } = filterAndParseComments(
      comments,
      "chatgpt-codex-connector[bot]",
      null,
      "P2",
    );
    const hash = computeFindingsHash(parsed);

    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          iterationCount: 1,
          findingsHashHistory: [
            { iteration: 1, hash, modelTier: "base" },
          ],
          lastFindingsHash: hash,
        }),
      },
      comments,
    );

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("true");
    expect(deps.outputs.model).toBe("claude-opus-4-6");
    expect(deps.postStopComment).not.toHaveBeenCalled();
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({
        status: "fixing",
        iterationCount: 2,
        findingsHashHistory: [
          { iteration: 1, hash, modelTier: "base" },
          { iteration: 2, hash, modelTier: "escalated" },
        ],
      }),
      "github-token",
      expect.any(Object),
    );
  });

  it("stops with loop_detected when the previous escalated-tier iteration produced the same findings hash (TY-243)", async () => {
    const comments: RawReviewComment[] = [
      {
        id: 511,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P0 Critical auth bypass\n\nStill broken after escalated attempt.",
        path: "src/auth.ts",
        line: 14,
        createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
      },
    ];
    const { findings: parsed } = filterAndParseComments(
      comments,
      "chatgpt-codex-connector[bot]",
      null,
      "P2",
    );
    const hash = computeFindingsHash(parsed);

    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          iterationCount: 2,
          findingsHashHistory: [
            { iteration: 1, hash, modelTier: "base" },
            { iteration: 2, hash, modelTier: "escalated" },
          ],
          lastFindingsHash: hash,
        }),
      },
      comments,
    );

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "loop_detected" }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postStopComment).toHaveBeenCalled();
  });

  it("treats legacy history entries without modelTier as escalated (loop_detected) (TY-243)", async () => {
    const comments: RawReviewComment[] = [
      {
        id: 512,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P1 Same finding\n\nNothing changed.",
        path: "src/baz.ts",
        line: 5,
        createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
      },
    ];
    const { findings: parsed } = filterAndParseComments(
      comments,
      "chatgpt-codex-connector[bot]",
      null,
      "P2",
    );
    const hash = computeFindingsHash(parsed);

    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          iterationCount: 1,
          // Pre-TY-243 entry: no modelTier present.
          findingsHashHistory: [{ iteration: 1, hash }],
          lastFindingsHash: hash,
        }),
      },
      comments,
    );

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({ status: "stopped", stopReason: "loop_detected" }),
      "github-token",
      expect.any(Object),
    );
  });

  it("registers the OAuth token as a secret and warns about quota usage when using a subscription (TY-260)", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({ status: "waiting_codex" }),
    });

    await runPreFix(
      { ...baseConfig, anthropicApiKey: "", claudeCodeOauthToken: "oauth-test" },
      deps,
    );

    expect(deps.setSecret).toHaveBeenCalledWith("oauth-test");
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining("Claude Code OAuth token (subscription)"),
    );
  });

  it("does not emit the subscription warning when running with the API key (TY-260)", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({ status: "waiting_codex" }),
    });

    await runPreFix(baseConfig, deps);

    // baseConfig has anthropicApiKey="anthropic-key", claudeCodeOauthToken=""
    expect(deps.warning).not.toHaveBeenCalledWith(
      expect.stringContaining("Claude Code OAuth token"),
    );
  });

  it("escalates to the escalated tier when the previous iteration stopped with max_turns_exceeded (TY-258)", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 520,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P2 Minor follow-up\n\nA wording tweak.",
        path: "src/foo.ts",
        line: 12,
        createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          iterationCount: 1,
          // Simulates the state after a `max_turns_exceeded` stop +
          // `/restart-review` (restart preserves stopReason).
          stopReason: "max_turns_exceeded",
        }),
      },
      findings,
    );

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("true");
    // Only P2 finding → no P0 / previousCheckFailure / repeatedFinding,
    // so the escalation must come solely from the carried-over stopReason.
    expect(deps.outputs.model).toBe("claude-opus-4-6");
  });

  it("does not escalate when previous stopReason is a non-max_turns reason (TY-258 boundary)", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 521,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P2 Minor follow-up\n\nA wording tweak.",
        path: "src/foo.ts",
        line: 12,
        createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          iterationCount: 1,
          // Any non-max_turns reason must not trigger escalation on its own.
          stopReason: "loop_detected",
        }),
      },
      findings,
    );

    await runPreFix(baseConfig, deps);

    expect(deps.outputs.should_run).toBe("true");
    expect(deps.outputs.model).toBe("claude-sonnet-4-6");
  });

  it("stops with codex_usage_limit when the Codex bot trigger body is a usage-limit notice (TY-229)", async () => {
    const usageLimitBody = "You have reached your Codex usage limits for code reviews.";
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({ status: "waiting_codex" }),
    });

    await runPreFix(
      {
        ...baseConfig,
        triggerCommentBody: usageLimitBody,
        triggerUserLogin: baseConfig.codexBotLogin,
      },
      deps,
    );

    expect(deps.outputs.should_run).toBe("false");
    expect(deps.fetchReviewComments).not.toHaveBeenCalled();
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({
        status: "stopped",
        stopReason: "codex_usage_limit",
      }),
      "github-token",
      expect.any(Object),
    );
    expect(deps.postStopComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      99,
      "codex_usage_limit",
      baseConfig.triggerCommentId,
      0,
      expect.stringContaining("/restart-review"),
      "github-token",
    expect.any(Object),
    );
  });

  it("ignores a usage-limit phrase posted by a non-Codex user (TY-229)", async () => {
    const usageLimitBody = "You have reached your Codex usage limits for code reviews.";
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({ status: "waiting_codex" }),
    });

    await runPreFix(
      {
        ...baseConfig,
        triggerCommentBody: usageLimitBody,
        triggerUserLogin: "human-user",
      },
      deps,
    );

    // Without the Codex bot login, the trigger is treated as a normal
    // comment and the usual collection path runs (which returns
    // no_findings here because no mock comments are supplied).
    expect(deps.fetchReviewComments).toHaveBeenCalled();
    expect(deps.updateStateComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      100,
      expect.objectContaining({
        status: "done",
        stopReason: "no_findings",
      }),
      "github-token",
      expect.any(Object),
    );
  });

  it("warns and falls back to baseline when CHECK_COMMAND is unsafe", async () => {
    const findings: RawReviewComment[] = [
      {
        id: 302,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "P1 Issue\n\nSomething.",
        path: "src/bar.ts",
        line: 1,
        createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
      },
    ];
    const deps = makeDeps(
      {
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({ status: "waiting_codex" }),
      },
      findings,
    );

    await runPreFix(
      { ...baseConfig, checkCommand: "npm run check; rm -rf /" },
      deps,
    );

    expect(deps.outputs.should_run).toBe("true");
    expect(deps.outputs.allowed_bash_tools).not.toContain("rm -rf");
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining("not added to Bash allowlist"),
    );
  });

  it("TY-294: skips the initial debounce when the trigger summary signals no findings", async () => {
    const config: Config = {
      ...baseConfig,
      debounceSeconds: 90,
      triggerCommentBody:
        "Codex Review: Didn't find any major issues. Another round soon, please!",
    };
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({ status: "waiting_codex" }),
    });

    await runPreFix(config, deps);

    // The debounce sleep is `await deps.sleep(debounceSeconds * 1000)`. With
    // the no-findings short-circuit, that call MUST be skipped — operators
    // were waiting 90s for a guaranteed-empty inline polling.
    const sleepCalls = (deps.sleep as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      sleepCalls.every((call) => call[0] !== 90 * 1000),
    ).toBe(true);
    expect(deps.info).toHaveBeenCalledWith(
      "[pre-fix] Trigger summary indicates no findings; skipping debounce.",
    );
    // Finding 2: stabilization must still be given the chance to re-poll even
    // when the debounce was skipped, to guard against false negatives in the
    // no-findings heuristic.
    expect(deps.stabilizeReviewComments).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ forceStabilize: true }),
    );
  });

  it("TY-294: still debounces when the trigger summary contains findings (regression)", async () => {
    const config: Config = {
      ...baseConfig,
      debounceSeconds: 90,
      triggerCommentBody:
        "Codex Review: 3 P1 findings in src/foo.ts — check error handling.",
    };
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 100,
      commentUpdatedAt: "2026-05-14T11:00:00Z",
      state: makeState({ status: "waiting_codex" }),
    });

    await runPreFix(config, deps);

    const sleepCalls = (deps.sleep as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      sleepCalls.some((call) => call[0] === 90 * 1000),
    ).toBe(true);
  });

  // TY-301 #1: every pre-fix terminal stop transition must explicitly write
  // `fixingStartedAt: null` so the `types.ts:46-57` invariant holds even when
  // the input state was hand-edited or restored from legacy data with a stale
  // timestamp. The happy-path input is `status: "waiting_codex"` with a null
  // timestamp, but the spread operator alone cannot defend against a stale
  // value being carried through into a non-`fixing` status.
  describe("TY-301 #1: clears fixingStartedAt on every pre-fix stop transition", () => {
    const STALE = "2026-04-01T00:00:00Z";

    it("no_findings clears fixingStartedAt", async () => {
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T11:00:00Z",
          state: makeState({
            status: "waiting_codex",
            fixingStartedAt: STALE,
            // TY-360: carried over from a prior iteration; the done transition
            // must clear it so post-fix never resolves stale ids.
            currentIterationFindingCommentIds: [9001],
          }),
        },
        [],
      );

      await runPreFix(baseConfig, deps);

      expect(deps.updateStateComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        100,
        expect.objectContaining({
          status: "done",
          stopReason: "no_findings",
          fixingStartedAt: null,
          currentIterationFindingCommentIds: [],
        }),
        "github-token",
        expect.any(Object),
      );
    });

    it("max_iterations clears fixingStartedAt", async () => {
      const findings: RawReviewComment[] = [
        {
          id: 1301,
          user: { login: "chatgpt-codex-connector[bot]" },
          body: "P1 Race in cache\n\nstuff.",
          path: "src/cache.ts",
          line: 12,
          createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
        },
      ];
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T11:00:00Z",
          state: makeState({
            status: "waiting_codex",
            iterationCount: 20,
            fixingStartedAt: STALE,
            // TY-360: carried over from a prior iteration; the terminal
            // transition must clear it so post-fix never resolves stale ids.
            currentIterationFindingCommentIds: [9001],
          }),
        },
        findings,
      );

      await runPreFix(baseConfig, deps);

      expect(deps.updateStateComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        100,
        expect.objectContaining({
          status: "stopped",
          stopReason: "max_iterations",
          fixingStartedAt: null,
          currentIterationFindingCommentIds: [],
        }),
        "github-token",
        expect.any(Object),
      );
    });

    it("loop_detected clears fixingStartedAt", async () => {
      const comments: RawReviewComment[] = [
        {
          id: 1302,
          user: { login: "chatgpt-codex-connector[bot]" },
          body: "P0 Critical auth bypass\n\nStill broken.",
          path: "src/auth.ts",
          line: 14,
          createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
        },
      ];
      const { findings: parsed } = filterAndParseComments(
        comments,
        "chatgpt-codex-connector[bot]",
        null,
        "P2",
      );
      const hash = computeFindingsHash(parsed);

      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T11:00:00Z",
          state: makeState({
            status: "waiting_codex",
            iterationCount: 2,
            findingsHashHistory: [
              { iteration: 1, hash, modelTier: "base" },
              { iteration: 2, hash, modelTier: "escalated" },
            ],
            lastFindingsHash: hash,
            fixingStartedAt: STALE,
            currentIterationFindingCommentIds: [9001],
          }),
        },
        comments,
      );

      await runPreFix(baseConfig, deps);

      expect(deps.updateStateComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        100,
        expect.objectContaining({
          status: "stopped",
          stopReason: "loop_detected",
          fixingStartedAt: null,
          currentIterationFindingCommentIds: [],
        }),
        "github-token",
        expect.any(Object),
      );
    });

    it("codex_usage_limit clears fixingStartedAt", async () => {
      const usageLimitBody =
        "You have reached your Codex usage limits for code reviews.";
      const deps = makeDeps({
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          fixingStartedAt: STALE,
          // TY-360: this branch spreads `...state`, so it must clear the ids
          // explicitly (it cannot inherit the cleared `updatedStateBase`).
          currentIterationFindingCommentIds: [9001],
        }),
      });

      await runPreFix(
        {
          ...baseConfig,
          triggerCommentBody: usageLimitBody,
          triggerUserLogin: baseConfig.codexBotLogin,
        },
        deps,
      );

      expect(deps.updateStateComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        100,
        expect.objectContaining({
          status: "stopped",
          stopReason: "codex_usage_limit",
          fixingStartedAt: null,
          currentIterationFindingCommentIds: [],
        }),
        "github-token",
        expect.any(Object),
      );
    });
  });

  // TY-301 #2: dedup must consider both `lastProcessedReviewId` AND
  // `lastProcessedTriggerSource`. issue_comment.id and pull_request_review.id
  // live in separate namespaces and can collide; an id-only check would
  // silently skip the legitimate trigger as "already processed".
  describe("TY-301 #2: trigger dedup honours (id, source) namespace", () => {
    it("does NOT skip when the stored id matches but the source differs", async () => {
      const findings: RawReviewComment[] = [
        {
          id: 2001,
          user: { login: "chatgpt-codex-connector[bot]" },
          body: "P1 Race in cache\n\nfindings.",
          path: "src/cache.ts",
          line: 12,
          createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
        },
      ];
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T11:00:00Z",
          state: makeState({
            status: "waiting_codex",
            lastProcessedReviewId: baseConfig.triggerCommentId,
            // The last trigger we processed was a comment; the incoming
            // trigger uses the same numeric id but is a review.
            lastProcessedTriggerSource: "comment",
          }),
        },
        findings,
      );

      await runPreFix(
        { ...baseConfig, triggerEventName: "pull_request_review" },
        deps,
      );

      // The id collided but the source did not, so the dedup must NOT fire.
      // The run proceeds to the normal collect-findings path.
      expect(deps.fetchReviewComments).toHaveBeenCalled();
      expect(deps.outputs.should_run).toBe("true");
    });

    it("still skips when the stored id AND source both match (regression)", async () => {
      const deps = makeDeps({
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          lastProcessedReviewId: baseConfig.triggerCommentId,
          lastProcessedTriggerSource: "comment",
        }),
      });

      await runPreFix(
        { ...baseConfig, triggerEventName: "issue_comment" },
        deps,
      );

      expect(deps.outputs.should_run).toBe("false");
      expect(deps.fetchReviewComments).not.toHaveBeenCalled();
    });

    it("falls back to id-only dedup for legacy state (lastProcessedTriggerSource === null)", async () => {
      const deps = makeDeps({
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          lastProcessedReviewId: baseConfig.triggerCommentId,
          // Legacy: pre-TY-301 state has no source recorded.
          lastProcessedTriggerSource: null,
        }),
      });

      await runPreFix(
        { ...baseConfig, triggerEventName: "pull_request_review" },
        deps,
      );

      // Legacy state preserves the pre-TY-301 behaviour: id-only dedup.
      expect(deps.outputs.should_run).toBe("false");
      expect(deps.fetchReviewComments).not.toHaveBeenCalled();
    });

    it("falls back to id-only dedup when the workflow YAML does not pass triggerEventName", async () => {
      const deps = makeDeps({
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          lastProcessedReviewId: baseConfig.triggerCommentId,
          lastProcessedTriggerSource: "comment",
        }),
      });

      // Legacy workflow YAML predating TY-301 does not pass the input.
      await runPreFix({ ...baseConfig, triggerEventName: "" }, deps);

      // currentTriggerSource resolves to null; the id-only fallback fires.
      expect(deps.outputs.should_run).toBe("false");
      expect(deps.fetchReviewComments).not.toHaveBeenCalled();
    });

    it("persists lastProcessedTriggerSource alongside lastProcessedReviewId on the Phase 3 fixing transition", async () => {
      const findings: RawReviewComment[] = [
        {
          id: 2010,
          user: { login: "chatgpt-codex-connector[bot]" },
          body: "P1 finding\n\nbody.",
          path: "src/x.ts",
          line: 5,
          createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
        },
      ];
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T11:00:00Z",
          state: makeState({ status: "waiting_codex" }),
        },
        findings,
      );

      await runPreFix(
        { ...baseConfig, triggerEventName: "pull_request_review" },
        deps,
      );

      expect(deps.updateStateComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        100,
        expect.objectContaining({
          status: "fixing",
          lastProcessedReviewId: baseConfig.triggerCommentId,
          lastProcessedTriggerSource: "review",
        }),
        "github-token",
        expect.any(Object),
      );
    });
  });

  // TY-306 #3: when `triggerCommentId === 0` the id falls back to the old
  // value, so the source's fallback must follow — otherwise the written
  // pair becomes `(id: old review_id, source: new "comment")`
  // cross-namespace garbage that defeats the (id, source) dedup TY-301 #2
  // set up. Verified at both `updatedStateBase` (:561) and the
  // `codex_usage_limit` branch (:442).
  describe("TY-306 #3: (id, source) fallback parity when triggerCommentId === 0", () => {
    it("#A: updatedStateBase keeps lastProcessedTriggerSource on the old value when triggerCommentId === 0 (avoid cross-namespace garbage)", async () => {
      const findings: RawReviewComment[] = [
        {
          id: 3010,
          user: { login: "chatgpt-codex-connector[bot]" },
          body: "P1 finding\n\nbody.",
          path: "src/x.ts",
          line: 5,
          createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
        },
      ];
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T11:00:00Z",
          state: makeState({
            status: "waiting_codex",
            lastProcessedReviewId: 555,
            lastProcessedTriggerSource: "review",
          }),
        },
        findings,
      );

      // triggerCommentId=0 (e.g. partial workflow_dispatch input) +
      // triggerEventName="issue_comment" (= "comment"). Without TY-306 #3
      // the source would silently flip to "comment" while the id stayed
      // at 555 — a cross-namespace pair.
      await runPreFix(
        {
          ...baseConfig,
          triggerCommentId: 0,
          triggerEventName: "issue_comment",
        },
        deps,
      );

      expect(deps.updateStateComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        100,
        expect.objectContaining({
          status: "fixing",
          lastProcessedReviewId: 555,
          lastProcessedTriggerSource: "review",
        }),
        "github-token",
        expect.any(Object),
      );
    });

    it("#B: updatedStateBase still overwrites lastProcessedTriggerSource when triggerCommentId !== 0 (regression)", async () => {
      const findings: RawReviewComment[] = [
        {
          id: 3020,
          user: { login: "chatgpt-codex-connector[bot]" },
          body: "P1 finding\n\nbody.",
          path: "src/x.ts",
          line: 5,
          createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
        },
      ];
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T11:00:00Z",
          state: makeState({
            status: "waiting_codex",
            lastProcessedReviewId: 555,
            lastProcessedTriggerSource: "review",
          }),
        },
        findings,
      );

      await runPreFix(
        {
          ...baseConfig,
          triggerCommentId: 67890,
          triggerEventName: "issue_comment",
        },
        deps,
      );

      expect(deps.updateStateComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        100,
        expect.objectContaining({
          status: "fixing",
          lastProcessedReviewId: 67890,
          lastProcessedTriggerSource: "comment",
        }),
        "github-token",
        expect.any(Object),
      );
    });

    it("#C: codex_usage_limit branch also keeps lastProcessedTriggerSource on the old value when triggerCommentId === 0", async () => {
      const usageLimitBody =
        "You have reached your Codex usage limits for code reviews.";
      const deps = makeDeps({
        found: true,
        corrupted: false,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
        state: makeState({
          status: "waiting_codex",
          lastProcessedReviewId: 777,
          lastProcessedTriggerSource: "review",
        }),
      });

      await runPreFix(
        {
          ...baseConfig,
          triggerCommentId: 0,
          triggerEventName: "issue_comment",
          triggerCommentBody: usageLimitBody,
          triggerUserLogin: baseConfig.codexBotLogin,
        },
        deps,
      );

      expect(deps.updateStateComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        100,
        expect.objectContaining({
          status: "stopped",
          stopReason: "codex_usage_limit",
          lastProcessedReviewId: 777,
          lastProcessedTriggerSource: "review",
        }),
        "github-token",
        expect.any(Object),
      );
    });

    it("#D: legacy state (null source) + legacy YAML (no event name) + triggerCommentId === 0 keeps null source (regression)", async () => {
      const findings: RawReviewComment[] = [
        {
          id: 3030,
          user: { login: "chatgpt-codex-connector[bot]" },
          body: "P1 finding\n\nbody.",
          path: "src/x.ts",
          line: 5,
          createdAt: "2026-05-14T11:30:00Z",
        inReplyToId: null,
        },
      ];
      const deps = makeDeps(
        {
          found: true,
          corrupted: false,
          commentId: 100,
          commentUpdatedAt: "2026-05-14T11:00:00Z",
          state: makeState({
            status: "waiting_codex",
            lastProcessedReviewId: 888,
            lastProcessedTriggerSource: null,
          }),
        },
        findings,
      );

      await runPreFix(
        {
          ...baseConfig,
          triggerCommentId: 0,
          triggerEventName: "",
        },
        deps,
      );

      // Legacy state has null source and triggerCommentId=0 keeps the id
      // at 888 — source must remain null (no synthetic "comment" / "review"
      // injected) so the id-only fallback dedup behavior is preserved.
      expect(deps.updateStateComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        100,
        expect.objectContaining({
          status: "fixing",
          lastProcessedReviewId: 888,
          lastProcessedTriggerSource: null,
        }),
        "github-token",
        expect.any(Object),
      );
    });
  });

  describe("ES-413: /restart-review Case A/B", () => {
    const restartConfig: Config = {
      ...baseConfig,
      triggerCommentBody: "/restart-review",
      triggerUserLogin: "operator",
    };

    const sampleFindings = [
      {
        severity: "P1" as const,
        commentId: 2001,
        path: "src/auth.ts",
        line: 42,
        title: "Memory leak",
        body: "Parser allocates without freeing",
      },
    ];

    it("Case A: repairs unresolved findings before requesting new review (should_run=true)", async () => {
      const waitingState = makeState({
        status: "waiting_codex",
        iterationCount: 3,
      });
      const deps = makeDeps({
        found: true,
        corrupted: false,
        state: waitingState,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
      });
      vi.mocked(deps.validateRestartCommand).mockResolvedValue({
        valid: true,
        validation: {
          mode: "soft" as const,
          preflight: {
            nextState: {
              ...waitingState,
              status: "waiting_codex",
              lastProcessedReviewId: null,
              fixingStartedAt: null,
            },
            previousStopReason: null,
          },
        },
      });
      vi.mocked(deps.fetchUnresolvedCodexFindings).mockResolvedValue({ findings: sampleFindings, latestOutdatedAt: null });
      vi.mocked(deps.handleRestartWithRepair).mockResolvedValue({
        fixingState: {
          ...waitingState,
          status: "fixing",
          iterationCount: 4,
          fixingStartedAt: "2026-05-14T12:00:00Z",
          currentIterationFindingCommentIds: [2001],
          lastFindingsHash: "abc123",
          findingsHashHistory: [
            { iteration: 4, hash: "abc123", modelTier: "base" as const },
          ],
        },
      });

      await runPreFix(restartConfig, deps);

      expect(deps.outputs.should_run).toBe("true");
      expect(deps.outputs.iteration).toBe("4");
      expect(deps.outputs.findings_count).toBe("1");
      expect(deps.outputs.prompt).toBeDefined();
      expect(deps.outputs.model).toBeDefined();
      expect(deps.handleRestartWithRepair).toHaveBeenCalledTimes(1);
      expect(deps.executeRestartWithCodexReview).not.toHaveBeenCalled();
    });

    it("Case B: no unresolved findings — calls executeRestartWithCodexReview", async () => {
      const waitingState = makeState({
        status: "waiting_codex",
        iterationCount: 3,
      });
      const deps = makeDeps({
        found: true,
        corrupted: false,
        state: waitingState,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
      });
      vi.mocked(deps.validateRestartCommand).mockResolvedValue({
        valid: true,
        validation: {
          mode: "soft" as const,
          preflight: {
            nextState: {
              ...waitingState,
              status: "waiting_codex",
              lastProcessedReviewId: null,
              fixingStartedAt: null,
            },
            previousStopReason: null,
          },
        },
      });
      vi.mocked(deps.fetchUnresolvedCodexFindings).mockResolvedValue({ findings: [], latestOutdatedAt: null });

      await runPreFix(restartConfig, deps);

      expect(deps.executeRestartWithCodexReview).toHaveBeenCalledTimes(1);
      expect(deps.handleRestartWithRepair).not.toHaveBeenCalled();
      expect(deps.outputs.should_run).toBe("false");
    });

    it("Case A with --hard: resets counters in validation, still repairs", async () => {
      const stoppedState = makeState({
        status: "stopped",
        stopReason: "max_iterations",
        iterationCount: 20,
      });
      const hardConfig = { ...restartConfig, triggerCommentBody: "/restart-review --hard" };
      const deps = makeDeps({
        found: true,
        corrupted: false,
        state: stoppedState,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
      });
      vi.mocked(deps.validateRestartCommand).mockResolvedValue({
        valid: true,
        validation: {
          mode: "hard" as const,
          preflight: {
            nextState: {
              ...stoppedState,
              status: "waiting_codex",
              lastProcessedReviewId: null,
              fixingStartedAt: null,
              iterationCount: 0,
              findingsHashHistory: [],
              lastFindingsHash: null,
              previousCheckFailure: null,
            },
            previousStopReason: "max_iterations",
          },
        },
      });
      vi.mocked(deps.fetchUnresolvedCodexFindings).mockResolvedValue({ findings: sampleFindings, latestOutdatedAt: null });
      vi.mocked(deps.handleRestartWithRepair).mockResolvedValue({
        fixingState: {
          ...stoppedState,
          status: "fixing",
          iterationCount: 1,
          fixingStartedAt: "2026-05-14T12:00:00Z",
          currentIterationFindingCommentIds: [2001],
          lastFindingsHash: "def456",
          findingsHashHistory: [
            { iteration: 1, hash: "def456", modelTier: "base" as const },
          ],
        },
      });

      await runPreFix(hardConfig, deps);

      expect(deps.outputs.should_run).toBe("true");
      expect(deps.outputs.iteration).toBe("1");
      expect(deps.handleRestartWithRepair).toHaveBeenCalledTimes(1);
    });

    it("Case A returns early when handleRestartWithRepair returns null (conflict)", async () => {
      const waitingState = makeState({ status: "waiting_codex" });
      const deps = makeDeps({
        found: true,
        corrupted: false,
        state: waitingState,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
      });
      vi.mocked(deps.validateRestartCommand).mockResolvedValue({
        valid: true,
        validation: {
          mode: "soft" as const,
          preflight: {
            nextState: {
              ...waitingState,
              status: "waiting_codex",
              lastProcessedReviewId: null,
              fixingStartedAt: null,
            },
            previousStopReason: null,
          },
        },
      });
      vi.mocked(deps.fetchUnresolvedCodexFindings).mockResolvedValue({ findings: sampleFindings, latestOutdatedAt: null });
      vi.mocked(deps.handleRestartWithRepair).mockResolvedValue(null);

      await runPreFix(restartConfig, deps);

      expect(deps.outputs.should_run).toBe("false");
    });

    it("Case A: stops with loop_detected when unresolved findings match prior history (ES-413 Codex P2)", async () => {
      // sampleFindings hashes to the same value the preserved history already
      // recorded — a soft restart after loop_detected would otherwise rerun
      // Claude on a known loop.
      const loopHash = computeFindingsHash(sampleFindings);
      const waitingState = makeState({
        status: "waiting_codex",
        iterationCount: 3,
        findingsHashHistory: [
          { iteration: 2, hash: loopHash, modelTier: "escalated" as const },
          { iteration: 3, hash: "other", modelTier: "escalated" as const },
        ],
      });
      const deps = makeDeps({
        found: true,
        corrupted: false,
        state: waitingState,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
      });
      vi.mocked(deps.validateRestartCommand).mockResolvedValue({
        valid: true,
        validation: {
          mode: "soft" as const,
          preflight: {
            nextState: {
              ...waitingState,
              status: "waiting_codex",
              lastProcessedReviewId: null,
              fixingStartedAt: null,
            },
            previousStopReason: "loop_detected",
          },
        },
      });
      vi.mocked(deps.fetchUnresolvedCodexFindings).mockResolvedValue({ findings: sampleFindings, latestOutdatedAt: null });

      await runPreFix(restartConfig, deps);

      expect(deps.outputs.should_run).toBe("false");
      expect(deps.handleRestartWithRepair).not.toHaveBeenCalled();
      expect(deps.updateStateComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        100,
        expect.objectContaining({
          status: "stopped",
          stopReason: "loop_detected",
          fixingStartedAt: null,
        }),
        "github-token",
        expect.any(Object),
      );
      expect(deps.postStopComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        expect.anything(),
        "loop_detected",
        expect.anything(),
        1,
        expect.stringContaining("--hard"),
        "github-token",
        expect.any(Object),
      );
    });

    it("Case A with --hard: cleared history bypasses the loop guard and repairs", async () => {
      // Same colliding findings as the loop test, but --hard cleared the
      // history, so isLoop returns false and the repair proceeds.
      const stoppedState = makeState({
        status: "stopped",
        stopReason: "loop_detected",
        iterationCount: 5,
      });
      const hardConfig = {
        ...restartConfig,
        triggerCommentBody: "/restart-review --hard",
      };
      const deps = makeDeps({
        found: true,
        corrupted: false,
        state: stoppedState,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
      });
      vi.mocked(deps.validateRestartCommand).mockResolvedValue({
        valid: true,
        validation: {
          mode: "hard" as const,
          preflight: {
            nextState: {
              ...stoppedState,
              status: "waiting_codex",
              lastProcessedReviewId: null,
              fixingStartedAt: null,
              iterationCount: 0,
              findingsHashHistory: [],
              lastFindingsHash: null,
              previousCheckFailure: null,
            },
            previousStopReason: "loop_detected",
          },
        },
      });
      vi.mocked(deps.fetchUnresolvedCodexFindings).mockResolvedValue({ findings: sampleFindings, latestOutdatedAt: null });
      vi.mocked(deps.handleRestartWithRepair).mockResolvedValue({
        fixingState: {
          ...stoppedState,
          status: "fixing",
          iterationCount: 1,
          fixingStartedAt: "2026-05-14T12:00:00Z",
          currentIterationFindingCommentIds: [2001],
          lastFindingsHash: computeFindingsHash(sampleFindings),
          findingsHashHistory: [
            {
              iteration: 1,
              hash: computeFindingsHash(sampleFindings),
              modelTier: "base" as const,
            },
          ],
        },
      });

      await runPreFix(hardConfig, deps);

      expect(deps.outputs.should_run).toBe("true");
      expect(deps.handleRestartWithRepair).toHaveBeenCalledTimes(1);
    });

    it("stops (requires --hard) at the iteration cap instead of falling back to Case B (ES-413 Codex P2)", async () => {
      const cappedState = makeState({
        status: "waiting_codex",
        iterationCount: 20,
      });
      const cappedConfig = { ...restartConfig, maxReviewIterations: 20 };
      const deps = makeDeps({
        found: true,
        corrupted: false,
        state: cappedState,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
      });
      vi.mocked(deps.validateRestartCommand).mockResolvedValue({
        valid: true,
        validation: {
          mode: "soft" as const,
          preflight: {
            nextState: {
              ...cappedState,
              status: "waiting_codex",
              lastProcessedReviewId: null,
              fixingStartedAt: null,
            },
            previousStopReason: null,
          },
        },
      });
      vi.mocked(deps.fetchUnresolvedCodexFindings).mockResolvedValue({ findings: sampleFindings, latestOutdatedAt: null });

      await runPreFix(cappedConfig, deps);

      expect(deps.outputs.should_run).toBe("false");
      expect(deps.executeRestartWithCodexReview).not.toHaveBeenCalled();
      expect(deps.handleRestartWithRepair).not.toHaveBeenCalled();
      expect(deps.updateStateComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        100,
        expect.objectContaining({
          status: "stopped",
          stopReason: "max_iterations",
          fixingStartedAt: null,
        }),
        "github-token",
        expect.any(Object),
      );
      expect(deps.postStopComment).toHaveBeenCalledWith(
        "edereship",
        "loop-pilot",
        expect.anything(),
        "max_iterations",
        expect.anything(),
        1,
        expect.stringContaining("--hard"),
        "github-token",
        expect.any(Object),
      );
    });

    it("fails closed when fetchUnresolvedCodexFindings throws (ES-413 Codex P2)", async () => {
      const waitingState = makeState({ status: "waiting_codex" });
      const deps = makeDeps({
        found: true,
        corrupted: false,
        state: waitingState,
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
      });
      vi.mocked(deps.validateRestartCommand).mockResolvedValue({
        valid: true,
        validation: {
          mode: "soft" as const,
          preflight: {
            nextState: {
              ...waitingState,
              status: "waiting_codex",
              lastProcessedReviewId: null,
              fixingStartedAt: null,
            },
            previousStopReason: null,
          },
        },
      });
      vi.mocked(deps.fetchUnresolvedCodexFindings).mockRejectedValue(
        new Error("502 Bad Gateway"),
      );

      // The error propagates (fail closed) instead of falling through to a
      // fresh @codex review that would skip the unresolved findings.
      await expect(runPreFix(restartConfig, deps)).rejects.toThrow(
        "502 Bad Gateway",
      );
      expect(deps.executeRestartWithCodexReview).not.toHaveBeenCalled();
      expect(deps.handleRestartWithRepair).not.toHaveBeenCalled();
    });

    it("validation failure returns early without checking unresolved findings", async () => {
      const deps = makeDeps({
        found: true,
        corrupted: false,
        state: makeState({ status: "waiting_codex" }),
        commentId: 100,
        commentUpdatedAt: "2026-05-14T11:00:00Z",
      });
      vi.mocked(deps.validateRestartCommand).mockResolvedValue({
        valid: false,
        handled: true,
      });

      await runPreFix(restartConfig, deps);

      expect(deps.fetchUnresolvedCodexFindings).not.toHaveBeenCalled();
      expect(deps.outputs.should_run).toBe("false");
    });
  });
});
