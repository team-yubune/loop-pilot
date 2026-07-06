import { describe, expect, it } from "vitest";
import {
  mergeIfChecksPass,
  type AutoMergeSkipKind,
  type MergerDeps,
  type WorkflowRunSummary,
} from "../src/pr-merger.js";

function captureLog() {
  const calls: { level: "info" | "warning"; message: string }[] = [];
  return {
    log: {
      info: (message: string) => calls.push({ level: "info", message }),
      warning: (message: string) => calls.push({ level: "warning", message }),
    },
    calls,
  };
}

// Stable mapping from workflow display name to a numeric workflow_id so that
// same-named workflows in tests get the same id without requiring callers to
// pass it explicitly.  Tests that need two distinct workflows with the same
// display name can pass an explicit workflowId override.
const _nameToWfId = new Map<string, number>();
let _nextWfId = 1;

function run(
  id: number,
  name: string,
  status: WorkflowRunSummary["status"],
  conclusion: WorkflowRunSummary["conclusion"],
  headSha = "abc123",
  workflowId?: number,
  event = "push",
): WorkflowRunSummary {
  if (workflowId === undefined) {
    if (!_nameToWfId.has(name)) _nameToWfId.set(name, _nextWfId++);
    workflowId = _nameToWfId.get(name)!;
  }
  return { id, workflow_id: workflowId, name, status, conclusion, head_sha: headSha, event };
}

interface FakeDeps {
  getPrHeadShaCalls: number;
  listCalls: number;
  mergeCalls: number;
  /** sha passed to each mergeSquash call (in order). */
  mergeShas: string[];
  sleepCalls: number[];
  deps: Partial<MergerDeps>;
}

function makeDeps(opts: {
  headShas?: string[];
  workflowRunPages: WorkflowRunSummary[][];
  mergeShouldFail?: boolean;
  selfRunId?: string;
  selfWorkflowName?: string;
  selfWorkflowPath?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Increment per poll loop iteration. */
  clockTickMs?: number;
}): FakeDeps {
  const headShas = opts.headShas ?? ["abc123"];
  let headIdx = 0;
  let runsIdx = 0;
  const record: FakeDeps = {
    getPrHeadShaCalls: 0,
    listCalls: 0,
    mergeCalls: 0,
    mergeShas: [],
    sleepCalls: [],
    deps: {},
  };
  let clock = 0;
  record.deps = {
    getPrHeadSha: async () => {
      record.getPrHeadShaCalls += 1;
      const sha = headShas[Math.min(headIdx, headShas.length - 1)];
      headIdx += 1;
      return sha;
    },
    // Omit getPrMergeSha so we only query by head sha; prevents a second
    // listWorkflowRuns call per poll that would skew listCalls counts and
    // duplicate test run pages. Tests that need merge-sha behaviour must
    // supply getPrMergeSha explicitly in opts (not yet supported by this
    // factory — pass it via mergeIfChecksPass overrides directly).
    getPrMergeSha: undefined,
    listWorkflowRuns: async () => {
      record.listCalls += 1;
      const page = opts.workflowRunPages[Math.min(runsIdx, opts.workflowRunPages.length - 1)];
      runsIdx += 1;
      return page;
    },
    listCheckRuns: async () => [],
    mergeSquash: async (_o, _n, _pr, sha) => {
      record.mergeCalls += 1;
      record.mergeShas.push(sha);
      if (opts.mergeShouldFail) {
        throw new Error("not mergeable");
      }
    },
    sleep: async (ms: number) => {
      record.sleepCalls.push(ms);
      clock += opts.clockTickMs ?? ms;
    },
    now: () => clock,
    selfRunId: opts.selfRunId ?? "",
    selfWorkflowName: opts.selfWorkflowName ?? "",
    selfWorkflowPath: opts.selfWorkflowPath ?? "",
    pollIntervalMs: opts.pollIntervalMs ?? 100,
    timeoutMs: opts.timeoutMs ?? 60_000,
  };
  return record;
}

