import { describe, it, expect } from "vitest";
import {
  buildTrustedAuthorJqFilter,
  createInitialState,
  serializeState,
  deserializeState,
  getTrustedStateCommentAuthors,
  parseStateCommentRecord,
  updateStateComment,
  StateUpdateConflictError,
} from "../src/state-manager.js";
import type { ReviewState, FindingsHashEntry } from "../src/types.js";
import { execFile } from "node:child_process";
import { beforeEach, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFile);

const STATE_MARKER = "looppilot-state";

function makeState(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    ...createInitialState(),
    ...overrides,
  };
}

function mockExecFileOnce(stdout: string): void {
  mockedExecFile.mockImplementationOnce(((_file, _args, _options, callback) => {
    (callback as unknown as (e: unknown, v: { stdout: string; stderr: string }) => void)(
      null,
      { stdout, stderr: "" },
    );
    return {} as ReturnType<typeof execFile>;
  }) as typeof execFile);
}

function mockExecFileErrorOnce(opts: {
  message?: string;
  stderr?: string;
  stdout?: string;
}): void {
  mockedExecFile.mockImplementationOnce(((_file, _args, _options, callback) => {
    const err = new Error(opts.message ?? "exec failed") as Error & {
      stderr?: string;
      stdout?: string;
    };
    if (opts.stderr !== undefined) err.stderr = opts.stderr;
    if (opts.stdout !== undefined) err.stdout = opts.stdout;
    (callback as (err: Error) => void)(err);
    return {} as ReturnType<typeof execFile>;
  }) as typeof execFile);
}

beforeEach(() => {
  mockedExecFile.mockReset();
});

