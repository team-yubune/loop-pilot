import { describe, it, expect } from "vitest";
import { botLoginMatches, stripBotSuffix } from "../src/bot-login.js";

describe("stripBotSuffix", () => {
  it("removes a trailing [bot] suffix (case-insensitive)", () => {
    expect(stripBotSuffix("chatgpt-codex-connector[bot]")).toBe(
      "chatgpt-codex-connector",
    );
    expect(stripBotSuffix("foo[BOT]")).toBe("foo");
  });

  it("leaves a login without the suffix unchanged", () => {
    expect(stripBotSuffix("chatgpt-codex-connector")).toBe(
      "chatgpt-codex-connector",
    );
  });

  it("only strips a trailing [bot], not an embedded one", () => {
    expect(stripBotSuffix("a[bot]b")).toBe("a[bot]b");
  });
});

describe("botLoginMatches", () => {
  it("matches identical logins", () => {
    expect(botLoginMatches("codex[bot]", "codex[bot]")).toBe(true);
    expect(botLoginMatches("codex", "codex")).toBe(true);
  });

  it("matches across the [bot] suffix mismatch (both directions)", () => {
    // REST login has [bot], configured value omits it (the ES-426 #1 case).
    expect(botLoginMatches("chatgpt-codex-connector[bot]", "chatgpt-codex-connector")).toBe(true);
    // GraphQL login omits [bot], configured value has it.
    expect(botLoginMatches("chatgpt-codex-connector", "chatgpt-codex-connector[bot]")).toBe(true);
  });

  it("does not match different logins", () => {
    expect(botLoginMatches("attacker[bot]", "chatgpt-codex-connector[bot]")).toBe(false);
    expect(botLoginMatches("chatgpt-codex-connector-evil", "chatgpt-codex-connector")).toBe(false);
  });
});
