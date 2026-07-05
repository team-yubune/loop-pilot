import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { runInit, type InitDeps } from "../src/main-init.js";
import { createInitialState, StateUpdateConflictError } from "../src/state-manager.js";
import type { ReadStateResult } from "../src/state-manager.js";
import type { ReviewState } from "../src/types.js";

const baseConfig: Config = {
  maxReviewIterations: 20,
  debounceSeconds: 90,
  checkCommand: "npm run check",
  buildCommand: "",
  codexBotLogin: "chatgpt-codex-connector[bot]",
  stabilizeIntervalSeconds: 10,
  stabilizeCount: 3,
  codexReviewRequestToken: "codex-token",
  autoReviewPushToken: "github-token",
  anthropicApiKey: "",
  claudeCodeOauthToken: "",
  githubToken: "github-token",
  repoOwner: "edereship",
  repoName: "loop-pilot",
  prNumber: 227,
  triggerCommentId: 0,
  triggerCommentBody: "",
  triggerUserLogin: "",
  triggerEventName: "",
  prHeadRef: "linear/TY-227",
  prTitle: "TY-227",
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

function makeState(overrides: Partial<ReviewState> = {}): ReviewState {
  return { ...createInitialState(), ...overrides };
}

function makeDeps(readResult: ReadStateResult) {
  return {
    readState: vi.fn().mockResolvedValue(readResult),
    createStateComment: vi.fn().mockResolvedValue(12345),
    updateStateComment: vi.fn().mockResolvedValue({ updatedAt: "2026-05-15T00:00:01Z" }),
    postCodexReviewRequest: vi.fn().mockResolvedValue(67890),
    postInitialStatusComment: vi.fn().mockResolvedValue(54321),
    postStopComment: vi.fn().mockResolvedValue(99999),
    ensureCodexAck: vi.fn().mockResolvedValue({
      acked: true,
      reason: "eyes",
      reposts: 0,
      lastCommentId: 67890,
    }),
    setSecret: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    setOutput: vi.fn(),
  } satisfies InitDeps;
}

describe("runInit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["waiting_codex", "fixing", "done", "stopped"] as const)(
    "does not reset state or post a new review request when existing state is %s",
    async (status) => {
      const deps = makeDeps({
        found: true,
        corrupted: false,
        commentId: 111,
        commentUpdatedAt: "2026-05-15T00:00:00Z",
        state: makeState({ status, lastCodexRequestCommentId: 222 }),
      });

      await runInit(baseConfig, deps);

      expect(deps.updateStateComment).not.toHaveBeenCalled();
      expect(deps.createStateComment).not.toHaveBeenCalled();
      expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
      expect(deps.setOutput).toHaveBeenCalledWith("comment-id", "111");
    },
  );

  it("TY-303 #A: continues init via 1st-write → post → 2nd-write when prior run stopped before @codex review", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 111,
      commentUpdatedAt: "2026-05-15T00:00:00Z",
      state: makeState({ status: "initialized", lastCodexRequestCommentId: null }),
    });

    await runInit(baseConfig, deps);

    expect(deps.postCodexReviewRequest).toHaveBeenCalledTimes(1);
    expect(deps.updateStateComment).toHaveBeenCalledTimes(2);
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      1,
      "edereship",
      "loop-pilot",
      111,
      expect.objectContaining({
        status: "waiting_codex",
        lastCodexRequestCommentId: null,
      }),
      "github-token",
      { expectedUpdatedAt: "2026-05-15T00:00:00Z" },
    );
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      2,
      "edereship",
      "loop-pilot",
      111,
      expect.objectContaining({
        status: "waiting_codex",
        lastCodexRequestCommentId: 67890,
      }),
      "github-token",
      { expectedUpdatedAt: "2026-05-15T00:00:01Z" },
    );
    // Confirm ordering: 1st updateStateComment happens before the @codex post,
    // which happens before the 2nd updateStateComment.
    expect(deps.updateStateComment.mock.invocationCallOrder[0]).toBeLessThan(
      deps.postCodexReviewRequest.mock.invocationCallOrder[0],
    );
    expect(deps.postCodexReviewRequest.mock.invocationCallOrder[0]).toBeLessThan(
      deps.updateStateComment.mock.invocationCallOrder[1],
    );
  });

  it("TY-303 #B: reposts @codex review via 1st-write → post → 2nd-write when resuming legacy initialized state (prior post, waiting_codex not persisted)", async () => {
    // The prior @codex review trigger was a one-shot `created` event that fired
    // while state was still `initialized`. Workflow B's early-return consumed it
    // without processing, so a fresh post is required to regenerate the trigger.
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 111,
      commentUpdatedAt: "2026-05-15T00:00:00Z",
      state: makeState({ status: "initialized", lastCodexRequestCommentId: 12345 }),
    });

    await runInit(baseConfig, deps);

    expect(deps.postCodexReviewRequest).toHaveBeenCalledTimes(1);
    expect(deps.updateStateComment).toHaveBeenCalledTimes(2);
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      1,
      "edereship",
      "loop-pilot",
      111,
      expect.objectContaining({
        status: "waiting_codex",
        lastCodexRequestCommentId: null,
      }),
      "github-token",
      { expectedUpdatedAt: "2026-05-15T00:00:00Z" },
    );
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      2,
      "edereship",
      "loop-pilot",
      111,
      expect.objectContaining({
        status: "waiting_codex",
        lastCodexRequestCommentId: 67890,
      }),
      "github-token",
      { expectedUpdatedAt: "2026-05-15T00:00:01Z" },
    );
    expect(deps.updateStateComment.mock.invocationCallOrder[0]).toBeLessThan(
      deps.postCodexReviewRequest.mock.invocationCallOrder[0],
    );
    expect(deps.postCodexReviewRequest.mock.invocationCallOrder[0]).toBeLessThan(
      deps.updateStateComment.mock.invocationCallOrder[1],
    );
  });

  it("TY-303: rolls back state to initialized and re-throws when postCodexReviewRequest fails after 1st write", async () => {
    const deps = makeDeps({ found: false, corrupted: false, commentId: null });
    deps.postCodexReviewRequest = vi.fn().mockRejectedValue(new Error("api error"));

    await expect(runInit(baseConfig, deps)).rejects.toThrow("api error");

    expect(deps.updateStateComment).toHaveBeenCalledTimes(2);
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      1,
      "edereship",
      "loop-pilot",
      12345,
      expect.objectContaining({ status: "waiting_codex" }),
      "github-token",
    );
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      2,
      "edereship",
      "loop-pilot",
      12345,
      expect.objectContaining({ status: "initialized" }),
      "github-token",
      { expectedUpdatedAt: "2026-05-15T00:00:01Z" },
    );
  });

  it("TY-303 #C: new PR follows create → 1st-write → post → 2nd-write", async () => {
    const deps = makeDeps({ found: false, corrupted: false, commentId: null });

    await runInit(baseConfig, deps);

    expect(deps.createStateComment).toHaveBeenCalledTimes(1);
    expect(deps.postCodexReviewRequest).toHaveBeenCalledTimes(1);
    expect(deps.updateStateComment).toHaveBeenCalledTimes(2);
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      1,
      "edereship",
      "loop-pilot",
      12345,
      expect.objectContaining({
        status: "waiting_codex",
        lastCodexRequestCommentId: null,
      }),
      "github-token",
    );
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      2,
      "edereship",
      "loop-pilot",
      12345,
      expect.objectContaining({
        status: "waiting_codex",
        lastCodexRequestCommentId: 67890,
      }),
      "github-token",
      { expectedUpdatedAt: "2026-05-15T00:00:01Z" },
    );
  });

  it("TY-334: demotes to stopped/codex_request_failed and notifies when Codex never ACKs the init review", async () => {
    const deps = makeDeps({ found: false, corrupted: false, commentId: null });
    deps.ensureCodexAck = vi.fn().mockResolvedValue({
      acked: false,
      reason: "exhausted",
      reposts: 2,
      lastCommentId: 777,
    });

    await runInit(baseConfig, deps);

    const writes = (deps.updateStateComment as ReturnType<typeof vi.fn>).mock
      .calls as unknown as Array<[string, string, number, ReviewState, string]>;
    const stoppedWrite = writes.find(
      (c) => c[3]?.status === "stopped" && c[3]?.stopReason === "codex_request_failed",
    );
    expect(stoppedWrite).toBeDefined();
    expect(stoppedWrite?.[3].lastCodexRequestCommentId).toBe(777);

    const stopCalls = (deps.postStopComment as ReturnType<typeof vi.fn>).mock
      .calls as unknown as Array<[string, string, number, string, number, number, string]>;
    const stopCall = stopCalls.find((c) => c[3] === "codex_request_failed");
    expect(stopCall).toBeDefined();
    expect(stopCall?.[6]).toContain("did not acknowledge");
  });

  it("TY-303 #D: corrupted state recovery → overwrite + 1st-write → post → 2nd-write", async () => {
    const deps = makeDeps({
      found: false,
      corrupted: true,
      commentId: 111,
    });

    await runInit(baseConfig, deps);

    expect(deps.updateStateComment).toHaveBeenCalledTimes(3);
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      1,
      "edereship",
      "loop-pilot",
      111,
      expect.objectContaining({ status: "initialized" }),
      "github-token",
    );
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      2,
      "edereship",
      "loop-pilot",
      111,
      expect.objectContaining({
        status: "waiting_codex",
        lastCodexRequestCommentId: null,
      }),
      "github-token",
    );
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      3,
      "edereship",
      "loop-pilot",
      111,
      expect.objectContaining({
        status: "waiting_codex",
        lastCodexRequestCommentId: 67890,
      }),
      "github-token",
      { expectedUpdatedAt: "2026-05-15T00:00:01Z" },
    );
    expect(deps.postCodexReviewRequest).toHaveBeenCalledTimes(1);
  });

  it("TY-303 #E: 2nd-write failure is downgraded to warning and runInit does not reject", async () => {
    const deps = makeDeps({ found: false, corrupted: false, commentId: null });
    let updateCalls = 0;
    deps.updateStateComment = vi.fn().mockImplementation(async () => {
      updateCalls += 1;
      if (updateCalls === 2) {
        throw new Error("network");
      }
      return { updatedAt: "2026-05-15T00:00:01Z" };
    });

    await expect(runInit(baseConfig, deps)).resolves.toBeUndefined();

    expect(deps.postCodexReviewRequest).toHaveBeenCalledTimes(1);
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining("reconcile"),
    );
    expect(deps.setOutput).toHaveBeenCalledWith("comment-id", "12345");
  });

  it("seeds the visible status comment after init succeeds (TY-291 #2)", async () => {
    const deps = makeDeps({ found: false, corrupted: false, commentId: null });

    await runInit(baseConfig, deps);

    expect(deps.postInitialStatusComment).toHaveBeenCalledTimes(1);
    expect(deps.postInitialStatusComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      227,
      20,
      "github-token",
    );
  });

  it("passes the configured maxReviewIterations (not a hardcoded 20) to the initial status comment (Finding 2)", async () => {
    const deps = makeDeps({ found: false, corrupted: false, commentId: null });

    await runInit({ ...baseConfig, maxReviewIterations: 15 }, deps);

    expect(deps.postInitialStatusComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      227,
      15,
      "github-token",
    );
  });

  it("reflects an operator-configured cap in the initial status comment (TY-309)", async () => {
    // Regression guard for the init-comment cap matching vars.MAX_REVIEW_ITERATIONS.
    // The init workflow plumbs vars.MAX_REVIEW_ITERATIONS into the action; once
    // it lands in config.maxReviewIterations it must reach postInitialStatusComment
    // so the very first comment shows "Iterations: 0 / N" with the operator's N
    // rather than the default 20.
    const deps = makeDeps({ found: false, corrupted: false, commentId: null });

    await runInit({ ...baseConfig, maxReviewIterations: 50 }, deps);

    expect(deps.postInitialStatusComment).toHaveBeenCalledWith(
      "edereship",
      "loop-pilot",
      227,
      50,
      "github-token",
    );
  });

  it("swallows postInitialStatusComment failures without rolling back init (TY-291 #2)", async () => {
    const deps = makeDeps({ found: false, corrupted: false, commentId: null });
    deps.postInitialStatusComment = vi
      .fn()
      .mockRejectedValue(new Error("network"));

    await runInit(baseConfig, deps);

    expect(deps.setOutput).toHaveBeenCalledWith("comment-id", "12345");
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining("Failed to create initial status comment"),
    );
  });

  it("Finding 2: recovers from crash-window state (waiting_codex + null) by re-posting @codex review", async () => {
    // Simulates: job crashed after 1st write but before @codex review was posted.
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 111,
      commentUpdatedAt: "2026-05-15T00:00:00Z",
      state: makeState({ status: "waiting_codex", lastCodexRequestCommentId: null }),
    });

    await runInit(baseConfig, deps);

    // Must re-post and not skip
    expect(deps.postCodexReviewRequest).toHaveBeenCalledTimes(1);
    // 1st write (idempotent re-write to waiting_codex+null) + 2nd write
    expect(deps.updateStateComment).toHaveBeenCalledTimes(2);
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      1,
      "edereship",
      "loop-pilot",
      111,
      expect.objectContaining({ status: "waiting_codex", lastCodexRequestCommentId: null }),
      "github-token",
      { expectedUpdatedAt: "2026-05-15T00:00:00Z" },
    );
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      2,
      "edereship",
      "loop-pilot",
      111,
      expect.objectContaining({ status: "waiting_codex", lastCodexRequestCommentId: 67890 }),
      "github-token",
      { expectedUpdatedAt: "2026-05-15T00:00:01Z" },
    );
    expect(deps.setOutput).toHaveBeenCalledWith("comment-id", "111");
  });

  it("Finding 2: crash-window recovery rolls back to initialized when post fails (allows rerun)", async () => {
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 111,
      commentUpdatedAt: "2026-05-15T00:00:00Z",
      state: makeState({ status: "waiting_codex", lastCodexRequestCommentId: null }),
    });
    deps.postCodexReviewRequest = vi.fn().mockRejectedValue(new Error("post failed"));

    await expect(runInit(baseConfig, deps)).rejects.toThrow("post failed");

    // Call 1: idempotent 1st write; Call 2: rollback to initialized (with optimistic lock)
    expect(deps.updateStateComment).toHaveBeenCalledTimes(2);
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      2,
      "edereship",
      "loop-pilot",
      111,
      expect.objectContaining({ status: "initialized" }),
      "github-token",
      { expectedUpdatedAt: "2026-05-15T00:00:01Z" },
    );
  });

  it("Finding 3: writes stopped/codex_request_failed when both post and rollback fail (double-failure)", async () => {
    const deps = makeDeps({ found: false, corrupted: false, commentId: null });
    deps.postCodexReviewRequest = vi.fn().mockRejectedValue(new Error("post failed"));
    let updateCalls = 0;
    deps.updateStateComment = vi.fn().mockImplementation(async () => {
      updateCalls += 1;
      if (updateCalls === 2) throw new Error("rollback failed");
      return { updatedAt: "2026-05-15T00:00:01Z" };
    });

    await expect(runInit(baseConfig, deps)).rejects.toThrow("post failed");

    // Call 1: 1st write; Call 2: rollback (throws); Call 3: stopped/codex_request_failed
    expect(deps.updateStateComment).toHaveBeenCalledTimes(3);
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      3,
      "edereship",
      "loop-pilot",
      12345,
      expect.objectContaining({ status: "stopped", stopReason: "codex_request_failed" }),
      "github-token",
      { expectedUpdatedAt: "2026-05-15T00:00:01Z" },
    );
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining("codex_request_failed"),
    );
  });

  it("Finding 1: StateUpdateConflictError on 2nd write is downgraded to warning (loop remains healthy)", async () => {
    const deps = makeDeps({ found: false, corrupted: false, commentId: null });
    let updateCalls = 0;
    deps.updateStateComment = vi.fn().mockImplementation(async () => {
      updateCalls += 1;
      if (updateCalls === 2) throw new StateUpdateConflictError("conflict");
      return { updatedAt: "2026-05-15T00:00:01Z" };
    });

    await expect(runInit(baseConfig, deps)).resolves.toBeUndefined();

    expect(deps.postCodexReviewRequest).toHaveBeenCalledTimes(1);
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining("reconcile"),
    );
    expect(deps.setOutput).toHaveBeenCalledWith("comment-id", "12345");
    // StateUpdateConflictError means Workflow B advanced the state — no retry needed
    // because a future Workflow A rerun will not see waiting_codex+null.
    expect(deps.updateStateComment).toHaveBeenCalledTimes(2);
  });

  it("Finding 1: non-conflict 2nd-write failure retries with optimistic locking to record reviewRequestId", async () => {
    // Simulates: 1st write ok, post ok, 2nd write fails (network), retry succeeds.
    // After retry the state has a non-null lastCodexRequestCommentId, so a future
    // Workflow A rerun hits the early-return instead of crash-window re-posting.
    // The retry uses expectedUpdatedAt so a concurrent Workflow B advance is detected
    // rather than silently overwritten.
    const deps = makeDeps({ found: false, corrupted: false, commentId: null });
    let updateCalls = 0;
    deps.updateStateComment = vi.fn().mockImplementation(async () => {
      updateCalls += 1;
      if (updateCalls === 2) throw new Error("network");
      return { updatedAt: "2026-05-15T00:00:01Z" };
    });

    await expect(runInit(baseConfig, deps)).resolves.toBeUndefined();

    // Call 1: 1st write; Call 2: 2nd write (throws); Call 3: retry (with expectedUpdatedAt, succeeds)
    expect(deps.updateStateComment).toHaveBeenCalledTimes(3);
    expect(deps.updateStateComment).toHaveBeenNthCalledWith(
      3,
      "edereship",
      "loop-pilot",
      12345,
      expect.objectContaining({ status: "waiting_codex", lastCodexRequestCommentId: 67890 }),
      "github-token",
      { expectedUpdatedAt: "2026-05-15T00:00:01Z" },
    );
    expect(deps.warning).toHaveBeenCalledWith(expect.stringContaining("reconcile"));
    expect(deps.setOutput).toHaveBeenCalledWith("comment-id", "12345");
  });

  it("Finding 1: both 2nd-write attempts fail with non-conflict error → second warning about rerun re-post risk", async () => {
    // Simulates: 2nd write and retry both fail. The state is stuck at
    // waiting_codex+null, which a Workflow A rerun would mistake for crash-window
    // and re-post. The second warning documents this residual risk.
    const deps = makeDeps({ found: false, corrupted: false, commentId: null });
    let updateCalls = 0;
    deps.updateStateComment = vi.fn().mockImplementation(async () => {
      updateCalls += 1;
      if (updateCalls >= 2) throw new Error("network");
      return { updatedAt: "2026-05-15T00:00:01Z" };
    });

    await expect(runInit(baseConfig, deps)).resolves.toBeUndefined();

    expect(deps.updateStateComment).toHaveBeenCalledTimes(3);
    expect(deps.warning).toHaveBeenCalledWith(expect.stringContaining("reconcile"));
    expect(deps.warning).toHaveBeenCalledWith(expect.stringContaining("re-post @codex review"));
    expect(deps.setOutput).toHaveBeenCalledWith("comment-id", "12345");
  });

  it("Finding 1: rollback after post failure skips terminal state when StateUpdateConflictError (Workflow B advanced)", async () => {
    // Simulates: post fails, then rollback detects Workflow B already advanced the
    // state (e.g. waiting_codex → fixing). No terminal state should be written
    // because Workflow B is handling the transition.
    const deps = makeDeps({ found: false, corrupted: false, commentId: null });
    deps.postCodexReviewRequest = vi.fn().mockRejectedValue(new Error("api error"));
    let updateCalls = 0;
    deps.updateStateComment = vi.fn().mockImplementation(async () => {
      updateCalls += 1;
      if (updateCalls === 2) throw new StateUpdateConflictError("conflict");
      return { updatedAt: "2026-05-15T00:00:01Z" };
    });

    await expect(runInit(baseConfig, deps)).rejects.toThrow("api error");

    // Call 1: 1st write; Call 2: rollback throws StateUpdateConflictError — no terminal state
    expect(deps.updateStateComment).toHaveBeenCalledTimes(2);
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining("Workflow B"),
    );
  });

  it("Finding 2: 2nd-write retry detects StateUpdateConflictError and logs no-re-post-risk warning", async () => {
    // Simulates: 1st write ok, post ok, 2nd write fails (network), retry detects
    // Workflow B advanced the state (StateUpdateConflictError). No re-post risk.
    const deps = makeDeps({ found: false, corrupted: false, commentId: null });
    let updateCalls = 0;
    deps.updateStateComment = vi.fn().mockImplementation(async () => {
      updateCalls += 1;
      if (updateCalls === 2) throw new Error("network");
      if (updateCalls === 3) throw new StateUpdateConflictError("conflict");
      return { updatedAt: "2026-05-15T00:00:01Z" };
    });

    await expect(runInit(baseConfig, deps)).resolves.toBeUndefined();

    expect(deps.updateStateComment).toHaveBeenCalledTimes(3);
    expect(deps.warning).toHaveBeenCalledWith(expect.stringContaining("reconcile"));
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining("No re-post risk"),
    );
    expect(deps.setOutput).toHaveBeenCalledWith("comment-id", "12345");
  });

  it("Finding 2: skips crash-window resume when iterationCount > 0 (restart transient state, not a fresh init)", async () => {
    // Simulates: /restart-review's 1st write produces waiting_codex + null,
    // but iterationCount > 0 means this is not a fresh init crash-window.
    // Workflow A should take the non-initialized early-return path instead of
    // re-posting @codex review.
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 111,
      commentUpdatedAt: "2026-05-15T00:00:00Z",
      state: makeState({ status: "waiting_codex", lastCodexRequestCommentId: null, iterationCount: 5 }),
    });

    await runInit(baseConfig, deps);

    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
    expect(deps.setOutput).toHaveBeenCalledWith("comment-id", "111");
  });

  it("Finding 2: skips crash-window resume when lastCodexReviewReceivedAt is non-null (prior Codex review exists)", async () => {
    // Simulates: /restart-review's 1st write with a preserved lastCodexReviewReceivedAt.
    // A non-null timestamp means Codex has already reviewed this PR at some point,
    // so waiting_codex + null cannot be a genuine init crash-window.
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 111,
      commentUpdatedAt: "2026-05-15T00:00:00Z",
      state: makeState({
        status: "waiting_codex",
        lastCodexRequestCommentId: null,
        lastCodexReviewReceivedAt: "2026-05-14T00:00:00Z",
      }),
    });

    await runInit(baseConfig, deps);

    expect(deps.updateStateComment).not.toHaveBeenCalled();
    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
    expect(deps.setOutput).toHaveBeenCalledWith("comment-id", "111");
  });

  it("Finding 1: StateUpdateConflictError on 1st write aborts gracefully when resuming existing comment", async () => {
    // Simulates: Workflow B advanced the state between readState and the 1st write.
    // runInit should log a warning and return cleanly without re-posting @codex review.
    const deps = makeDeps({
      found: true,
      corrupted: false,
      commentId: 111,
      commentUpdatedAt: "2026-05-15T00:00:00Z",
      state: makeState({ status: "initialized" }),
    });
    deps.updateStateComment = vi.fn().mockRejectedValue(new StateUpdateConflictError("concurrent"));

    await expect(runInit(baseConfig, deps)).resolves.toBeUndefined();

    expect(deps.postCodexReviewRequest).not.toHaveBeenCalled();
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining("Workflow B"),
    );
    expect(deps.setOutput).toHaveBeenCalledWith("comment-id", "111");
  });

  it("Finding 3: StateUpdateConflictError on fallback stop write logs conflict warning (Workflow B already advanced)", async () => {
    // Simulates: post fails, rollback fails (non-conflict), fallback stop write
    // detects Workflow B already advanced the state — no terminal state needed.
    const deps = makeDeps({ found: false, corrupted: false, commentId: null });
    deps.postCodexReviewRequest = vi.fn().mockRejectedValue(new Error("post failed"));
    let updateCalls = 0;
    deps.updateStateComment = vi.fn().mockImplementation(async () => {
      updateCalls += 1;
      if (updateCalls === 2) throw new Error("rollback failed");
      if (updateCalls === 3) throw new StateUpdateConflictError("concurrent");
      return { updatedAt: "2026-05-15T00:00:01Z" };
    });

    await expect(runInit(baseConfig, deps)).rejects.toThrow("post failed");

    expect(deps.updateStateComment).toHaveBeenCalledTimes(3);
    expect(deps.warning).toHaveBeenCalledWith(
      expect.stringContaining("Fallback stop write detected concurrent state update"),
    );
    expect(deps.warning).not.toHaveBeenCalledWith(
      expect.stringContaining("manual intervention required"),
    );
  });
});