describe("serializeState", () => {
  it("includes visible text so GitHub does not render it as an empty comment", () => {
    const state = makeState();
    const serialized = serializeState(state);

    expect(serialized.startsWith("LoopPilot state is stored in this comment.")).toBe(true);
  });

  it("serializes to hidden comment format (contains marker + JSON + closing)", () => {
    const state = makeState();
    const serialized = serializeState(state);

    expect(serialized).toContain(`<!-- ${STATE_MARKER}`);
    expect(serialized).toContain("-->");
    // The JSON content should be parseable
    const jsonMatch = serialized.match(
      /<!-- looppilot-state\n([\s\S]*?)\n-->/,
    );
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed).toMatchObject({ iterationCount: 0 });
  });

  it("round-trip: serialize then deserialize preserves state", () => {
    const original = makeState({
      iterationCount: 3,
      lastProcessedReviewId: 42,
      lastClaudeCommitSha: "abc123",
      lastCodexRequestCommentId: 7,
      lastCodexReviewReceivedAt: "2026-01-01T00:00:00Z",
      lastFindingsHash: "hash1",
      findingsHashHistory: [
        { iteration: 1, hash: "aaa" },
        { iteration: 2, hash: "bbb" },
        { iteration: 3, hash: "ccc" },
      ],
      status: "fixing",
      stopReason: null,
    });

    const serialized = serializeState(original);
    const restored = deserializeState(serialized);

    expect(restored).not.toBeNull();
    expect(restored!.iterationCount).toBe(3);
    expect(restored!.lastProcessedReviewId).toBe(42);
    expect(restored!.lastClaudeCommitSha).toBe("abc123");
    expect(restored!.lastCodexRequestCommentId).toBe(7);
    expect(restored!.lastCodexReviewReceivedAt).toBe("2026-01-01T00:00:00Z");
    expect(restored!.lastFindingsHash).toBe("hash1");
    expect(restored!.status).toBe("fixing");
    expect(restored!.stopReason).toBeNull();
    expect(restored!.findingsHashHistory).toHaveLength(3);
  });

  it("trims findingsHashHistory to max 20 entries on serialization (TY-296)", () => {
    // TY-296: history cap was bumped from 3 → 20 so `isLoop` can catch
    // oscillations of cycle length up to MAX_REVIEW_ITERATIONS' default.
    const longHistory: FindingsHashEntry[] = Array.from({ length: 25 }, (_, i) => ({
      iteration: i + 1,
      hash: `h${i + 1}`,
    }));
    const state = makeState({ findingsHashHistory: longHistory });
    const serialized = serializeState(state);
    const restored = deserializeState(serialized);

    expect(restored).not.toBeNull();
    expect(restored!.findingsHashHistory).toHaveLength(20);
    // The most recent 20 entries should be retained (h6 .. h25).
    expect(restored!.findingsHashHistory[0].hash).toBe("h6");
    expect(restored!.findingsHashHistory[19].hash).toBe("h25");
  });

  it("TY-296: keeps the body under MAX_SERIALIZED_BYTES with a full 20-entry history + max-cap previousCheckFailure", () => {
    // The history cap bump is only safe if the resulting body still fits
    // GitHub's 65,536-char comment-body limit (MAX_SERIALIZED_BYTES guard at
    // 65,000) alongside a full-budget previousCheckFailure (20,000 chars at
    // write time, per PREVIOUS_CHECK_FAILURE_MAX_CHARS).
    const fullHistory: FindingsHashEntry[] = Array.from({ length: 20 }, (_, i) => ({
      iteration: i + 1,
      hash: `hash-${i + 1}`.padEnd(16, "0"),
      modelTier: i % 2 === 0 ? "base" : "escalated",
    }));
    const state = makeState({
      findingsHashHistory: fullHistory,
      previousCheckFailure: "L".repeat(20_000),
    });

    const serialized = serializeState(state);

    expect(serialized.length).toBeLessThanOrEqual(65_000);
    const restored = deserializeState(serialized);
    expect(restored).not.toBeNull();
    // Step 1 (history-only trim, no previousCheckFailure shrink) should be
    // sufficient at the configured budget — guard against silent regression
    // into the Step 2 / Step 3 fallback for the normal-operation envelope.
    expect(restored!.findingsHashHistory).toHaveLength(20);
    expect(restored!.previousCheckFailure).toBe("L".repeat(20_000));
  });

  it("TY-287 #1: re-truncates previousCheckFailure in the fallback path so an oversized blob cannot push the body over 65,000 chars", () => {
    // serializeState does not run validateState on its input, so a legacy
    // / hand-edited state may carry a previousCheckFailure that, when
    // wrapped + serialized, exceeds GitHub's 65,536-char comment-body
    // limit even with findingsHashHistory trimmed to 1 entry. The Step 1
    // fallback (history-only) was insufficient; Step 2 must re-truncate
    // previousCheckFailure with the head/tail helper.
    const oversizedFailure = "X".repeat(70_000);
    const state = makeState({
      previousCheckFailure: oversizedFailure,
      findingsHashHistory: [
        { iteration: 1, hash: "h1" },
        { iteration: 2, hash: "h2" },
        { iteration: 3, hash: "h3" },
      ],
    });

    const serialized = serializeState(state);

    expect(serialized.length).toBeLessThanOrEqual(65_000);
    const restored = deserializeState(serialized);
    expect(restored).not.toBeNull();
    // History was shrunk and previousCheckFailure was re-truncated with
    // truncatePreviousCheckFailure(_, 4000). The result must still be a
    // string (preserving actionable head/tail context) and dramatically
    // shorter than the 70,000-char input.
    expect(typeof restored!.previousCheckFailure).toBe("string");
    expect(restored!.previousCheckFailure!.length).toBeLessThan(5_000);
  });

  it("TY-287 #1: guarantees body ≤ 65,000 chars even for a pathologically oversized previousCheckFailure (Step 2 / Step 3 floor)", () => {
    // The 3-step fallback's invariant: regardless of how oversized
    // previousCheckFailure is, the wrapped body is bounded so the eventual
    // updateStateComment PATCH cannot exceed GitHub's 65,536-char limit.
    // Step 2 re-truncates to ~4,000 chars and Step 3 (the floor) nulls the
    // field outright — pre-fix would otherwise crash on the 422 returned by
    // an oversized PATCH because it is not a StateUpdateConflictError.
    const veryLargeFailure = "Y".repeat(200_000);
    const state = makeState({
      previousCheckFailure: veryLargeFailure,
    });

    const serialized = serializeState(state);

    expect(serialized.length).toBeLessThanOrEqual(65_000);
    const restored = deserializeState(serialized);
    expect(restored).not.toBeNull();
    // Either Step 2 (truncated string) or Step 3 (null) is acceptable; the
    // invariant the caller depends on is "the body fits", not which step
    // happened to fit it.
    expect(restored!.previousCheckFailure?.length ?? 0).toBeLessThan(35_000);
  });

  it("TY-339 #1: serialize stays ≤ 65,000 chars AND round-trips with every retained string field at its validateState cap", () => {
    // The fallback chain's floor claims dropping previousCheckFailure
    // "guarantees the body fits" because every *other* field is bounded. That
    // only holds once validateState caps lastClaudeCommitSha / lastFindingsHash
    // / history hashes / the two retained timestamps (TY-339 #1 + follow-up).
    // Construct a valid state with all of those at their accepted maxima plus an
    // oversized previousCheckFailure (forces the fallback path) and assert the
    // body fits and still deserializes — i.e. the capped fields pass
    // validateState, so the floor guarantee is real.
    const state = makeState({
      status: "stopped",
      stopReason: "max_iterations",
      lastClaudeCommitSha: "a".repeat(64),
      lastFindingsHash: "b".repeat(64),
      findingsHashHistory: Array.from({ length: 20 }, (_, i) => ({
        iteration: i + 1,
        hash: "c".repeat(64),
        modelTier: "escalated" as const,
      })),
      // TY-339 #1 follow-up: the floor also keeps these two timestamps verbatim,
      // so include them at their validateState cap to assert the guarantee holds
      // for every retained string field, not just the SHA / hash ones.
      lastCodexReviewReceivedAt: "d".repeat(64),
      fixingStartedAt: "e".repeat(64),
      previousCheckFailure: "Z".repeat(200_000),
    });

    const serialized = serializeState(state);

    expect(serialized.length).toBeLessThanOrEqual(65_000);
    const restored = deserializeState(serialized);
    expect(restored).not.toBeNull();
    // The fallback bounded previousCheckFailure (Step 2 re-truncate or Step 3
    // null); the capped non-trimmed fields survived validation intact.
    expect(restored!.previousCheckFailure?.length ?? 0).toBeLessThan(35_000);
    expect(restored!.lastClaudeCommitSha).toBe("a".repeat(64));
    expect(restored!.lastFindingsHash).toBe("b".repeat(64));
    expect(restored!.lastCodexReviewReceivedAt).toBe("d".repeat(64));
    expect(restored!.fixingStartedAt).toBe("e".repeat(64));
  });
});

