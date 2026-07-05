import { beforeEach, describe, expect, it, vi } from "vitest";

const warning = vi.fn();
const error = vi.fn();

vi.mock("@actions/core", () => ({
  warning: (msg: string) => warning(msg),
  error: (msg: string) => error(msg),
}));

const { demoteFixingOnCrash } = await import("../src/crash-recovery.js");
const { createInitialState } = await import("../src/state-manager.js");
import type { CrashRecoveryDeps } from "../src/crash-recovery.js";
import type { Config } from "../src/config.js";
import type { ReviewState } from "../src/types.js";

const crashConfig: Config = {
  maxReviewIterations: 20,
  debounceSeconds: 90,
  checkCommand: "npm run check",
  buildCommand: "",
  codexBotLogin: "codex",
  stabilizeIntervalSeconds: 10,
  stabilizeCount: 3,
  codexReviewRequestToken: "codex-token",
  autoReviewPushToken: "",
  anthropicApiKey: "",
  claudeCodeOauthToken: "",
  githubToken: "github-token",
  repoOwner: "edereship",
  repoName: "loop-pilot",
  prNumber: 999,
  triggerCommentId: 0,
  triggerCommentBody: "",
  triggerUserLogin: "",
  triggerEventName: "",
  prHeadRef: "linear/TY-252",
  prTitle: "TY-252",
  autoReviewLabel: "",
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

function makeFixingState(): ReviewState {
  return {
    ...createInitialState(),
    status: "fixing",
    fixingStartedAt: "2026-05-15T00:00:00.000Z",
  };
}

function makeDeps(overrides: Partial<CrashRecoveryDeps> = {}): CrashRecoveryDeps {
  return {
    loadInitConfig: vi.fn().mockReturnValue(crashConfig),
    readState: vi.fn().mockResolvedValue({
      found: true,
      corrupted: false,
      state: makeFixingState(),
      commentId: 12345,
      commentUpdatedAt: "2026-05-15T00:00:00.000Z",
    }),
    updateStateComment: vi
      .fn()
      .mockResolvedValue({ updatedAt: "2026-05-15T00:00:01.000Z" }),
    postStopComment: vi.fn().mockResolvedValue(67890),
    ...overrides,
  };
}

describe("demoteFixingOnCrash", () => {
  beforeEach(() => {
    warning.mockReset();
    error.mockReset();
  });

  it("demotes fixing → stopped/workflow_crashed and posts the top-level stop comment (TY-282 #2A)", async () => {
    const deps = makeDeps();
    await demoteFixingOnCrash("pre-fix", deps);

    expect(deps.updateStateComment).toHaveBeenCalledTimes(1);
    const [owner, name, commentId, state, token, options] = (
      deps.updateStateComment as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(owner).toBe("edereship");
    expect(name).toBe("loop-pilot");
    expect(commentId).toBe(12345);
    expect(token).toBe("github-token");
    expect(options).toEqual({ expectedUpdatedAt: "2026-05-15T00:00:00.000Z" });
    expect(state.status).toBe("stopped");
    // TY-282: the stop reason flipped from state_corrupted to workflow_crashed
    // so /restart-review is no longer rejected on this recovery path.
    expect(state.stopReason).toBe("workflow_crashed");
    // TY-273 #B4: the stale-detection timestamp must reset on every terminal
    // transition so a subsequent fixing claim's stale window is honest.
    expect(state.fixingStartedAt).toBeNull();

    expect(warning).toHaveBeenCalledWith(
      "[pre-fix] Crash recovery: resetting fixing → stopped (workflow_crashed)",
    );
    expect(deps.postStopComment).toHaveBeenCalledTimes(1);
    const [psOwner, psName, psPr, psReason, , , psDetail, psToken] = (
      deps.postStopComment as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(psOwner).toBe("edereship");
    expect(psName).toBe("loop-pilot");
    expect(psPr).toBe(999);
    expect(psReason).toBe("workflow_crashed");
    expect(psDetail).toContain("Auto-fix workflow crashed during pre-fix");
    expect(psToken).toBe("github-token");
    expect(error).not.toHaveBeenCalled();
  });

  it("includes the post-fix label in the warning when invoked from post-fix", async () => {
    const deps = makeDeps();
    await demoteFixingOnCrash("post-fix", deps);
    expect(warning).toHaveBeenCalledWith(
      "[post-fix] Crash recovery: resetting fixing → stopped (workflow_crashed)",
    );
  });

  it("does nothing when state.status is not fixing", async () => {
    const deps = makeDeps({
      readState: vi.fn().mockResolvedValue({
        found: true,
        corrupted: false,
        state: { ...makeFixingState(), status: "waiting_codex" },
        commentId: 12345,
        commentUpdatedAt: "2026-05-15T00:00:00.000Z",
      }),
    });
    await demoteFixingOnCrash("pre-fix", deps);
    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.postStopComment).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("does nothing when state is not found", async () => {
    const deps = makeDeps({
      readState: vi.fn().mockResolvedValue({
        found: false,
        corrupted: false,
        commentId: null,
      }),
    });
    await demoteFixingOnCrash("pre-fix", deps);
    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.postStopComment).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("logs core.error and swallows when recovery throws", async () => {
    const deps = makeDeps({
      readState: vi.fn().mockRejectedValue(new Error("read failed")),
    });
    await expect(demoteFixingOnCrash("pre-fix", deps)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      "[pre-fix] Crash recovery failed: read failed",
    );
  });

  it("skips the top-level stop notification when the state write fails, to avoid contradicting the still-`fixing` hidden state (Codex PR #96 P2 on commit 8346b0d)", async () => {
    // Codex P2 (PR #96, comment on src/crash-recovery.ts:114): if
    // `updateStateComment` fails (412 conflict from a concurrent writer,
    // transient 5xx, etc.) the hidden state remains `fixing`. Calling
    // `postStopComment` in that branch would publish a "Stopped" entry on
    // the visible status comment and a top-level "⚠️ LoopPilot stopped"
    // notification, while the hidden state still claims `fixing`. The
    // operator sees the "Stopped" signal, tries `/restart-review`,
    // `applyRestartToState` rejects it — exactly the silent-unrecoverable
    // UX TY-282 set out to fix. The workflow YAML 2B fail-safe step posts
    // a distinct "⚠️ LoopPilot crashed" message in this case, which does
    // NOT claim demotion happened.
    const deps = makeDeps({
      updateStateComment: vi.fn().mockRejectedValue(new Error("412 conflict")),
    });
    await demoteFixingOnCrash("post-fix", deps);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        "[post-fix] Crash recovery state write failed: 412 conflict",
      ),
    );
    expect(deps.postStopComment).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(
        "Skipping top-level stop notification because the state demotion failed",
      ),
    );
  });

  it("uses the asserting demotion detail when the state write succeeded (TY-282 #2A)", async () => {
    const deps = makeDeps();
    await demoteFixingOnCrash("post-fix", deps);
    const detail = (deps.postStopComment as ReturnType<typeof vi.fn>).mock.calls[0][6] as string;
    expect(detail).toContain("has been demoted to stopped/workflow_crashed");
  });

  it("logs but swallows when postStopComment itself throws", async () => {
    // The state write already succeeded; failing on the notification must not
    // mask the recovery. The workflow-level fail-safe step posts the
    // backstop comment in this case.
    const deps = makeDeps({
      postStopComment: vi.fn().mockRejectedValue(new Error("API down")),
    });
    await demoteFixingOnCrash("post-fix", deps);
    expect(deps.updateStateComment).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "[post-fix] Crash recovery notification failed: API down",
    );
  });

  it("logs core.error with stringified non-Error rejection at outer scope", async () => {
    const deps = makeDeps({
      readState: vi.fn().mockRejectedValue("conflict"),
    });
    await demoteFixingOnCrash("post-fix", deps);
    expect(error).toHaveBeenCalledWith(
      "[post-fix] Crash recovery failed: conflict",
    );
  });

  it("TY-302 #1: rolls back the orphan iteration / findings-hash entry pre-fix Phase 3 claimed before the crash", async () => {
    // Pre-fix Phase 3 sets `status: fixing` + `iterationCount: N+1` and
    // appends a new history entry before claude-code-action runs. A crash
    // before post-fix commits the fix used to leave this orphan bookkeeping
    // intact, so the first soft `/restart-review` produced a phantom
    // `loop_detected` (next pre-fix matched the orphan entry on the same
    // hash). Crash recovery now rolls back iterationCount, findingsHashHistory,
    // and lastFindingsHash alongside the status demotion.
    const deps = makeDeps({
      readState: vi.fn().mockResolvedValue({
        found: true,
        corrupted: false,
        state: {
          ...createInitialState(),
          status: "fixing",
          iterationCount: 3,
          findingsHashHistory: [
            { iteration: 1, hash: "aaaaaaaaaaaaaaaa", modelTier: "base" },
            { iteration: 2, hash: "bbbbbbbbbbbbbbbb", modelTier: "base" },
            { iteration: 3, hash: "cccccccccccccccc", modelTier: "escalated" },
          ],
          lastFindingsHash: "cccccccccccccccc",
          fixingStartedAt: "2026-05-23T00:00:00Z",
        },
        commentId: 12345,
        commentUpdatedAt: "2026-05-15T00:00:00.000Z",
      }),
    });

    await demoteFixingOnCrash("pre-fix", deps);

    const [, , , writtenState] = (
      deps.updateStateComment as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(writtenState).toMatchObject({
      status: "stopped",
      stopReason: "workflow_crashed",
      iterationCount: 2,
      findingsHashHistory: [
        { iteration: 1, hash: "aaaaaaaaaaaaaaaa", modelTier: "base" },
        { iteration: 2, hash: "bbbbbbbbbbbbbbbb", modelTier: "base" },
      ],
      lastFindingsHash: "bbbbbbbbbbbbbbbb",
      fixingStartedAt: null,
    });
  });

  it("ES-421: clears currentIterationFindingCommentIds so a subsequent restart does not resolve un-fixed threads", async () => {
    const deps = makeDeps({
      readState: vi.fn().mockResolvedValue({
        found: true,
        corrupted: false,
        state: {
          ...createInitialState(),
          status: "fixing",
          fixingStartedAt: "2026-05-23T00:00:00Z",
          currentIterationFindingCommentIds: [111, 222, 333],
        },
        commentId: 12345,
        commentUpdatedAt: "2026-05-15T00:00:00.000Z",
      }),
    });

    await demoteFixingOnCrash("pre-fix", deps);

    const [, , , writtenState] = (
      deps.updateStateComment as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(writtenState.currentIterationFindingCommentIds).toEqual([]);
  });

  it("TY-302 #1: leaves iteration / history untouched when the last entry's iteration does not match (legacy / hand-edited state)", async () => {
    // Defensive: if the bookkeeping invariant is broken (last entry's iteration
    // !== state.iterationCount), the rollback heuristic does not fire so the
    // helper does not blindly destroy state we cannot reason about.
    const deps = makeDeps({
      readState: vi.fn().mockResolvedValue({
        found: true,
        corrupted: false,
        state: {
          ...createInitialState(),
          status: "fixing",
          iterationCount: 5,
          findingsHashHistory: [
            { iteration: 1, hash: "aaaaaaaaaaaaaaaa", modelTier: "base" },
          ],
          lastFindingsHash: "aaaaaaaaaaaaaaaa",
          fixingStartedAt: "2026-05-23T00:00:00Z",
        },
        commentId: 12345,
        commentUpdatedAt: "2026-05-15T00:00:00.000Z",
      }),
    });

    await demoteFixingOnCrash("pre-fix", deps);

    const [, , , writtenState] = (
      deps.updateStateComment as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(writtenState).toMatchObject({
      status: "stopped",
      stopReason: "workflow_crashed",
      iterationCount: 5,
      findingsHashHistory: [
        { iteration: 1, hash: "aaaaaaaaaaaaaaaa", modelTier: "base" },
      ],
      lastFindingsHash: "aaaaaaaaaaaaaaaa",
      fixingStartedAt: null,
    });
  });
});
