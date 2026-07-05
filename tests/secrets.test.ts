import { describe, it, expect, vi } from "vitest";
import {
  SECRET_CONFIG_FIELDS,
  SECRET_ENV_NAMES,
  registerAllSecrets,
  stripSecretEnv,
} from "../src/secrets.js";
import type { Config } from "../src/config.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    maxReviewIterations: 20,
    debounceSeconds: 0,
    checkCommand: "npm run check",
    buildCommand: "",
    codexBotLogin: "codex",
    stabilizeIntervalSeconds: 1,
    stabilizeCount: 1,
    codexReviewRequestToken: "codex-secret",
    autoReviewPushToken: "push-secret",
    anthropicApiKey: "anth-secret",
    claudeCodeOauthToken: "oauth-secret",
    githubToken: "gh-secret",
    repoOwner: "edereship",
    repoName: "loop-pilot",
    prNumber: 1,
    triggerCommentId: 0,
    triggerCommentBody: "",
    triggerUserLogin: "",
    triggerEventName: "",
    prHeadRef: "",
    prTitle: "",
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
    ...overrides,
  };
}

describe("registerAllSecrets", () => {
  it("registers every non-empty secret-bearing Config field exactly once", () => {
    const setSecret = vi.fn<(s: string) => void>();
    registerAllSecrets(makeConfig(), setSecret);

    const registered = setSecret.mock.calls.map((c) => c[0]);
    expect(registered).toEqual(
      expect.arrayContaining([
        "gh-secret",
        "codex-secret",
        "push-secret",
        "anth-secret",
        "oauth-secret",
      ]),
    );
    expect(registered).toHaveLength(SECRET_CONFIG_FIELDS.length);
  });

  it("skips empty secret values (covers post-fix loadInitConfig where Anthropic creds are empty)", () => {
    const setSecret = vi.fn<(s: string) => void>();
    registerAllSecrets(
      makeConfig({ anthropicApiKey: "", claudeCodeOauthToken: "" }),
      setSecret,
    );

    const registered = setSecret.mock.calls.map((c) => c[0]);
    expect(registered).not.toContain("");
    expect(registered).toEqual(
      expect.arrayContaining(["gh-secret", "codex-secret", "push-secret"]),
    );
  });
});

describe("stripSecretEnv", () => {
  it("removes all known secret-bearing env names", () => {
    const env: NodeJS.ProcessEnv = {
      GITHUB_TOKEN: "x",
      GH_TOKEN: "x",
      CODEX_REVIEW_REQUEST_TOKEN: "x",
      LOOPPILOT_PUSH_TOKEN: "x",
      ANTHROPIC_API_KEY: "x",
      CLAUDE_CODE_OAUTH_TOKEN: "x",
      INPUT_GITHUB_TOKEN: "x",
      INPUT_CODEX_REVIEW_REQUEST_TOKEN: "x",
      INPUT_LOOPPILOT_PUSH_TOKEN: "x",
      INPUT_ANTHROPIC_API_KEY: "x",
      INPUT_CLAUDE_CODE_OAUTH_TOKEN: "x",
      PATH: "/usr/bin",
    };

    const safe = stripSecretEnv(env);

    for (const name of SECRET_ENV_NAMES) {
      expect(safe[name]).toBeUndefined();
    }
    expect(safe.PATH).toBe("/usr/bin");
  });

  it("strips every INPUT_* env (defense-in-depth for future action inputs)", () => {
    const env: NodeJS.ProcessEnv = {
      INPUT_CHECK_COMMAND: "npm test",
      INPUT_FUTURE_SECRET: "value",
      INPUT_PR_NUMBER: "42",
      PATH: "/usr/bin",
      HOME: "/home/user",
    };

    const safe = stripSecretEnv(env);

    expect(safe.INPUT_CHECK_COMMAND).toBeUndefined();
    expect(safe.INPUT_FUTURE_SECRET).toBeUndefined();
    expect(safe.INPUT_PR_NUMBER).toBeUndefined();
    expect(safe.PATH).toBe("/usr/bin");
    expect(safe.HOME).toBe("/home/user");
  });

  it("does not mutate the original env", () => {
    const env: NodeJS.ProcessEnv = { GITHUB_TOKEN: "x", PATH: "/bin" };
    stripSecretEnv(env);
    expect(env.GITHUB_TOKEN).toBe("x");
    expect(env.PATH).toBe("/bin");
  });
});