describe("deserializeState", () => {
  it("returns null for a comment body without the state marker", () => {
    const body = "This is just a regular PR comment with no state.";
    expect(deserializeState(body)).toBeNull();
  });

  it("returns null for a comment body with corrupted JSON", () => {
    const corruptedBody = `<!-- looppilot-state\n{not valid json\n-->`;
    expect(deserializeState(corruptedBody)).toBeNull();
  });

  it("rejects iterationCount=Infinity (Number.isInteger guard, TY-275 #5)", () => {
    // `typeof Infinity === "number"` so the loose check let it through and
    // would force max_iterations on the next iteration. Number.isInteger
    // rejects all non-finite + non-integer floats together.
    const body = serializeState(makeState()).replace(
      /"iterationCount":\s*\d+/,
      '"iterationCount": 1e308',
    );
    expect(deserializeState(body)).toBeNull();
  });

  it("rejects iterationCount=NaN (Number.isInteger guard, TY-275 #5)", () => {
    // NaN is also a number. JSON.parse can't materialise NaN directly but
    // a hand-edited state could carry a stringified path; the validator
    // must still reject any non-integer once we accept the JSON path.
    // Here we hand-craft the parsed shape via the regex injection of
    // `1.5` (a float) which passes the JSON parser and the loose check.
    const body = serializeState(makeState()).replace(
      /"iterationCount":\s*\d+/,
      '"iterationCount": 1.5',
    );
    expect(deserializeState(body)).toBeNull();
  });

  it("ES-426 #4: rejects a non-finite lastProcessedReviewId (Number.isSafeInteger guard)", () => {
    // A hand-edited state with NaN/Infinity here breaks the (id, source) dedup
    // (NaN === x is always false) so a legitimate trigger would re-process.
    const body = serializeState(makeState({ lastProcessedReviewId: 42 })).replace(
      /"lastProcessedReviewId":\s*\d+/,
      '"lastProcessedReviewId": 1e308',
    );
    expect(deserializeState(body)).toBeNull();
  });

  it("ES-426 #4: rejects a fractional lastCodexRequestCommentId (Number.isSafeInteger guard)", () => {
    const body = serializeState(
      makeState({ lastCodexRequestCommentId: 7 }),
    ).replace(/"lastCodexRequestCommentId":\s*\d+/, '"lastCodexRequestCommentId": 1.5');
    expect(deserializeState(body)).toBeNull();
  });

  it("ES-426 #4: rejects a non-finite findingsHashHistory[].iteration (Number.isSafeInteger guard)", () => {
    // A NaN/Infinity iteration breaks rollbackFixingClaim (iteration === count)
    // and loop detection.
    const body = serializeState(
      makeState({
        findingsHashHistory: [{ iteration: 1, hash: "aaaaaaaaaaaaaaaa" }],
      }),
    ).replace(/"iteration":\s*\d+/, '"iteration": 1e308');
    expect(deserializeState(body)).toBeNull();
  });

  it("ES-426 #4: still accepts valid numeric ids and iterations", () => {
    const restored = deserializeState(
      serializeState(
        makeState({
          lastProcessedReviewId: 42,
          lastCodexRequestCommentId: 7,
          findingsHashHistory: [{ iteration: 1, hash: "aaaaaaaaaaaaaaaa" }],
        }),
      ),
    );
    expect(restored).not.toBeNull();
    expect(restored!.lastProcessedReviewId).toBe(42);
    expect(restored!.lastCodexRequestCommentId).toBe(7);
    expect(restored!.findingsHashHistory[0].iteration).toBe(1);
  });

  it("rejects an oversized lastClaudeCommitSha (TY-339 #1)", () => {
    // A tampered/legacy state with a giant SHA would otherwise pass validation
    // and defeat the serializeState step-3 floor (which keeps this field).
    const body = serializeState(makeState()).replace(
      /"lastClaudeCommitSha":\s*null/,
      `"lastClaudeCommitSha": ${JSON.stringify("a".repeat(65))}`,
    );
    expect(deserializeState(body)).toBeNull();
  });

  it("accepts a full-length (64-char) lastClaudeCommitSha at the cap boundary (TY-339 #1)", () => {
    const sha = "a".repeat(64);
    const restored = deserializeState(serializeState(makeState({ lastClaudeCommitSha: sha })));
    expect(restored).not.toBeNull();
    expect(restored!.lastClaudeCommitSha).toBe(sha);
  });

  it("rejects an oversized lastFindingsHash (TY-339 #1)", () => {
    const restored = deserializeState(
      serializeState(makeState({ lastFindingsHash: "y".repeat(65) })),
    );
    expect(restored).toBeNull();
  });

  it("rejects an oversized findingsHashHistory[].hash (TY-339 #1)", () => {
    const restored = deserializeState(
      serializeState(
        makeState({ findingsHashHistory: [{ iteration: 1, hash: "x".repeat(65) }] }),
      ),
    );
    expect(restored).toBeNull();
  });

  it("rejects an oversized lastCodexReviewReceivedAt (TY-339 #1 follow-up)", () => {
    // The serializeState step-3 floor keeps this timestamp verbatim, so a
    // tampered/legacy state with a giant value would otherwise pass validation
    // and push the floor body past GitHub's 65,536-char comment-body limit.
    const restored = deserializeState(
      serializeState(makeState({ lastCodexReviewReceivedAt: "z".repeat(65) })),
    );
    expect(restored).toBeNull();
  });

  it("accepts a full-length (64-char) lastCodexReviewReceivedAt at the cap boundary (TY-339 #1 follow-up)", () => {
    const value = "z".repeat(64);
    const restored = deserializeState(
      serializeState(makeState({ lastCodexReviewReceivedAt: value })),
    );
    expect(restored).not.toBeNull();
    expect(restored!.lastCodexReviewReceivedAt).toBe(value);
  });

  it("rejects an oversized fixingStartedAt (TY-339 #1 follow-up)", () => {
    // Like lastCodexReviewReceivedAt, fixingStartedAt is kept verbatim by the
    // step-3 floor, so it must be length-bounded for the floor guarantee.
    const restored = deserializeState(
      serializeState(makeState({ status: "fixing", fixingStartedAt: "z".repeat(65) })),
    );
    expect(restored).toBeNull();
  });

  it("accepts a full-length (64-char) fixingStartedAt at the cap boundary (TY-339 #1 follow-up)", () => {
    const value = "z".repeat(64);
    const restored = deserializeState(
      serializeState(makeState({ status: "fixing", fixingStartedAt: value })),
    );
    expect(restored).not.toBeNull();
    expect(restored!.fixingStartedAt).toBe(value);
  });

  it("round-trips currentIterationFindingCommentIds (TY-360)", () => {
    const ids = [101, 202, 303];
    const restored = deserializeState(
      serializeState(
        makeState({ status: "fixing", currentIterationFindingCommentIds: ids }),
      ),
    );
    expect(restored).not.toBeNull();
    expect(restored!.currentIterationFindingCommentIds).toEqual(ids);
  });

  it("normalizes a legacy state without currentIterationFindingCommentIds to [] (TY-360)", () => {
    // Older state comments predate the field; deserialize must backfill [] so
    // post-fix can rely on it being an array (no resolve targets).
    const body = serializeState(makeState()).replace(
      /,?\n\s*"currentIterationFindingCommentIds":\s*\[\]/,
      "",
    );
    expect(body).not.toContain("currentIterationFindingCommentIds");
    const restored = deserializeState(body);
    expect(restored).not.toBeNull();
    expect(restored!.currentIterationFindingCommentIds).toEqual([]);
  });

  it("rejects an over-cap currentIterationFindingCommentIds on the read path (TY-360)", () => {
    // A forged/over-cap array must be rejected on deserialize to protect the
    // serialize floor. Inject the oversized array directly into the body so it
    // bypasses the write-path clamp in serializeState (tested separately below).
    const huge = Array.from({ length: 501 }, (_, i) => i).join(", ");
    const body = serializeState(
      makeState({ status: "fixing", currentIterationFindingCommentIds: [101] }),
    ).replace(
      /"currentIterationFindingCommentIds":\s*\[\s*101\s*\]/,
      `"currentIterationFindingCommentIds": [${huge}]`,
    );
    expect(deserializeState(body)).toBeNull();
  });

  it("clamps an over-cap currentIterationFindingCommentIds on the write path (TY-360)", () => {
    // In-memory states never pass through validateState, so serializeState must
    // clamp defensively to keep the persisted body under the floor. The result
    // must still round-trip (clamped to the cap), not produce a corrupt body.
    const huge = Array.from({ length: 501 }, (_, i) => i + 1);
    const restored = deserializeState(
      serializeState(
        makeState({ status: "fixing", currentIterationFindingCommentIds: huge }),
      ),
    );
    expect(restored).not.toBeNull();
    expect(restored!.currentIterationFindingCommentIds).toHaveLength(500);
    expect(restored!.currentIterationFindingCommentIds[0]).toBe(1);
  });

  it("accepts currentIterationFindingCommentIds at the 500-id cap boundary (TY-360)", () => {
    const atCap = Array.from({ length: 500 }, (_, i) => i + 1);
    const restored = deserializeState(
      serializeState(
        makeState({ status: "fixing", currentIterationFindingCommentIds: atCap }),
      ),
    );
    expect(restored).not.toBeNull();
    expect(restored!.currentIterationFindingCommentIds).toHaveLength(500);
  });

  it("rejects non-integer / negative entries in currentIterationFindingCommentIds (TY-360)", () => {
    for (const bad of ["-1", "1.5", '"101"', "null"]) {
      const body = serializeState(
        makeState({ status: "fixing", currentIterationFindingCommentIds: [101] }),
      ).replace(/"currentIterationFindingCommentIds":\s*\[\s*101\s*\]/, `"currentIterationFindingCommentIds": [${bad}]`);
      expect(deserializeState(body)).toBeNull();
    }
  });

  it("rejects a stopReason outside the StopReason union (TY-339 #1)", () => {
    // Symmetric with the lastProcessedTriggerSource / modelTier enum checks:
    // a forged state cannot smuggle in an arbitrary stopReason string.
    const body = serializeState(makeState({ status: "stopped" })).replace(
      /"stopReason":\s*null/,
      `"stopReason": "not_a_real_reason"`,
    );
    expect(deserializeState(body)).toBeNull();
  });

  it("accepts a valid StopReason key (TY-339 #1)", () => {
    const restored = deserializeState(
      serializeState(makeState({ status: "stopped", stopReason: "max_iterations" })),
    );
    expect(restored).not.toBeNull();
    expect(restored!.stopReason).toBe("max_iterations");
  });

  it("rejects previousCheckFailure exceeding 2x PREVIOUS_CHECK_FAILURE_MAX_CHARS (TY-275 #9)", () => {
    // Hand-edited or legacy states may carry a previousCheckFailure beyond
    // the write-time cap; if accepted, the next serializeState would push
    // past the 65,536-char GitHub comment-body limit. Reject upstream.
    const oversized = "A".repeat(50_000); // > 2 * 20_000 cap = 40_000
    const body = serializeState(makeState()).replace(
      /"previousCheckFailure":\s*null/,
      `"previousCheckFailure": ${JSON.stringify(oversized)}`,
    );
    expect(deserializeState(body)).toBeNull();
  });
});

