import { describe, it, expect } from "vitest";
import {
  botLoginMatches,
  botLoginMatchesGraphql,
  isBotSuffixed,
  stripBotSuffix,
} from "../src/bot-login.js";

describe("stripBotSuffix / isBotSuffixed", () => {
  it("removes / detects a trailing [bot] suffix (case-insensitive)", () => {
    expect(stripBotSuffix("chatgpt-codex-connector[bot]")).toBe(
      "chatgpt-codex-connector",
    );
    expect(stripBotSuffix("foo[BOT]")).toBe("foo");
    expect(isBotSuffixed("foo[bot]")).toBe(true);
    expect(isBotSuffixed("foo")).toBe(false);
  });

  it("only strips a trailing [bot], not an embedded one", () => {
    expect(stripBotSuffix("a[bot]b")).toBe("a[bot]b");
    expect(isBotSuffixed("a[bot]b")).toBe(false);
  });
});

describe("botLoginMatches (REST — suffix-anchored)", () => {
  it("matches identical logins", () => {
    expect(botLoginMatches("codex[bot]", "codex[bot]")).toBe(true);
    expect(botLoginMatches("codex", "codex")).toBe(true);
  });

  it("matches a suffixed REST login against a base-form config (the ES-426 #1 footgun)", () => {
    expect(
      botLoginMatches("chatgpt-codex-connector[bot]", "chatgpt-codex-connector"),
    ).toBe(true);
  });

  it("does NOT let a base-name human impersonate the bot on the default suffixed config", () => {
    // REST returns the suffixed App login; a human login can never contain
    // [bot]. Under the default config the base-name human must not match.
    expect(
      botLoginMatches("chatgpt-codex-connector", "chatgpt-codex-connector[bot]"),
    ).toBe(false);
  });

  it("does not match different logins", () => {
    expect(botLoginMatches("attacker[bot]", "chatgpt-codex-connector[bot]")).toBe(false);
    expect(botLoginMatches("chatgpt-codex-connector-evil", "chatgpt-codex-connector")).toBe(false);
  });
});

describe("botLoginMatchesGraphql (unsuffixed App login)", () => {
  it("matches the base name against either config form", () => {
    // GraphQL author.login has no [bot] suffix for Apps.
    expect(
      botLoginMatchesGraphql("chatgpt-codex-connector", "chatgpt-codex-connector[bot]"),
    ).toBe(true);
    expect(
      botLoginMatchesGraphql("chatgpt-codex-connector", "chatgpt-codex-connector"),
    ).toBe(true);
    expect(
      botLoginMatchesGraphql("chatgpt-codex-connector[bot]", "chatgpt-codex-connector[bot]"),
    ).toBe(true);
  });

  it("does not match a different login", () => {
    expect(botLoginMatchesGraphql("someone-else", "chatgpt-codex-connector[bot]")).toBe(false);
  });
});