describe("mergeIfChecksPass — green path", () => {
  it("merges when all workflow runs are completed/success", async () => {
    const fake = makeDeps({
      workflowRunPages: [[run(1, "ci", "completed", "success")]],
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
    // Codex P1: mergeSquash must receive the verified HEAD sha so the
    // downstream `gh pr merge --match-head-commit` can refuse a race-win
    // push that landed after the last polling read.
    expect(fake.mergeShas).toEqual(["abc123"]);
    expect(fake.sleepCalls).toEqual([]);
    expect(calls.some((c) => c.level === "info" && c.message.includes("succeeded"))).toBe(true);
  });

  it("treats neutral / skipped conclusions as success", async () => {
    const fake = makeDeps({
      workflowRunPages: [[
        run(1, "ci", "completed", "success"),
        run(2, "neutral-job", "completed", "neutral"),
        run(3, "skipped-job", "completed", "skipped"),
      ]],
    });
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
  });

  it("excludes the loop's own workflow run (GITHUB_RUN_ID) from the wait", async () => {
    // Without self-exclusion the loop would block waiting for the run it
    // is currently inside, which can never complete.
    const fake = makeDeps({
      workflowRunPages: [[
        run(999, "loop-pilot", "in_progress", null), // self
        run(1, "ci", "completed", "success"),
      ]],
      selfRunId: "999",
    });
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
  });
});

describe("mergeIfChecksPass — superseded runs (P1)", () => {
  it("ignores an older failed run when a later re-run of the same workflow succeeded", async () => {
    // GitHub returns all historical runs for a SHA. A workflow re-triggered
    // after a transient failure produces a new run (higher id) with a success
    // conclusion while the old failed run remains in the list. Only the latest
    // run per workflow should be evaluated.
    const fake = makeDeps({
      workflowRunPages: [[
        run(1, "ci", "completed", "failure"),   // older, superseded
        run(2, "ci", "completed", "success"),   // newer re-run
      ]],
    });
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
  });

  it("treats the latest run as failed even when an older run for the same workflow succeeded", async () => {
    const fake = makeDeps({
      workflowRunPages: [[
        run(1, "ci", "completed", "success"),   // older successful run
        run(2, "ci", "completed", "failure"),   // newer run (now failing)
      ]],
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(0);
    expect(calls.find((c) => c.level === "warning")?.message).toContain("failure");
  });
});

describe("mergeIfChecksPass — workflow_id deduplication", () => {
  it("treats two distinct workflow files with the same display name as independent runs", async () => {
    // Two different .yml files can share the same `name:` field.  With name-
    // based deduplication one would silently overwrite the other, potentially
    // dropping a failing run and allowing the merge to proceed.  Using
    // workflow_id (stable per file) ensures both are evaluated independently.
    const fake = makeDeps({
      workflowRunPages: [[
        run(1, "CI", "completed", "failure", "abc123", 101),  // workflow file A: failing
        run(2, "CI", "completed", "success", "abc123", 102),  // workflow file B: succeeding
      ]],
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(0);
    expect(calls.find((c) => c.level === "warning")?.message).toContain("failure");
  });
});

describe("mergeIfChecksPass — concurrent event triggers (P1)", () => {
  it("blocks merge when same workflow fails for one trigger event even if it succeeds for another", async () => {
    // Same workflow file can be triggered by multiple events (e.g. push and
    // pull_request) simultaneously for the same head_sha. Deduplicating only
    // by workflow_id would keep just the run with the higher id (success) and
    // silently drop the push-triggered failure, making this gate fail-open.
    // Deduplicating by (workflow_id, event) evaluates each trigger independently.
    const fake = makeDeps({
      workflowRunPages: [[
        run(1, "CI", "completed", "failure", "abc123", 10, "push"),
        run(2, "CI", "completed", "success", "abc123", 10, "pull_request"),
      ]],
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(0);
    expect(calls.find((c) => c.level === "warning")?.message).toContain("failure");
  });

  it("allows merge when a re-run of the same workflow and event succeeds after an earlier failure", async () => {
    // A manual re-run produces a new run (higher id) with the same event type.
    // The old failed run should be superseded by the newer successful re-run.
    const fake = makeDeps({
      workflowRunPages: [[
        run(1, "CI", "completed", "failure", "abc123", 10, "push"),  // superseded
        run(2, "CI", "completed", "success", "abc123", 10, "push"),  // re-run success
      ]],
    });
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
  });
});

describe("mergeIfChecksPass — failure path", () => {
  it("refuses to merge when any non-self run has a failure conclusion", async () => {
    const fake = makeDeps({
      workflowRunPages: [[
        run(1, "ci", "completed", "success"),
        run(2, "build", "completed", "failure"),
      ]],
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(0);
    const warning = calls.find((c) => c.level === "warning");
    expect(warning?.message).toContain("Skipping auto-merge");
    expect(warning?.message).toContain("build (failure)");
  });

  it.each([
    ["cancelled"],
    ["timed_out"],
    ["action_required"],
    ["startup_failure"],
    ["stale"],
  ])("treats %s as a failure", async (conclusion) => {
    const fake = makeDeps({
      workflowRunPages: [[run(1, "ci", "completed", conclusion)]],
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(0);
    expect(
      calls.find((c) => c.level === "warning")?.message,
    ).toContain(conclusion);
  });
});

describe("mergeIfChecksPass — polling path", () => {
  it("polls until a pending run completes successfully, then merges", async () => {
    const fake = makeDeps({
      workflowRunPages: [
        [run(1, "ci", "in_progress", null)],
        [run(1, "ci", "in_progress", null)],
        [run(1, "ci", "completed", "success")],
      ],
      pollIntervalMs: 100,
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.listCalls).toBe(3);
    expect(fake.sleepCalls).toEqual([100, 100]);
    expect(fake.mergeCalls).toBe(1);
    expect(calls.some((c) => c.message.includes("Waiting for"))).toBe(true);
  });

  it("polls until a pending run completes with failure, then skips", async () => {
    const fake = makeDeps({
      workflowRunPages: [
        [run(1, "ci", "in_progress", null)],
        [run(1, "ci", "completed", "failure")],
      ],
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(0);
    expect(
      calls.find((c) => c.level === "warning")?.message,
    ).toContain("failure");
  });

  it("skips with a timeout warning when CI exceeds timeoutMs", async () => {
    // 100ms poll interval, clock advances 100ms per sleep, 250ms budget →
    // after 3 polls (200ms wall time) the next failure check triggers timeout.
    const fake = makeDeps({
      workflowRunPages: [[run(1, "ci", "in_progress", null)]],
      pollIntervalMs: 100,
      timeoutMs: 250,
      clockTickMs: 100,
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(0);
    const warning = calls.find((c) => c.level === "warning");
    expect(warning?.message).toMatch(/timed out after/);
  });

  it("TY-330: merges when CI completes green on the same poll the timeout elapses", async () => {
    // pollIntervalMs=100, clockTickMs=100, timeoutMs=100. Poll 1 sees CI
    // pending (elapsed 0 < timeout) and sleeps; poll 2 sees CI completed/green
    // but elapsed (100) has reached the timeout. The merge gate must win over
    // the timeout gate so a clean PR whose CI finishes in the final poll window
    // is still auto-merged, instead of being skipped with a misleading
    // "timed out — 0 pending" notification.
    const skips: AutoMergeSkipKind[] = [];
    const fake = makeDeps({
      workflowRunPages: [
        [run(1, "ci", "in_progress", null)],
        [run(1, "ci", "completed", "success")],
      ],
      pollIntervalMs: 100,
      timeoutMs: 100,
      clockTickMs: 100,
    });
    fake.deps.postSkipNotification = async (kind) => {
      skips.push(kind);
    };
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
    expect(fake.mergeShas).toEqual(["abc123"]);
    expect(skips.find((k) => k.kind === "timeout_pending")).toBeUndefined();
  });

  it("aborts when PR HEAD sha changes during polling", async () => {
    const fake = makeDeps({
      headShas: ["abc123", "def456"],
      workflowRunPages: [
        [run(1, "ci", "in_progress", null)],
        [run(1, "ci", "completed", "success")],
      ],
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(0);
    const warning = calls.find((c) => c.level === "warning");
    expect(warning?.message).toContain("HEAD changed");
    expect(warning?.message).toContain("abc123");
    expect(warning?.message).toContain("def456");
  });
});

describe("mergeIfChecksPass — error handling", () => {
  it("skips with a warning when the initial HEAD sha read fails", async () => {
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => {
        throw new Error("network down");
      },
      listWorkflowRuns: async () => [],
      listCheckRuns: async () => [],
      mergeSquash: async (_o, _n, _pr, _sha) => {},
      sleep: async () => {},
      now: () => 0,
      selfRunId: "",
      selfWorkflowName: "",
      pollIntervalMs: 100,
      timeoutMs: 1000,
    });

    expect(calls.find((c) => c.level === "warning")?.message).toContain(
      "failed to read PR HEAD sha",
    );
  });

  it("skips with a warning when listWorkflowRuns fails", async () => {
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => "abc123",
      listWorkflowRuns: async () => {
        throw new Error("rate limit");
      },
      listCheckRuns: async () => [],
      mergeSquash: async (_o, _n, _pr, _sha) => {},
      sleep: async () => {},
      now: () => 0,
      selfRunId: "",
      selfWorkflowName: "",
      pollIntervalMs: 100,
      timeoutMs: 1000,
    });

    expect(calls.find((c) => c.level === "warning")?.message).toContain(
      "failed to list workflow runs",
    );
  });

  it("warns (non-fatal) when mergeSquash itself fails", async () => {
    const fake = makeDeps({
      workflowRunPages: [[run(1, "ci", "completed", "success")]],
      mergeShouldFail: true,
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
    const warning = calls.find((c) => c.level === "warning");
    expect(warning?.message).toMatch(/Failed to merge PR #42 \(non-fatal\)/);
  });

  it("skips when initial HEAD sha is empty", async () => {
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => "",
      listWorkflowRuns: async () => [],
      listCheckRuns: async () => [],
      mergeSquash: async (_o, _n, _pr, _sha) => {},
      sleep: async () => {},
      now: () => 0,
      selfRunId: "",
      selfWorkflowName: "",
      pollIntervalMs: 100,
      timeoutMs: 1000,
    });

    expect(calls.find((c) => c.level === "warning")?.message).toContain(
      "empty HEAD sha",
    );
  });
});

describe("mergeIfChecksPass — no other runs", () => {
  it("polls until a non-self CI run appears, then merges", async () => {
    // Guard against the race where this workflow checks CI status before
    // other workflows for the same HEAD have been created in the Actions API.
    const fake = makeDeps({
      workflowRunPages: [
        // First poll: only the self run is visible.
        [run(999, "loop-pilot", "in_progress", null)],
        // Second poll: a non-self CI run appears and has completed.
        [run(999, "loop-pilot", "in_progress", null), run(1, "ci", "completed", "success")],
      ],
      selfRunId: "999",
      pollIntervalMs: 100,
    });
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
    expect(fake.sleepCalls.length).toBe(1);
  });

  it("#C: noCiConfiguredDelayMs:0 preserves the immediate no-CI merge (TY-308)", async () => {
    // Regression guard for the pre-TY-308 "no CI configured → merge" path.
    // Disabling the delay (0 ms) makes the absence of non-self runs merge on
    // the first poll, exactly as the previous pollCount-based shortcut did once
    // its threshold was met — confirming the new gate is opt-out and otherwise
    // behaviour-preserving.
    const fake = makeDeps({
      workflowRunPages: [[run(999, "loop-pilot", "in_progress", null)]],
      selfRunId: "999",
      pollIntervalMs: 100,
    });
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      ...fake.deps,
      noCiConfiguredDelayMs: 0,
    });

    expect(fake.mergeCalls).toBe(1);
    expect(fake.sleepCalls.length).toBe(0);
  });

  it("TY-328: a no-CI repo whose timeout equals the no-CI delay merges at the timeout instead of skipping forever", async () => {
    // pollIntervalMs=40s, timeoutMs=60s, default noCiConfiguredDelayMs=60s. No
    // non-self run ever appears. Pre-TY-328 the timeout gate fired first (at
    // the same instant the 60s no-CI merge gate would have), so the merge gate
    // was never reached and auto-merge skipped forever. Now "waited the full
    // budget, still zero non-self runs (and the merge sha is resolved)" merges,
    // treating the repo as having no CI configured.
    const fake = makeDeps({
      workflowRunPages: [[run(999, "loop-pilot", "in_progress", null)]],
      selfRunId: "999",
      pollIntervalMs: 40_000,
      timeoutMs: 60_000,
      clockTickMs: 40_000,
    });
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
  });
});

describe("mergeIfChecksPass — external CI check runs (ES-426 #2)", () => {
  const extCheck = (
    conclusion: string | null,
    status = "completed",
    appSlug = "circleci",
    name = "ci/circleci",
  ) => ({ name, status, conclusion, appSlug });

  it("skips auto-merge when an external (non-github-actions) check run failed", async () => {
    const fake = makeDeps({ workflowRunPages: [[]] });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      ...fake.deps,
      listCheckRuns: async () => [extCheck("failure")],
    });

    expect(fake.mergeCalls).toBe(0);
    expect(calls.find((c) => c.level === "warning")?.message).toContain(
      "failed",
    );
  });

  it("merges when the only CI signal is a green external check", async () => {
    const fake = makeDeps({ workflowRunPages: [[]] });
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      ...fake.deps,
      noCiConfiguredDelayMs: 0,
      listCheckRuns: async () => [extCheck("success")],
    });

    // hasCi is true (an external check exists) and it is complete + green.
    expect(fake.mergeCalls).toBe(1);
  });

  it("ignores github-actions check runs (the loop's own in-progress job must not self-block)", async () => {
    const fake = makeDeps({ workflowRunPages: [[]] });
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      ...fake.deps,
      noCiConfiguredDelayMs: 0,
      // A still-running github-actions check would block forever if counted;
      // it must be filtered (covered by the self-excluded workflow-runs path).
      listCheckRuns: async () => [
        extCheck(null, "in_progress", "github-actions", "loop / loop"),
      ],
    });

    // Treated as no CI configured → merges after the (zeroed) no-CI delay.
    expect(fake.mergeCalls).toBe(1);
  });

  it("does not merge while an external check is still pending (times out instead)", async () => {
    const fake = makeDeps({
      workflowRunPages: [[]],
      pollIntervalMs: 100,
      timeoutMs: 250,
      clockTickMs: 100,
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      ...fake.deps,
      listCheckRuns: async () => [extCheck(null, "in_progress")],
    });

    expect(fake.mergeCalls).toBe(0);
    expect(calls.find((c) => c.level === "warning")?.message).toContain(
      "pending",
    );
  });

  it("keeps the more-blocking entry when the same check differs across head and merge refs (rankCheck)", async () => {
    // Same external check: green on the head sha, still pending on the merge
    // ref. The green head entry must NOT mask the pending merge-ref entry, so
    // the PR does not merge (it times out waiting).
    const fake = makeDeps({
      workflowRunPages: [[]],
      pollIntervalMs: 100,
      timeoutMs: 250,
      clockTickMs: 100,
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      ...fake.deps,
      getPrMergeSha: async () => "merge456",
      listCheckRuns: async (_o, _n, sha) =>
        sha === "merge456"
          ? [extCheck(null, "in_progress")]
          : [extCheck("success")],
    });

    expect(fake.mergeCalls).toBe(0);
    expect(calls.find((c) => c.level === "warning")?.message).toContain(
      "pending",
    );
  });

  it("skips (fail-closed) when the check-runs lookup throws", async () => {
    const fake = makeDeps({ workflowRunPages: [[run(1, "ci", "completed", "success")]] });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      ...fake.deps,
      listCheckRuns: async () => {
        throw new Error("checks api down");
      },
    });

    expect(fake.mergeCalls).toBe(0);
    expect(calls.find((c) => c.level === "warning")?.message).toContain(
      "check runs",
    );
  });
});

describe("mergeIfChecksPass — no-CI delay (TY-308)", () => {
  it("#A (TY-328): a CI-less repo whose timeout is below the no-CI delay merges at the timeout, not never", async () => {
    // timeoutMs=55s, noCiConfiguredDelayMs=60s: the no-CI fast-path merge gate
    // (>= 60s) is unreachable because the timeout fires first. Pre-TY-328 this
    // skipped auto-merge on every clean PR forever; now the no-CI timeout
    // branch merges (the operator's short timeout opts into the shorter
    // CI-registration window).
    const clock = { t: 0 };
    let mergeCalls = 0;
    const mergeShas: string[] = [];
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => "abc123",
      getPrMergeSha: undefined,
      listWorkflowRuns: async () => [run(999, "loop-pilot", "in_progress", null)],
      listCheckRuns: async () => [],
      mergeSquash: async (_o, _n, _pr, sha) => { mergeCalls += 1; mergeShas.push(sha); },
      sleep: async () => { clock.t += 10_000; },
      now: () => clock.t,
      selfRunId: "999",
      selfWorkflowName: "",
      pollIntervalMs: 10_000,
      timeoutMs: 55_000,
      noCiConfiguredDelayMs: 60_000,
    });

    expect(mergeCalls).toBe(1);
    expect(mergeShas).toEqual(["abc123"]);
  });

  it("#B: merges once elapsed reaches noCiConfiguredDelayMs with no non-self runs", async () => {
    const clock = { t: 0 };
    let mergeCalls = 0;
    const mergeShas: string[] = [];
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => "abc123",
      getPrMergeSha: undefined,
      listWorkflowRuns: async () => [run(999, "loop-pilot", "in_progress", null)],
      listCheckRuns: async () => [],
      mergeSquash: async (_o, _n, _pr, sha) => { mergeCalls += 1; mergeShas.push(sha); },
      sleep: async () => { clock.t += 60_000; },
      now: () => clock.t,
      selfRunId: "999",
      selfWorkflowName: "",
      pollIntervalMs: 15_000,
      timeoutMs: 600_000,
      noCiConfiguredDelayMs: 60_000,
    });

    expect(mergeCalls).toBe(1);
    expect(mergeShas).toEqual(["abc123"]);
  });

  it("#D: merges immediately when a completed non-self run is present, regardless of delay", async () => {
    const clock = { t: 0 };
    let mergeCalls = 0;
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => "abc123",
      getPrMergeSha: undefined,
      listWorkflowRuns: async () => [run(1, "ci", "completed", "success")],
      listCheckRuns: async () => [],
      mergeSquash: async () => { mergeCalls += 1; },
      sleep: async () => { clock.t += 1000; },
      now: () => clock.t,
      selfRunId: "",
      selfWorkflowName: "",
      pollIntervalMs: 100,
      timeoutMs: 600_000,
      noCiConfiguredDelayMs: 60_000,
    });

    expect(mergeCalls).toBe(1);
  });

  it("#E: never merges while merge sha is unresolved, even after the delay elapses", async () => {
    // mergeShaLookupNull guard (TY-277) must dominate the new delay: GitHub is
    // still computing the merge ref, so CI that only runs on the merge ref has
    // not appeared yet. Crossing the 60s delay must not merge.
    const clock = { t: 0 };
    let mergeCalls = 0;
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => "abc123",
      getPrMergeSha: async () => null,
      listWorkflowRuns: async () => [],
      listCheckRuns: async () => [],
      mergeSquash: async () => { mergeCalls += 1; },
      sleep: async () => { clock.t += 30_000; },
      now: () => clock.t,
      selfRunId: "",
      selfWorkflowName: "",
      pollIntervalMs: 15_000,
      timeoutMs: 90_000,
      noCiConfiguredDelayMs: 60_000,
    });

    expect(mergeCalls).toBe(0);
    expect(calls.find((c) => c.level === "warning")?.message).toMatch(/timed out after/);
  });
});