describe("parseStateCommentRecord", () => {
  it("parses a single JSON object line emitted by gh --jq", () => {
    const body = serializeState(makeState({ status: "waiting_codex" }));
    const line = JSON.stringify({ id: 123, body, updated_at: "2026-05-09T00:00:00Z" });

    const parsed = parseStateCommentRecord(line);

    expect(parsed).toEqual({ id: 123, body, updatedAt: "2026-05-09T00:00:00Z" });
  });

  it("parses a JSON-encoded string line for compatibility", () => {
    const body = serializeState(makeState({ status: "waiting_codex" }));
    const line = JSON.stringify(JSON.stringify({ id: 456, body, updated_at: "2026-05-09T00:00:01Z" }));

    const parsed = parseStateCommentRecord(line);

    expect(parsed).toEqual({ id: 456, body, updatedAt: "2026-05-09T00:00:01Z" });
  });
});

describe("updateStateComment", () => {
  it("does not patch when the hidden comment updated_at changed before PATCH", async () => {
    const state = makeState({ status: "fixing" });
    mockExecFileOnce(JSON.stringify({
      id: 123,
      updated_at: "2026-05-09T00:00:02Z",
      body: serializeState(makeState({ status: "waiting_codex" })),
    }));

    await expect(
      updateStateComment("owner", "repo", 123, state, "token", {
        expectedUpdatedAt: "2026-05-09T00:00:01Z",
      }),
    ).rejects.toBeInstanceOf(StateUpdateConflictError);

    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    expect(mockedExecFile.mock.calls[0][1]).toContain("repos/owner/repo/issues/comments/123");
    expect(mockedExecFile.mock.calls[0][1]).not.toContain("PATCH");
  });

  it("fails immediately instead of retrying with a state derived from a stale read", async () => {
    const state = makeState({ status: "fixing", iterationCount: 1 });
    mockExecFileOnce(JSON.stringify({
      id: 123,
      updated_at: "2026-05-09T00:00:02Z",
      body: serializeState(makeState({ status: "waiting_codex", iterationCount: 2 })),
    }));

    await expect(
      updateStateComment("owner", "repo", 123, state, "token", {
        expectedUpdatedAt: "2026-05-09T00:00:01Z",
      }),
    ).rejects.toBeInstanceOf(StateUpdateConflictError);

    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    for (const call of mockedExecFile.mock.calls) {
      expect(call[1]).not.toContain("PATCH");
    }
  });

  it("converts a 412 PATCH response into StateUpdateConflictError", async () => {
    const desired = makeState({ status: "fixing" });
    mockExecFileOnce(JSON.stringify({
      id: 123,
      updated_at: "2026-05-09T00:00:01Z",
      body: serializeState(makeState({ status: "waiting_codex" })),
    }));
    mockExecFileErrorOnce({
      message: "gh: api failed",
      stderr: "HTTP 412: Precondition Failed",
      stdout: "",
    });

    await expect(
      updateStateComment("owner", "repo", 123, desired, "token", {
        expectedUpdatedAt: "2026-05-09T00:00:01Z",
      }),
    ).rejects.toBeInstanceOf(StateUpdateConflictError);
  });

  it("propagates non-conflict gh failures verbatim", async () => {
    const desired = makeState({ status: "fixing" });
    mockExecFileOnce(JSON.stringify({
      id: 123,
      updated_at: "2026-05-09T00:00:01Z",
      body: serializeState(makeState({ status: "waiting_codex" })),
    }));
    mockExecFileErrorOnce({
      message: "gh: api failed",
      stderr: "HTTP 500: server error",
      stdout: "",
    });

    await expect(
      updateStateComment("owner", "repo", 123, desired, "token", {
        expectedUpdatedAt: "2026-05-09T00:00:01Z",
      }),
    ).rejects.not.toBeInstanceOf(StateUpdateConflictError);
  });

  it("fails when the PATCH response body does not contain the expected state", async () => {
    const desired = makeState({ status: "fixing" });
    mockExecFileOnce(JSON.stringify({
      id: 123,
      updated_at: "2026-05-09T00:00:01Z",
      body: serializeState(makeState({ status: "waiting_codex" })),
    }));
    mockExecFileOnce(JSON.stringify({
      id: 123,
      updated_at: "2026-05-09T00:00:03Z",
      body: serializeState(makeState({ status: "done" })),
    }));

    await expect(
      updateStateComment("owner", "repo", 123, desired, "token", {
        expectedUpdatedAt: "2026-05-09T00:00:01Z",
      }),
    ).rejects.toThrow("PATCH response did not contain the expected hidden comment state");
  });
});

