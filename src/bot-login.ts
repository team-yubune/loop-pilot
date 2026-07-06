/**
 * ES-426 #1: robust GitHub bot-login comparison.
 *
 * GitHub's REST API returns App bot logins WITH the `[bot]` suffix
 * (`chatgpt-codex-connector[bot]`), while GraphQL `author.login` omits it
 * (`chatgpt-codex-connector`). An operator may also set `CODEX_BOT_LOGIN` in
 * either form. Comparing the two sides with strict equality therefore
 * silently fails whenever the configured form and the API form differ — e.g.
 * `CODEX_BOT_LOGIN=chatgpt-codex-connector` (no suffix) never matches the REST
 * `...[bot]` login, so every Codex comment is treated as non-Codex.
 *
 * `botLoginMatches` strips a trailing `[bot]` from BOTH operands before
 * comparing, so a match never depends on which form each source happens to
 * use. (The previous per-call-site check in `unresolved-findings.ts` only
 * stripped the configured side, so it did not cover the REST paths.)
 */
export function stripBotSuffix(login: string): string {
  return login.replace(/\[bot\]$/i, "");
}

/** True when `actual` and `configured` name the same login, ignoring `[bot]`. */
export function botLoginMatches(actual: string, configured: string): boolean {
  return stripBotSuffix(actual) === stripBotSuffix(configured);
}
