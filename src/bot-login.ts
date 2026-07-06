/**
 * ES-426 #1: robust GitHub bot-login comparison, in two API-shape-specific
 * forms.
 *
 * GitHub's REST API returns an App's login WITH the `[bot]` suffix
 * (`chatgpt-codex-connector[bot]`), while GraphQL `author.login` omits it
 * (`chatgpt-codex-connector`). An operator may also set `CODEX_BOT_LOGIN` in
 * either form. Comparing with strict equality silently fails when the
 * configured form and the API form differ.
 *
 * The naive "strip `[bot]` from both sides" fix would erode a real security
 * boundary on the REST paths: no human GitHub account can contain `[`/`]`, so
 * the REST `[bot]` suffix is unforgeable — under the default suffixed config it
 * guarantees no human login can match the bot. Stripping both sides would let a
 * human whose login equals the base name (`chatgpt-codex-connector`) match the
 * bot. So the two forms below are deliberately asymmetric.
 */
export function stripBotSuffix(login: string): string {
  return login.replace(/\[bot\]$/i, "");
}

/** True when `login` carries a trailing `[bot]` suffix (the REST App form). */
export function isBotSuffixed(login: string): boolean {
  return /\[bot\]$/i.test(login);
}

/**
 * Match for REST logins (`user.login`), where a real App is ALWAYS suffixed.
 * Matches iff the logins are exactly equal, or their base names are equal AND
 * the *actual* login is `[bot]`-suffixed (a genuine App identity a human cannot
 * forge). This fixes the base-form `CODEX_BOT_LOGIN` footgun (suffixed REST
 * login vs base config) without letting a base-name human impersonate the bot
 * on the default suffixed config.
 */
export function botLoginMatches(actual: string, configured: string): boolean {
  if (actual === configured) return true;
  return (
    stripBotSuffix(actual) === stripBotSuffix(configured) && isBotSuffixed(actual)
  );
}

/**
 * Match for GraphQL logins (`author.login`), where a real App is UNSUFFIXED.
 * Matches the actual against the configured value or its base name. (No `[bot]`
 * anchor is available here — the App form has no suffix — so this path accepts
 * the base form, exactly as the pre-ES-426 `unresolved-findings` check did.)
 */
export function botLoginMatchesGraphql(
  actual: string,
  configured: string,
): boolean {
  return actual === configured || actual === stripBotSuffix(configured);
}