describe("createInitialState", () => {
  it("returns a ReviewState with correct initial defaults", () => {
    const state = createInitialState();

    expect(state.iterationCount).toBe(0);
    expect(state.lastProcessedReviewId).toBeNull();
    expect(state.lastProcessedTriggerSource).toBeNull();
    expect(state.lastClaudeCommitSha).toBeNull();
    expect(state.lastCodexRequestCommentId).toBeNull();
    expect(state.lastCodexReviewReceivedAt).toBeNull();
    expect(state.lastFindingsHash).toBeNull();
    expect(state.findingsHashHistory).toEqual([]);
    expect(state.status).toBe("initialized");
    expect(state.stopReason).toBeNull();
    expect(state.previousCheckFailure).toBeNull();
  });
});

describe("lastProcessedTriggerSource round-trip (TY-301 #2)", () => {
  it("includes lastProcessedTriggerSource in createInitialState (null by default)", () => {
    const state = createInitialState();
    expect(state.lastProcessedTriggerSource).toBeNull();
  });

  it("round-trips lastProcessedTriggerSource through serialize / deserialize", () => {
    for (const source of ["comment", "review"] as const) {
      const state = {
        ...createInitialState(),
        lastProcessedTriggerSource: source,
      };
      const body = serializeState(state);
      const restored = deserializeState(body);
      expect(restored?.lastProcessedTriggerSource).toBe(source);
    }
  });

  it("normalizes legacy state without lastProcessedTriggerSource to null (forward compatibility)", () => {
    // Pre-TY-301 state comments do not have the field. Restoring them must
    // surface `null` so the dedup check in pre-fix falls back to id-only
    // comparison, preserving the pre-TY-301 behaviour for in-flight PRs.
    const legacyBody = [
      "LoopPilot state is stored in this comment.",
      "",
      "<!-- looppilot-state",
      JSON.stringify(
        {
          iterationCount: 0,
          lastProcessedReviewId: 42,
          lastClaudeCommitSha: null,
          lastCodexRequestCommentId: null,
          lastCodexReviewReceivedAt: null,
          lastFindingsHash: null,
          findingsHashHistory: [],
          status: "waiting_codex",
          stopReason: null,
          previousCheckFailure: null,
          fixingStartedAt: null,
        },
        null,
        2,
      ),
      "-->",
    ].join("\n");
    const restored = deserializeState(legacyBody);
    expect(restored).not.toBeNull();
    expect(restored!.lastProcessedTriggerSource).toBeNull();
    // Existing fields must still deserialize correctly.
    expect(restored!.lastProcessedReviewId).toBe(42);
    expect(restored!.status).toBe("waiting_codex");
  });

  it("rejects state with an out-of-range lastProcessedTriggerSource so a forged value cannot smuggle in arbitrary strings", () => {
    const tamperedBody = [
      "LoopPilot state is stored in this comment.",
      "",
      "<!-- looppilot-state",
      JSON.stringify(
        {
          iterationCount: 0,
          lastProcessedReviewId: null,
          lastProcessedTriggerSource: "webhook", // not a known source
          lastClaudeCommitSha: null,
          lastCodexRequestCommentId: null,
          lastCodexReviewReceivedAt: null,
          lastFindingsHash: null,
          findingsHashHistory: [],
          status: "waiting_codex",
          stopReason: null,
          previousCheckFailure: null,
          fixingStartedAt: null,
        },
        null,
        2,
      ),
      "-->",
    ].join("\n");
    expect(deserializeState(tamperedBody)).toBeNull();
  });
});

