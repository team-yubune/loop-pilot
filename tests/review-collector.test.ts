import { describe, it, expect } from "vitest";
import {
  filterAndParseComments,
  parseReviewCommentRecord,
  shouldStabilizeReviewComments,
  stabilizeReviewComments,
  summaryMayContainFindings,
} from "../src/review-collector.js";
import type { RawReviewComment } from "../src/types.js";

const BOT_LOGIN = "openai-codex[bot]";

function makeComment(
  overrides: Partial<RawReviewComment> & { body: string }
): RawReviewComment {
  return {
    id: 1,
    user: { login: BOT_LOGIN },
    path: "src/foo.ts",
    line: 10,
    createdAt: "2024-01-10T00:00:00Z",
    inReplyToId: null,
    ...overrides,
  };
}

describe("parseReviewCommentRecord", () => {
  it("parses a single JSON object line emitted by gh --jq", () => {
    const comment = makeComment({ id: 10, body: "P1 Existing issue" });
    const line = JSON.stringify(comment);

    const parsed = parseReviewCommentRecord(line);

    expect(parsed).toEqual(comment);
  });

  it("parses a JSON-encoded string line for compatibility", () => {
    const comment = makeComment({ id: 11, body: "P1 Existing issue" });
    const line = JSON.stringify(JSON.stringify(comment));

    const parsed = parseReviewCommentRecord(line);

    expect(parsed).toEqual(comment);
  });
});