describe("mergeIfChecksPass — getPrMergeSha error handling (Finding 1)", () => {
  it("skips with a warning when getPrMergeSha throws (fail-closed)", async () => {
    // A transient API failure for the merge-sha lookup must abort rather than
    // silently continue with head-sha runs only: on repos whose CI runs against
    // the merge ref, proceeding without the merge sha would leave others empty
    // and the two-empty-polls path could merge without ever validating CI.
    const { log, calls } = captureLog();
    let listCalls = 0;

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => "abc123",
      getPrMergeSha: async () => { throw new Error("rate-limit"); },
      listWorkflowRuns: async () => { listCalls += 1; return [run(1, "ci", "completed", "success")]; },
      listCheckRuns: async () => [],
      mergeSquash: async (_o, _n, _pr, _sha) => {},
      sleep: async () => {},
      now: () => 0,
      selfRunId: "",
      selfWorkflowName: "",
      pollIntervalMs: 100,
      timeoutMs: 1000,
    });

    expect(listCalls).toBe(1);
    expect(calls.find((c) => c.level === "warning")?.message).toContain(
      "failed to read PR merge commit sha",
    );
  });
});

describe("mergeIfChecksPass — merge sha pending (Finding 2)", () => {
  it("does not apply two-poll shortcut while getPrMergeSha returns null", async () => {
    // GitHub can return null for merge_commit_sha while it computes the merge
    // ref in the background. Repos that run CI only on pull_request (merge
    // ref) produce zero runs under the head sha during this window. The
    // two-empty-polls shortcut must not fire while the merge sha is null.
    let mergeShaCallCount = 0;
    let listCalls = 0;
    let mergeCalls = 0;
    const clock = { t: 0 };

    await mergeIfChecksPass("o", "r", 42, "tok", { info: () => {}, warning: () => {} }, {
      getPrHeadSha: async () => "abc123",
      getPrMergeSha: async () => {
        mergeShaCallCount += 1;
        // Return null for first two calls (GitHub still computing), then a real sha.
        if (mergeShaCallCount <= 2) return null;
        return "merge-sha-xyz";
      },
      listWorkflowRuns: async (_o, _n, sha) => {
        listCalls += 1;
        // Only return a success run when queried for the merge sha.
        if (sha === "merge-sha-xyz") return [run(1, "ci", "completed", "success")];
        return [];
      },
      listCheckRuns: async () => [],
      mergeSquash: async () => { mergeCalls += 1; },
      sleep: async () => { clock.t += 100; },
      now: () => clock.t,
      selfRunId: "",
      selfWorkflowName: "",
      pollIntervalMs: 100,
      timeoutMs: 60_000,
    });

    // Should have merged after merge sha became available (3rd call).
    expect(mergeCalls).toBe(1);
    // Must NOT have merged on the 2nd or earlier poll while merge sha was null.
    expect(mergeShaCallCount).toBeGreaterThanOrEqual(3);
  });

  it("blocks merge when getPrMergeSha returns null even if head-SHA runs are complete", async () => {
    // When getPrMergeSha is configured and returns null, GitHub is still
    // computing the merge ref. CI that runs only on the merge ref has not
    // appeared yet — even if head-SHA runs are already complete.  Merging on
    // `others.length > 0` alone would bypass those merge-ref checks.
    let mergeShaCallCount = 0;
    let mergeCalls = 0;
    const clock = { t: 0 };

    await mergeIfChecksPass("o", "r", 42, "tok", { info: () => {}, warning: () => {} }, {
      getPrHeadSha: async () => "abc123",
      getPrMergeSha: async () => {
        mergeShaCallCount += 1;
        // Return null for first two calls, then a real sha.
        if (mergeShaCallCount <= 2) return null;
        return "merge-sha-xyz";
      },
      listWorkflowRuns: async (_o, _n, sha) => {
        // Head-SHA already has a completed success run from the start.
        if (sha === "abc123") return [run(2, "lint", "completed", "success")];
        if (sha === "merge-sha-xyz") return [run(3, "ci", "completed", "success")];
        return [];
      },
      listCheckRuns: async () => [],
      mergeSquash: async () => { mergeCalls += 1; },
      sleep: async () => { clock.t += 100; },
      now: () => clock.t,
      selfRunId: "",
      selfWorkflowName: "",
      pollIntervalMs: 100,
      timeoutMs: 60_000,
    });

    // Must have merged only after merge sha became available (3rd call).
    expect(mergeCalls).toBe(1);
    expect(mergeShaCallCount).toBeGreaterThanOrEqual(3);
  });

  it("still applies the no-CI shortcut when getPrMergeSha is not provided", async () => {
    // When the dep is absent entirely (no merge-ref CI expected), the no-CI
    // merge must still fire so repos without CI can merge. The TY-308 delay is
    // disabled here (0 ms) to isolate the mergeShaLookupNull gating: with no
    // getPrMergeSha the shortcut is not gated and merges on the first poll.
    const fake = makeDeps({
      workflowRunPages: [[run(999, "loop-pilot", "in_progress", null)]],
      selfRunId: "999",
      pollIntervalMs: 100,
    });
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      ...fake.deps,
      noCiConfiguredDelayMs: 0,
    });

    expect(fake.mergeCalls).toBe(1);
    expect(fake.sleepCalls.length).toBe(0);
  });
});