describe("fixingStartedAt round-trip (TY-273 #B4)", () => {
  it("includes fixingStartedAt in createInitialState (null by default)", () => {
    const state = createInitialState();
    expect(state.fixingStartedAt).toBeNull();
  });

  it("round-trips fixingStartedAt through serialize / deserialize", () => {
    const state = { ...createInitialState(), fixingStartedAt: "2026-05-17T12:30:00Z" };
    const body = serializeState(state);
    const restored = deserializeState(body);
    expect(restored?.fixingStartedAt).toBe("2026-05-17T12:30:00Z");
  });

  it("normalizes legacy state without fixingStartedAt to null", () => {
    const legacyBody = [
      "LoopPilot state is stored in this comment.",
      "",
      "<!-- looppilot-state",
      JSON.stringify(
        {
          iterationCount: 0,
          lastProcessedReviewId: null,
          lastClaudeCommitSha: null,
          lastCodexRequestCommentId: null,
          lastCodexReviewReceivedAt: null,
          lastFindingsHash: null,
          findingsHashHistory: [],
          status: "waiting_codex",
          stopReason: null,
          previousCheckFailure: null,
        },
        null,
        2,
      ),
      "-->",
    ].join("\n");
    const restored = deserializeState(legacyBody);
    expect(restored?.fixingStartedAt).toBeNull();
  });
});