describe("filterAndParseComments", () => {
  it("ES-426 #1: matches the Codex login across a [bot]-suffix mismatch", () => {
    // REST API returns the login WITH [bot]; operator configured CODEX_BOT_LOGIN
    // WITHOUT it. Strict equality would drop every finding; botLoginMatches must
    // still match.
    const comments: RawReviewComment[] = [
      makeComment({ id: 1, body: "P1 Missing type", user: { login: "openai-codex[bot]" } }),
    ];
    const { findings } = filterAndParseComments(comments, "openai-codex", null, "P2");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("P1");
  });

  it("extracts P0, P1, and P2 findings from Codex bot comments", () => {
    const comments: RawReviewComment[] = [
      makeComment({ id: 1, body: "P0 Null dereference\n\nFix the null check." }),
      makeComment({ id: 2, body: "P1 Missing type annotation\n\nAdd return type." }),
      makeComment({ id: 3, body: "P2 Style issue\n\nPrefer a smaller helper." }),
    ];

    const { findings } = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

    expect(findings).toHaveLength(3);
    expect(findings[0].severity).toBe("P0");
    expect(findings[0].title).toBe("Null dereference");
    expect(findings[0].body).toBe("Fix the null check.");
    expect(findings[0].path).toBe("src/foo.ts");
    expect(findings[0].line).toBe(10);
    expect(findings[1].severity).toBe("P1");
    expect(findings[1].title).toBe("Missing type annotation");
    expect(findings[2].severity).toBe("P2");
    expect(findings[2].title).toBe("Style issue");
  });

  it("carries the source comment id on each finding (TY-360)", () => {
    const comments: RawReviewComment[] = [
      makeComment({ id: 7001, body: "P0 Null dereference\n\nFix the null check." }),
      makeComment({ id: 7002, body: "P1 Missing type annotation\n\nAdd return type." }),
    ];

    const { findings } = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

    // commentId == the REST databaseId so post-fix can map the finding to its
    // GraphQL review thread and resolve it after a fix.
    expect(findings.map((f) => f.commentId)).toEqual([7001, 7002]);
  });

  it("filters out comments from non-Codex bot users", () => {
    const comments: RawReviewComment[] = [
      makeComment({ id: 1, body: "P0 Critical bug", user: { login: "human-reviewer" } }),
      makeComment({ id: 2, body: "P1 Minor issue", user: { login: BOT_LOGIN } }),
    ];

    const { findings } = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("P1");
  });

  it("includes P2 findings", () => {
    const comments: RawReviewComment[] = [
      makeComment({ id: 1, body: "P0 Critical\n\nFix immediately." }),
      makeComment({ id: 2, body: "P2 Low priority\n\nCould improve later." }),
      makeComment({ id: 3, body: "P1 Important\n\nShould fix soon." }),
    ];

    const { findings } = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

    expect(findings).toHaveLength(3);
    expect(findings.map((f) => f.severity)).toEqual(["P0", "P2", "P1"]);
  });

  it("includes Codex image-badge P2 findings", () => {
    const comments: RawReviewComment[] = [
      makeComment({
        id: 1,
        body:
          "**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Reject soft restart for exhausted/looped states**\n\nThe restart can stop again immediately.\n\nUseful? React with 👍 / 👎.",
      }),
    ];

    const { findings } = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: "P2",
      title: "Reject soft restart for exhausted/looped states",
      body: "The restart can stop again immediately.",
    });
  });

  it("filters by createdAt when lastReceivedAt is provided", () => {
    const lastReceivedAt = "2024-01-10T12:00:00Z";
    const comments: RawReviewComment[] = [
      makeComment({
        id: 1,
        body: "P0 Old issue",
        createdAt: "2024-01-10T10:00:00Z", // before threshold — excluded
      }),
      makeComment({
        id: 2,
        body: "P1 New issue",
        createdAt: "2024-01-10T13:00:00Z", // after threshold — included
      }),
      makeComment({
        id: 3,
        body: "P0 Exactly at threshold",
        createdAt: "2024-01-10T12:00:00Z", // equal — excluded (must be strictly after)
      }),
    ];

    const { findings } = filterAndParseComments(comments, BOT_LOGIN, lastReceivedAt, "P2");

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("P1");
    expect(findings[0].title).toBe("New issue");
  });

  it("includes all bot comments when lastReceivedAt is null", () => {
    const comments: RawReviewComment[] = [
      makeComment({ id: 1, body: "P0 Issue one", createdAt: "2024-01-01T00:00:00Z" }),
      makeComment({ id: 2, body: "P1 Issue two", createdAt: "2020-06-15T08:30:00Z" }),
    ];

    const { findings } = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

    expect(findings).toHaveLength(2);
  });

  it("preserves null line number for file-level / outdated comments (TY-280)", () => {
    const comments: RawReviewComment[] = [
      makeComment({ id: 1, body: "P0 File-level comment", line: null }),
    ];

    const { findings } = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBeNull();
  });

  it("skips thread replies (inReplyToId !== null) to avoid double-counting findings (ES-422)", () => {
    const comments: RawReviewComment[] = [
      makeComment({ id: 1, body: "P1 Original finding", inReplyToId: null }),
      makeComment({ id: 2, body: "P1 Reply with severity badge", inReplyToId: 1 }),
    ];

    const { findings } = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

    expect(findings).toHaveLength(1);
    expect(findings[0].commentId).toBe(1);
  });

  it("reports skipped reply count (ES-422)", () => {
    const comments: RawReviewComment[] = [
      makeComment({ id: 1, body: "P0 Root finding", inReplyToId: null }),
      makeComment({ id: 2, body: "P1 Reply 1", inReplyToId: 1 }),
      makeComment({ id: 3, body: "P2 Reply 2", inReplyToId: 1 }),
    ];

    const result = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

    expect(result.findings).toHaveLength(1);
    expect(result.skipped.threadReplies).toBe(2);
  });

  // --- Threshold + skip count (TY-256) ---

  describe("severity threshold (TY-256)", () => {
    it("default threshold P2 preserves prior behavior (P0/P1/P2 in, P3 in belowThreshold)", () => {
      const comments: RawReviewComment[] = [
        makeComment({ id: 1, body: "P0 Critical\n\nFix immediately." }),
        makeComment({ id: 2, body: "P1 Important" }),
        makeComment({ id: 3, body: "P2 Style" }),
        makeComment({ id: 4, body: "P3 Cosmetic nit" }),
      ];

      const result = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

      expect(result.findings.map((f) => f.severity)).toEqual(["P0", "P1", "P2"]);
      expect(result.skipped).toEqual({ unparseable: 0, belowThreshold: 1, threadReplies: 0 });
    });

    it("threshold P3 includes everything (no belowThreshold)", () => {
      const comments: RawReviewComment[] = [
        makeComment({ id: 1, body: "P0 Critical" }),
        makeComment({ id: 2, body: "P3 Cosmetic nit" }),
      ];

      const result = filterAndParseComments(comments, BOT_LOGIN, null, "P3");

      expect(result.findings.map((f) => f.severity)).toEqual(["P0", "P3"]);
      expect(result.skipped).toEqual({ unparseable: 0, belowThreshold: 0, threadReplies: 0 });
    });

    it("threshold P1 keeps P0/P1 and counts P2/P3 in belowThreshold", () => {
      const comments: RawReviewComment[] = [
        makeComment({ id: 1, body: "P0 Critical" }),
        makeComment({ id: 2, body: "P1 Important" }),
        makeComment({ id: 3, body: "P2 Style" }),
        makeComment({ id: 4, body: "P3 Cosmetic nit" }),
      ];

      const result = filterAndParseComments(comments, BOT_LOGIN, null, "P1");

      expect(result.findings.map((f) => f.severity)).toEqual(["P0", "P1"]);
      expect(result.skipped).toEqual({ unparseable: 0, belowThreshold: 2, threadReplies: 0 });
    });

    it("threshold P0 keeps only P0 and counts everything else in belowThreshold", () => {
      const comments: RawReviewComment[] = [
        makeComment({ id: 1, body: "P0 Critical" }),
        makeComment({ id: 2, body: "P1 Important" }),
        makeComment({ id: 3, body: "P3 Cosmetic" }),
      ];

      const result = filterAndParseComments(comments, BOT_LOGIN, null, "P0");

      expect(result.findings.map((f) => f.severity)).toEqual(["P0"]);
      expect(result.skipped).toEqual({ unparseable: 0, belowThreshold: 2, threadReplies: 0 });
    });

    it("reports unparseable comments separately from belowThreshold", () => {
      const comments: RawReviewComment[] = [
        makeComment({ id: 1, body: "P0 Critical" }),
        makeComment({ id: 2, body: "No severity badge at all" }),
        makeComment({ id: 3, body: "Random text with no severity tag" }),
        makeComment({ id: 4, body: "P3 Cosmetic" }),
      ];

      const result = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

      expect(result.findings.map((f) => f.severity)).toEqual(["P0"]);
      expect(result.skipped).toEqual({ unparseable: 2, belowThreshold: 1, threadReplies: 0 });
    });

    it("excludes non-bot comments from skip counters", () => {
      const comments: RawReviewComment[] = [
        makeComment({
          id: 1,
          body: "P0 Critical",
          user: { login: "human-reviewer" },
        }),
        makeComment({ id: 2, body: "Random text", user: { login: "human-reviewer" } }),
        makeComment({ id: 3, body: "P2 Style" }),
      ];

      const result = filterAndParseComments(comments, BOT_LOGIN, null, "P2");

      expect(result.findings.map((f) => f.severity)).toEqual(["P2"]);
      expect(result.skipped).toEqual({ unparseable: 0, belowThreshold: 0, threadReplies: 0 });
    });
  });
});