describe("mergeIfChecksPass — workflow-name self-exclusion fallback (Finding 3)", () => {
  it("excludes loop runs by workflow name when self run ID is not in the run list", async () => {
    // When triggered via issue_comment, GITHUB_SHA is the default-branch
    // commit, so the current run (ID 999) is absent from the PR head/merge-sha
    // run queries. The name-based fallback must remove all loop runs so that a
    // stale failure from a prior trigger does not block the merge.
    const fake = makeDeps({
      workflowRunPages: [[
        run(100, "loop-pilot", "completed", "failure"),  // stale loop run, not current
        run(1, "ci", "completed", "success"),                   // real CI run
      ]],
      selfRunId: "999",         // current run is NOT in the list
      selfWorkflowName: "loop-pilot",
    });
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(1);
  });

  it("blocks merge when a non-loop run fails even with the workflow-name fallback active", async () => {
    const fake = makeDeps({
      workflowRunPages: [[
        run(100, "loop-pilot", "completed", "failure"),  // stale loop, should be excluded
        run(1, "ci", "completed", "failure"),                   // real CI failure
      ]],
      selfRunId: "999",
      selfWorkflowName: "loop-pilot",
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    expect(fake.mergeCalls).toBe(0);
    expect(calls.find((c) => c.level === "warning")?.message).toContain("failure");
  });

  it("uses path to disambiguate when two workflow files share the same display name", async () => {
    // A different CI workflow happens to have the same display name "loop-pilot"
    // but lives at a different file path and has a different workflow_id. Without
    // path-based disambiguation the wrong workflow would be excluded, letting a
    // real CI failure through. With selfWorkflowPath set, only runs whose path
    // matches are treated as self-runs and excluded.
    const loopRun: WorkflowRunSummary = {
      id: 100,
      workflow_id: 10,
      name: "loop-pilot",
      path: ".github/workflows/looppilot-loop.yml",
      status: "completed",
      conclusion: "failure",
      head_sha: "abc123",
      event: "push",
    };
    const impostor: WorkflowRunSummary = {
      id: 200,
      workflow_id: 20,  // different workflow file, same display name
      name: "loop-pilot",
      path: ".github/workflows/other-ci.yml",
      status: "completed",
      conclusion: "failure",  // this failure must NOT be excluded
      head_sha: "abc123",
      event: "push",
    };
    const fake = makeDeps({
      workflowRunPages: [[loopRun, impostor]],
      selfRunId: "999",              // current run is NOT in the list
      selfWorkflowName: "loop-pilot",
      selfWorkflowPath: ".github/workflows/looppilot-loop.yml",
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    // The impostor's failure must block the merge.
    expect(fake.mergeCalls).toBe(0);
    expect(calls.find((c) => c.level === "warning")?.message).toContain("failure");
  });

  it("strips @ref suffix from workflow run path before comparing to selfWorkflowPath", async () => {
    // The GitHub Actions API returns workflow_runs[].path with a @ref suffix
    // (e.g. ".github/workflows/looppilot-loop.yml@refs/heads/main"), whereas
    // selfWorkflowPath is derived from GITHUB_WORKFLOW_REF with the @ref part
    // stripped. Without normalisation the equality check always fails and the
    // loop workflow is not excluded, causing stale loop failures to block merge.
    const loopRun: WorkflowRunSummary = {
      id: 100,
      workflow_id: 10,
      name: "loop-pilot",
      path: ".github/workflows/looppilot-loop.yml@refs/heads/main",
      status: "completed",
      conclusion: "failure",
      head_sha: "abc123",
      event: "push",
    };
    const ciRun: WorkflowRunSummary = {
      id: 200,
      workflow_id: 20,
      name: "CI",
      path: ".github/workflows/ci.yml@refs/heads/main",
      status: "completed",
      conclusion: "success",
      head_sha: "abc123",
      event: "push",
    };
    const fake = makeDeps({
      workflowRunPages: [[loopRun, ciRun]],
      selfRunId: "999",              // current run is NOT in the list
      selfWorkflowName: "loop-pilot",
      selfWorkflowPath: ".github/workflows/looppilot-loop.yml",
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    // loopRun should be excluded (it's ours); ciRun is green → merge proceeds.
    expect(fake.mergeCalls).toBe(1);
    expect(calls.find((c) => c.level === "warning")).toBeUndefined();
  });
  it("ES-423: does not exclude a workflow run with undefined path as a self-run (fail-closed)", async () => {
    const unknownRun: WorkflowRunSummary = {
      id: 100,
      workflow_id: 10,
      name: "loop-pilot",
      path: undefined,
      status: "completed",
      conclusion: "failure",
      head_sha: "abc123",
      event: "push",
    };
    const ciRun: WorkflowRunSummary = {
      id: 200,
      workflow_id: 20,
      name: "CI",
      path: ".github/workflows/ci.yml",
      status: "completed",
      conclusion: "success",
      head_sha: "abc123",
      event: "push",
    };
    const fake = makeDeps({
      workflowRunPages: [[unknownRun, ciRun]],
      selfRunId: "999",
      selfWorkflowName: "loop-pilot",
      selfWorkflowPath: ".github/workflows/looppilot-loop.yml",
    });
    const { log, calls } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, fake.deps);

    // unknownRun has undefined path — must NOT be treated as self-run, so its
    // failure blocks the merge (fail-closed).
    expect(fake.mergeCalls).toBe(0);
    expect(calls.find((c) => c.level === "warning")?.message).toContain("failure");
  });
});

// TY-295: every skip path in `mergeIfChecksPass` (eleven in total) must
// invoke `postSkipNotification` with a kind that uniquely identifies the
// reason. The acceptance criteria require operator notification on each
// skip; these tests pin the wiring so future refactors of the merger can't
// drop a path silently.
describe("mergeIfChecksPass — postSkipNotification on every skip path (TY-295)", () => {
  function captureNotifications(): {
    notifications: AutoMergeSkipKind[];
    postSkipNotification: (kind: AutoMergeSkipKind) => Promise<void>;
  } {
    const notifications: AutoMergeSkipKind[] = [];
    return {
      notifications,
      postSkipNotification: async (kind) => {
        notifications.push(kind);
      },
    };
  }

  it("path 1 — transient_error when initial getPrHeadSha throws", async () => {
    const { notifications, postSkipNotification } = captureNotifications();
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => {
        throw new Error("rate-limit");
      },
      listWorkflowRuns: async () => [],
      listCheckRuns: async () => [],
      mergeSquash: async () => {},
      sleep: async () => {},
      now: () => 0,
      selfRunId: "",
      selfWorkflowName: "",
      selfWorkflowPath: "",
      pollIntervalMs: 100,
      timeoutMs: 1000,
      postSkipNotification,
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: "transient_error",
    });
    const detail = (notifications[0] as { detail: string }).detail;
    expect(detail).toContain("failed to read PR HEAD sha");
    expect(detail).toContain("rate-limit");
  });

  it("path 2 — head_empty when initial HEAD sha is the empty string", async () => {
    const { notifications, postSkipNotification } = captureNotifications();
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => "",
      listWorkflowRuns: async () => [],
      listCheckRuns: async () => [],
      mergeSquash: async () => {},
      sleep: async () => {},
      now: () => 0,
      selfRunId: "",
      selfWorkflowName: "",
      selfWorkflowPath: "",
      pollIntervalMs: 100,
      timeoutMs: 1000,
      postSkipNotification,
    });

    expect(notifications).toEqual([{ kind: "head_empty" }]);
  });

  it("path 3 — transient_error when getPrHeadSha throws during polling re-read", async () => {
    // First call (initial read) succeeds; second call (re-read on poll #2) throws.
    let call = 0;
    const { notifications, postSkipNotification } = captureNotifications();
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => {
        call += 1;
        if (call === 1) return "abc123";
        throw new Error("rate-limit");
      },
      // Omit getPrMergeSha so the default (which calls `gh`) doesn't fire.
      getPrMergeSha: undefined,
      listWorkflowRuns: async () => [run(1, "ci", "in_progress", null)],
      listCheckRuns: async () => [],
      mergeSquash: async () => {},
      sleep: async () => {},
      now: () => 0,
      selfRunId: "",
      selfWorkflowName: "",
      selfWorkflowPath: "",
      pollIntervalMs: 100,
      timeoutMs: 10_000,
      postSkipNotification,
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ kind: "transient_error" });
    const detail = (notifications[0] as { detail: string }).detail;
    expect(detail).toContain("failed to re-read PR HEAD during polling");
  });

  it("path 4 — head_changed when PR HEAD sha differs on re-read", async () => {
    let call = 0;
    const { notifications, postSkipNotification } = captureNotifications();
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => {
        call += 1;
        return call === 1 ? "abc123" : "def456";
      },
      getPrMergeSha: undefined,
      listWorkflowRuns: async () => [run(1, "ci", "in_progress", null)],
      listCheckRuns: async () => [],
      mergeSquash: async () => {},
      sleep: async () => {},
      now: () => 0,
      selfRunId: "",
      selfWorkflowName: "",
      selfWorkflowPath: "",
      pollIntervalMs: 100,
      timeoutMs: 10_000,
      postSkipNotification,
    });

    expect(notifications).toEqual([
      { kind: "head_changed", oldSha: "abc123", newSha: "def456" },
    ]);
  });

  it("path 5 — transient_error when listWorkflowRuns (head sha) throws", async () => {
    const { notifications, postSkipNotification } = captureNotifications();
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => "abc123",
      listWorkflowRuns: async () => {
        throw new Error("rate-limit");
      },
      listCheckRuns: async () => [],
      mergeSquash: async () => {},
      sleep: async () => {},
      now: () => 0,
      selfRunId: "",
      selfWorkflowName: "",
      selfWorkflowPath: "",
      pollIntervalMs: 100,
      timeoutMs: 1000,
      postSkipNotification,
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ kind: "transient_error" });
    const detail = (notifications[0] as { detail: string }).detail;
    expect(detail).toContain("failed to list workflow runs");
  });

  it("path 6 — transient_error when getPrMergeSha throws", async () => {
    const { notifications, postSkipNotification } = captureNotifications();
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => "abc123",
      getPrMergeSha: async () => {
        throw new Error("rate-limit");
      },
      listWorkflowRuns: async () => [run(1, "ci", "completed", "success")],
      listCheckRuns: async () => [],
      mergeSquash: async () => {},
      sleep: async () => {},
      now: () => 0,
      selfRunId: "",
      selfWorkflowName: "",
      selfWorkflowPath: "",
      pollIntervalMs: 100,
      timeoutMs: 1000,
      postSkipNotification,
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ kind: "transient_error" });
    const detail = (notifications[0] as { detail: string }).detail;
    expect(detail).toContain("failed to read PR merge commit sha");
  });

  it("path 7 — transient_error when listWorkflowRuns (merge sha) throws", async () => {
    // First listWorkflowRuns call (head sha) succeeds; second call (merge
    // sha) throws.
    let listCalls = 0;
    const { notifications, postSkipNotification } = captureNotifications();
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => "abc123",
      getPrMergeSha: async () => "merge456",
      listWorkflowRuns: async () => {
        listCalls += 1;
        if (listCalls === 1) return [run(1, "ci", "completed", "success")];
        throw new Error("rate-limit");
      },
      listCheckRuns: async () => [],
      mergeSquash: async () => {},
      sleep: async () => {},
      now: () => 0,
      selfRunId: "",
      selfWorkflowName: "",
      selfWorkflowPath: "",
      pollIntervalMs: 100,
      timeoutMs: 1000,
      postSkipNotification,
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ kind: "transient_error" });
    const detail = (notifications[0] as { detail: string }).detail;
    expect(detail).toContain("failed to list workflow runs");
  });

  it("path 8 — ci_failed carries every failed run's name and conclusion (the most important path UX-wise)", async () => {
    const fake = makeDeps({
      workflowRunPages: [[
        run(1, "typecheck", "completed", "failure"),
        run(2, "lint", "completed", "cancelled"),
        run(3, "ci", "completed", "success"),
      ]],
    });
    const { notifications, postSkipNotification } = captureNotifications();
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      ...fake.deps,
      postSkipNotification,
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ kind: "ci_failed" });
    const failures = (notifications[0] as {
      failures: ReadonlyArray<{ name: string; conclusion: string }>;
    }).failures;
    expect(failures).toEqual([
      { name: "typecheck", conclusion: "failure" },
      { name: "lint", conclusion: "cancelled" },
    ]);
  });

  it("path 9 — timeout_no_runs when the merge sha never resolves and the wait elapses", async () => {
    // TY-328: with the merge commit sha resolved, "no non-self runs after the
    // full budget" now MERGES (treated as no CI configured). The timeout_no_runs
    // skip remains for the case where GitHub never computes the merge sha
    // (mergeShaLookupNull) — CI may still be pending on the merge ref, so we
    // must not merge. Timing: pollIntervalMs=40s, timeoutMs=60s, clockTickMs=40s
    // → elapsed 80s exceeds the timeout, landing in the timeout branch.
    const fake = makeDeps({
      workflowRunPages: [[run(999, "loop-pilot", "in_progress", null)]],
      selfRunId: "999",
      pollIntervalMs: 40_000,
      timeoutMs: 60_000,
      clockTickMs: 40_000,
    });
    const { notifications, postSkipNotification } = captureNotifications();
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      ...fake.deps,
      // Merge sha never resolves → mergeShaLookupNull stays true → the no-CI
      // timeout merge is suppressed and we skip with timeout_no_runs.
      getPrMergeSha: async () => null,
      postSkipNotification,
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: "timeout_no_runs",
      timeoutMinutes: expect.any(Number),
    });
  });

  it("path 10 — timeout_pending names the still-pending runs", async () => {
    const fake = makeDeps({
      workflowRunPages: [[
        run(1, "slow-e2e", "in_progress", null),
        run(2, "build", "in_progress", null),
      ]],
      pollIntervalMs: 100,
      timeoutMs: 250,
      clockTickMs: 100,
    });
    const { notifications, postSkipNotification } = captureNotifications();
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      ...fake.deps,
      postSkipNotification,
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ kind: "timeout_pending" });
    const pending = (notifications[0] as { pending: ReadonlyArray<string> })
      .pending;
    expect(pending).toEqual(["slow-e2e", "build"]);
  });

  it("path 11 — merge_call_failed when gh pr merge itself rejects (typical: Allow auto-merge disabled)", async () => {
    const fake = makeDeps({
      workflowRunPages: [[run(1, "ci", "completed", "success")]],
      mergeShouldFail: true,
    });
    const { notifications, postSkipNotification } = captureNotifications();
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      ...fake.deps,
      postSkipNotification,
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ kind: "merge_call_failed" });
    const detail = (notifications[0] as { detail: string }).detail;
    expect(detail).toContain("not mergeable");
  });

  it("path 12 — merge_sha_unsettled when the wait elapses with CI green but no merge commit sha", async () => {
    // A non-self CI run is completed/green, but getPrMergeSha never resolves
    // (mergeShaLookupNull stays true — typical of a PR with base-branch
    // conflicts). The green-merge branch is gated off by mergeShaLookupNull, so
    // at timeout we must surface `merge_sha_unsettled` rather than a
    // contradictory `timeout_pending` carrying an empty pending list.
    const { notifications, postSkipNotification } = captureNotifications();
    const { log } = captureLog();

    let clock = 0;
    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      getPrHeadSha: async () => "abc123",
      getPrMergeSha: async () => null,
      listWorkflowRuns: async (_o, _n, sha) =>
        sha === "abc123" ? [run(1, "ci", "completed", "success")] : [],
      listCheckRuns: async () => [],
      mergeSquash: async () => {
        throw new Error("merge must not be attempted when the merge sha is unsettled");
      },
      sleep: async () => {
        clock += 60_000;
      },
      now: () => clock,
      selfRunId: "",
      selfWorkflowName: "",
      selfWorkflowPath: "",
      pollIntervalMs: 100,
      timeoutMs: 60_000,
      postSkipNotification,
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: "merge_sha_unsettled",
      timeoutMinutes: expect.any(Number),
    });
  });

  it("does not invoke postSkipNotification on the happy path (no false-positive notifications)", async () => {
    const fake = makeDeps({
      workflowRunPages: [[run(1, "ci", "completed", "success")]],
    });
    const { notifications, postSkipNotification } = captureNotifications();
    const { log } = captureLog();

    await mergeIfChecksPass("o", "r", 42, "tok", log, {
      ...fake.deps,
      postSkipNotification,
    });

    expect(fake.mergeCalls).toBe(1);
    expect(notifications).toEqual([]);
  });
});