describe("deserializeState (forward compatibility)", () => {
  it("normalizes a state comment that predates the previousCheckFailure field", () => {
    // Hand-crafted body shaped like a pre-extension state comment to verify
    // existing PRs still deserialize cleanly after the field is added.
    const legacyBody = [
      "LoopPilot state is stored in this comment.",
      "",
      "<!-- looppilot-state",
      JSON.stringify(
        {
          iterationCount: 1,
          lastProcessedReviewId: 42,
          lastClaudeCommitSha: "abc",
          lastCodexRequestCommentId: 7,
          lastCodexReviewReceivedAt: "2026-01-01T00:00:00Z",
          lastFindingsHash: "hash1",
          findingsHashHistory: [],
          status: "waiting_codex",
          stopReason: null,
        },
        null,
        2,
      ),
      "-->",
    ].join("\n");

    const restored = deserializeState(legacyBody);
    expect(restored).not.toBeNull();
    expect(restored!.previousCheckFailure).toBeNull();
    expect(restored!.status).toBe("waiting_codex");
  });
});

describe("getTrustedStateCommentAuthors (TY-272 #A)", () => {
  it("defaults to github-actions[bot] when the env var is unset", () => {
    expect(getTrustedStateCommentAuthors({})).toEqual(["github-actions[bot]"]);
  });

  it("parses a comma-separated list, trimming whitespace and ignoring empties", () => {
    expect(
      getTrustedStateCommentAuthors({
        LOOPPILOT_STATE_COMMENT_AUTHORS: "github-actions[bot], my-app[bot], ,foo",
      }),
    ).toEqual(["github-actions[bot]", "my-app[bot]", "foo"]);
  });

  it("falls back to the default when the env var is whitespace-only or all-empty", () => {
    expect(
      getTrustedStateCommentAuthors({
        LOOPPILOT_STATE_COMMENT_AUTHORS: " , , ",
      }),
    ).toEqual(["github-actions[bot]"]);
  });
});

describe("buildTrustedAuthorJqFilter (TY-272 #A)", () => {
  it("composes an `or` chain of `.user.login == ...` clauses", () => {
    expect(buildTrustedAuthorJqFilter(["github-actions[bot]"])).toBe(
      '.user.login == "github-actions[bot]"',
    );
    expect(
      buildTrustedAuthorJqFilter(["github-actions[bot]", "my-app[bot]"]),
    ).toBe('.user.login == "github-actions[bot]" or .user.login == "my-app[bot]"');
  });

  it("rejects authors with characters outside the GitHub username spec to prevent jq injection", () => {
    // `"` / `\` / `)` / spaces / `$()` would break out of the jq string and
    // splice arbitrary filter expressions into the readState query.
    expect(buildTrustedAuthorJqFilter(['evil") | .user.login == ("attacker'])).toBe(
      "false",
    );
    expect(buildTrustedAuthorJqFilter(["bad name"])).toBe("false");
    expect(buildTrustedAuthorJqFilter(["github-actions[bot]", "bad name"])).toBe(
      '.user.login == "github-actions[bot]"',
    );
  });
});