describe("shouldStabilizeReviewComments", () => {
  it("starts stabilization when no bot inline comments exist and summary suggests findings", () => {
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review found P2 issues that should be fixed.",
        "P2"
      )
    ).toBe(true);
  });

  it("does not count thread replies as existing comments — enters stabilization (ES-422)", () => {
    expect(
      shouldStabilizeReviewComments(
        [makeComment({ id: 1, body: "P1 Reply with badge", inReplyToId: 999 })],
        BOT_LOGIN,
        null,
        "Codex Review found P1 issues.",
        "P2"
      )
    ).toBe(true);
  });

  it("skips stabilization when comments already exist", () => {
    expect(
      shouldStabilizeReviewComments(
        [makeComment({ id: 1, body: "P1 Existing issue" })],
        BOT_LOGIN,
        null,
        "Codex Review found P1 issues that should be fixed.",
        "P2"
      )
    ).toBe(false);
  });

  it("skips stabilization when summary says there are no findings", () => {
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review completed. No P0/P1/P2 findings.",
        "P2"
      )
    ).toBe(false);
  });

  it("skips stabilization when summary only mentions below-threshold severities", () => {
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review found P3 cosmetic nit.",
        "P2"
      )
    ).toBe(false);
  });

  it("starts stabilization when summary mentions at-threshold severity", () => {
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review found P3 cosmetic nit.",
        "P3"
      )
    ).toBe(true);
  });

  it("does NOT skip stabilization when 'No PX findings' coexists with in-scope findings in the same summary", () => {
    // Regression: "No P3 findings" matched the broad no-findings pattern and
    // returned false even when P2/P1 findings were also present in the body.
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "No P3 findings. Found 2 P2 issues.",
        "P2",
      ),
    ).toBe(true);
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "No P3 findings. Found 1 P1 issue.",
        "P2",
      ),
    ).toBe(true);
    // "No P3 findings" alone (no in-scope mention) should still skip stabilization
    // at threshold P2, because P3 is below the threshold.
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review completed. No P3 findings.",
        "P2",
      ),
    ).toBe(false);
  });

  it("skips stabilization for 'No P0/P1/P2/P3 findings' summaries at any threshold (TY-256)", () => {
    for (const threshold of ["P0", "P1", "P2", "P3"] as const) {
      expect(
        shouldStabilizeReviewComments(
          [],
          BOT_LOGIN,
          null,
          "Codex Review completed. No P0/P1/P2/P3 findings.",
          threshold,
        ),
      ).toBe(false);
    }
  });

  it("does NOT fall back to generic 'findings'/'issues' words when summary names a below-threshold severity (TY-256)", () => {
    // P3 mentioned but threshold is P2: severitySignal = false. With the
    // generic-keyword fallback gated by "no severity mentioned", we must NOT
    // enter stabilization just because the summary contains the word "issues".
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review found P3 issues only.",
        "P2",
      ),
    ).toBe(false);
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review found P3 findings.",
        "P2",
      ),
    ).toBe(false);
  });

  it("still falls back to generic keywords when no severity is named at all (TY-256)", () => {
    // No P[0-3] in body — generic "findings" / "issues" keyword is the only
    // signal we have, so stabilization must enter (conservative default).
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review found some findings that need attention.",
        "P2",
      ),
    ).toBe(true);
    expect(
      shouldStabilizeReviewComments(
        [],
        BOT_LOGIN,
        null,
        "Codex Review noted several issues.",
        "P2",
      ),
    ).toBe(true);
  });
});

describe("stabilizeReviewComments", () => {
  it("waits until comment count increases and then stabilizes", async () => {
    const first = [] as RawReviewComment[];
    const second = [makeComment({ id: 2, body: "P1 New issue" })];
    const fetches = [second, second, second];
    const sleepCalls: number[] = [];

    const result = await stabilizeReviewComments(first, {
      botLogin: BOT_LOGIN,
      lastReceivedAt: null,
      triggerSummaryBody: "Codex Review found P1 issues.",
      severityThreshold: "P2",
      intervalMs: 10,
      stablePolls: 2,
      maxWaitMs: 100,
      fetchComments: async () => fetches.shift() ?? second,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    expect(result).toEqual(second);
    expect(sleepCalls).toEqual([10, 10, 10]);
  });

  it("returns zero comments after zero count is stable", async () => {
    const sleepCalls: number[] = [];

    const result = await stabilizeReviewComments([], {
      botLogin: BOT_LOGIN,
      lastReceivedAt: null,
      triggerSummaryBody: "Codex Review found P1 issues.",
      severityThreshold: "P2",
      intervalMs: 5,
      stablePolls: 2,
      maxWaitMs: 100,
      fetchComments: async () => [],
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    expect(result).toEqual([]);
    expect(sleepCalls).toEqual([5, 5]);
  });

  it("does not poll when stabilization is not needed", async () => {
    let fetchCount = 0;
    const initial = [makeComment({ id: 1, body: "P1 Existing issue" })];

    const result = await stabilizeReviewComments(initial, {
      botLogin: BOT_LOGIN,
      lastReceivedAt: null,
      triggerSummaryBody: "Codex Review found P1 issues.",
      severityThreshold: "P2",
      intervalMs: 5,
      stablePolls: 2,
      maxWaitMs: 100,
      fetchComments: async () => {
        fetchCount += 1;
        return [];
      },
      sleep: async () => {},
    });

    expect(result).toEqual(initial);
    expect(fetchCount).toBe(0);
  });

  it("forceStabilize: polls even when summary signals no findings (Finding 2 safety net)", async () => {
    const arrived = [makeComment({ id: 5, body: "P2 Late comment" })];
    const fetches = [arrived, arrived];
    const sleepCalls: number[] = [];

    const result = await stabilizeReviewComments([], {
      botLogin: BOT_LOGIN,
      lastReceivedAt: null,
      triggerSummaryBody: "Didn't find any major issues.",
      severityThreshold: "P3",
      intervalMs: 5,
      stablePolls: 2,
      maxWaitMs: 100,
      fetchComments: async () => fetches.shift() ?? arrived,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      forceStabilize: true,
    });

    expect(result).toEqual(arrived);
    expect(sleepCalls.length).toBeGreaterThan(0);
  });

  it("forceStabilize: keeps polling when initial comments already exist (Finding 2)", async () => {
    // Codex sometimes posts the first inline comment quickly and additional
    // findings seconds later. If the first fetch is truncated, late findings
    // are lost. With forceStabilize on, stabilization must continue until the
    // count actually stabilizes instead of short-circuiting on the first
    // non-zero batch.
    let fetchCount = 0;
    const initial = [makeComment({ id: 1, body: "P2 First comment" })];
    const arrived = [
      makeComment({ id: 1, body: "P2 First comment" }),
      makeComment({ id: 2, body: "P2 Late arriving comment" }),
    ];

    const result = await stabilizeReviewComments(initial, {
      botLogin: BOT_LOGIN,
      lastReceivedAt: null,
      triggerSummaryBody: "Didn't find any major issues.",
      severityThreshold: "P3",
      intervalMs: 5,
      stablePolls: 2,
      maxWaitMs: 100,
      fetchComments: async () => {
        fetchCount += 1;
        return arrived;
      },
      sleep: async () => {},
      forceStabilize: true,
    });

    expect(result).toEqual(arrived);
    expect(fetchCount).toBeGreaterThan(0);
  });

  it("forceStabilize: keeps polling for full maxWaitMs when count stays at zero (Finding 1)", async () => {
    // The original (un-skipped) flow always waited `debounceSeconds` (90s) before
    // fetching. The debounce-skip path replaces that with stabilization polling,
    // so the polling must observe for at least the full debounce window before
    // concluding no comments arrived — otherwise a false negative on the
    // no-findings summary can mark done after only ~stablePolls * intervalMs.
    let fetchCount = 0;
    const sleepCalls: number[] = [];

    const result = await stabilizeReviewComments([], {
      botLogin: BOT_LOGIN,
      lastReceivedAt: null,
      triggerSummaryBody: "Didn't find any major issues.",
      severityThreshold: "P3",
      intervalMs: 5,
      stablePolls: 2,
      maxWaitMs: 100,
      fetchComments: async () => {
        fetchCount += 1;
        return [];
      },
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      forceStabilize: true,
    });

    expect(result).toEqual([]);
    // Without the Finding 1 fix, the loop would have exited after stablePolls (2)
    // iterations at ~10ms. With the fix it polls for the full 100ms window.
    expect(sleepCalls.length).toBe(20);
    expect(fetchCount).toBe(20);
  });
});

describe("summaryMayContainFindings (TY-294)", () => {
  it("returns false for Codex's current `Didn't find any major issues` reply", () => {
    expect(
      summaryMayContainFindings(
        "Codex Review: Didn't find any major issues. Another round soon, please!",
        "P2",
      ),
    ).toBe(false);
  });

  it("returns false for the contracted form without an apostrophe (`didnt find`)", () => {
    expect(
      summaryMayContainFindings(
        "Codex Review: didnt find any major issues",
        "P2",
      ),
    ).toBe(false);
  });

  it("returns false for `No major issues found.` defensive variant", () => {
    expect(
      summaryMayContainFindings("Codex Review: No major issues found.", "P2"),
    ).toBe(false);
  });

  it("returns true when the summary actually lists findings (regression guard)", () => {
    expect(
      summaryMayContainFindings(
        "Codex Review: 3 P1 findings in src/foo.ts",
        "P2",
      ),
    ).toBe(true);
  });

  // Regression: Codex's standard review summary names no severity and uses
  // "suggestions" rather than "findings"/"issues". It must still be treated as
  // possibly-findings so the debounce is NOT skipped on the primary
  // pull_request_review trigger (the generic fallback previously omitted
  // "suggestions" and returned false).
  it("returns true for Codex's standard `automated review suggestions` summary", () => {
    expect(
      summaryMayContainFindings(
        "💡 Codex Review\n\nHere are some automated review suggestions for this pull request.",
        "P3",
      ),
    ).toBe(true);
  });

  it("still respects existing `no findings` / `no issues` keywords", () => {
    expect(summaryMayContainFindings("No findings", "P2")).toBe(false);
    expect(summaryMayContainFindings("No issues", "P2")).toBe(false);
    expect(summaryMayContainFindings("指摘なし", "P2")).toBe(false);
  });

  it("returns true when `no major issues` but explicit in-scope P3 findings exist (threshold P3)", () => {
    expect(
      summaryMayContainFindings(
        "Didn't find any major issues, but found 2 P3 findings",
        "P3",
      ),
    ).toBe(true);
  });

  it("returns false when `no major issues` and P3 findings are below threshold (threshold P2)", () => {
    expect(
      summaryMayContainFindings(
        "Didn't find any major issues, but found 2 P3 findings",
        "P2",
      ),
    ).toBe(false);
  });

  it("returns true when `no major issues found` but explicit in-scope P3 findings exist (threshold P3)", () => {
    expect(
      summaryMayContainFindings(
        "No major issues found, but there are 3 P3 findings",
        "P3",
      ),
    ).toBe(true);
  });

  // Finding 1: noFindingsPatterns must check residual text for inline-comment hints
  it("returns true when `didn't find any issues` is qualified by trailing suggestions language (Finding 1)", () => {
    expect(
      summaryMayContainFindings(
        "Didn't find any issues blocking merge, but I left suggestions inline",
        "P2",
      ),
    ).toBe(true);
  });

  // TY-294: "no major issues" IS a no-findings signal at the default P3
  // threshold when there is no residual findings/comments language. The
  // debounce skip must activate in the default configuration.
  it("returns false for plain `Didn't find any major issues` even when threshold is P3", () => {
    expect(
      summaryMayContainFindings(
        "Didn't find any major issues.",
        "P3",
      ),
    ).toBe(false);
  });

  // Finding 3: residual check for noMajorIssuesPatterns must include suggestions keyword
  it("returns true when `no major issues` is followed by suggestions language (Finding 3)", () => {
    expect(
      summaryMayContainFindings(
        "Didn't find any major issues, but left a few minor suggestions below.",
        "P2",
      ),
    ).toBe(true);
  });

  it("returns true when `no major issues` is followed by `comments inline` language", () => {
    expect(
      summaryMayContainFindings(
        "Didn't find any major issues, but I left comments inline.",
        "P2",
      ),
    ).toBe(true);
  });

  it("returns true when `no major issues` is followed by `comments inline` language at threshold P3", () => {
    expect(
      summaryMayContainFindings(
        "Didn't find any major issues, but I left comments inline.",
        "P3",
      ),
    ).toBe(true);
  });

  it("returns true when `didn't find any issues` is qualified by trailing `comments` language", () => {
    expect(
      summaryMayContainFindings(
        "Didn't find any issues blocking merge, but I left a comment inline.",
        "P2",
      ),
    ).toBe(true);
  });

  // Finding 3: typographic (U+2019) apostrophe must be recognized so the
  // debounce skip still activates on summaries that get auto-typographed.
  it("returns false for typographic apostrophe in `didn’t find any major issues` (Finding 3)", () => {
    expect(
      summaryMayContainFindings(
        "Codex Review: Didn’t find any major issues. Another round soon, please!",
        "P2",
      ),
    ).toBe(false);
  });

  it("returns false for typographic apostrophe in `didn’t find any issues` (Finding 3)", () => {
    expect(
      summaryMayContainFindings(
        "Codex Review: Didn’t find any issues",
        "P2",
      ),
    ).toBe(false);
  });
});
