# 停止条件とリカバリ

## 停止条件

### 正常終了
- 最新 Codex review の閾値以上 finding が 0 件（`LOOPPILOT_SEVERITY_THRESHOLD` で制御、default `P3`）

Codex の `Codex Review: Didn't find any major issues.` コメントを受けると、Workflow B が `done / no_findings` に更新し、完了コメントを投稿する。

**オプション: `done / no_findings` 到達時の自動マージ:**

Repository variable `LOOPPILOT_AUTO_MERGE=true` を設定すると、`done / no_findings` への遷移直後に `mergeIfChecksPass`（`src/pr-merger.ts`）を呼び出し、HEAD commit の workflow run を自前で確認してから `gh pr merge --auto --squash` でマージする。`--auto` を付ける理由は、loop-pilot 自体が required status check として登録されている repo で「自分が走っている間は merge できない」状況を救済するため — GitHub にキューイングを委ねることで、自分自身の完了直後にマージが確定する。`mergeIfChecksPass` は polling で他の workflow run がすべて green を確認してから呼び出すので、`--auto` 経由でも CI 失敗時のバイパスは構造的に起きない。

仕様の前提:

- **Repository Settings → General → "Allow auto-merge" を有効化する必要がある** (`--auto` フラグはこの設定が有効でないと `gh pr merge` が「Pull request merging is not enabled for this repository」で fail する)。未有効の repo では `mergeIfChecksPass` が `core.warning` ログ + `merge_call_failed` の PR 通知を残して skip するため、auto-merge を運用するなら repo setup の初手で有効化する
- それ以外は従来通り: HEAD sha の workflow run を確認 → 全 completed + failure なし → `gh pr merge` 発行

動作:

1. PR の HEAD sha を取得
2. その sha に紐づく workflow runs を `GET /repos/.../actions/runs?head_sha=...` で列挙
3. 自分自身（`GITHUB_RUN_ID` が一致する loop-pilot run）は除外
4. 1 つでも `failure` / `cancelled` / `timed_out` / `action_required` / `startup_failure` / `stale` conclusion があれば **マージしない** + warning
5. すべて `completed` でかつ failure 無しなら `gh pr merge --auto --squash --match-head-commit <verified-sha>` を即発行（GitHub 側でも sha 一致を強制してチェック後の race を防ぐ）
6. まだ `in_progress` / `queued` の run があれば `LOOPPILOT_AUTO_MERGE_POLL_SECONDS` (default 15) 間隔で polling
7. polling 中に PR HEAD sha が変化したら（人が新 commit を push したら）**マージしない** + warning
8. `LOOPPILOT_AUTO_MERGE_TIMEOUT_MINUTES` (default 10) を超過したら **マージしない** + warning
9. `/repos/.../actions/runs` は `--paginate` で全ページ取得するので、100 件超の workflow run があっても page 2+ の failure を見落とさない
10. 自分以外の workflow run が 1 件も見えない場合（= CI 未設定リポの可能性）は、**初回マージまで最低 60s 待つ**（`noCiConfiguredDelayMs`、default `DEFAULT_NO_CI_DELAY_MS`）。これは「CI 未設定」と「CI は登録予定だがまだ visible でない」を区別するための wall-clock ガードで、poll 回数だけで判定すると `2 × LOOPPILOT_AUTO_MERGE_POLL_SECONDS`（約 30s）で発火し、self-hosted runner の cold-start や大きい `workflow_run` provenance チェーン、`actions/runs` API のレプリケーション遅延がある環境で required check 登録前に premature merge してしまう。CI 登録が 60s 超かかる極端な環境では `LOOPPILOT_AUTO_MERGE_TIMEOUT_MINUTES` まで保留され `timeout_no_runs` で skip + 通知される。この待機時間は `MergerDeps.noCiConfiguredDelayMs` 経由で override 可能。

`LOOPPILOT_AUTO_MERGE=true` を使う場合、workflow に `actions: read` 権限が必要（API 読みのため）。未付与だと auto-merge が常に skip される（[security.md](security.md) 参照）。

仕様の前提:

- デフォルト `false`（従来挙動・人手マージ維持）
- 発火するのは `done / no_findings` のみ。`max_iterations` / `loop_detected` / `action_failure` 等の停止では絶対にマージしない
- マージ方式は **squash 固定**
- `gh pr merge --squash` 自体や API 呼び出しが失敗した場合（権限不足、`mergeable=false`、auto-merge 設定が repo で無効など）はワークフローは success のまま warning ログ + **PR コメントで skip 理由を通知** する。人手マージ運用は維持される
- `done` 後に人間が新たに commit を push した場合は polling 中に HEAD 変化を検知して skip し、PR コメントで `/restart-review` の手順を案内する

#### Skip 時の PR 通知

`mergeIfChecksPass` が auto-merge を skip した場合、operator が Actions ログを開かずに PR から状況を把握できるように、`⏸️ **Auto-merge skipped**` で始まる top-level コメントを投稿する。Skip 理由ごとに本文が分岐する:

| Skip 理由 | コメント例 (抜粋) | operator のアクション |
| -- | -- | -- |
| **CI 失敗** (`ci_failed`) | `⏸️ Auto-merge skipped — N CI run(s) failed:` + 失敗した run の `name (conclusion)` 一覧 | 失敗 CI を修正して push (LoopPilot が再走) するか、CI を fix 後に手動マージ |
| **タイムアウト (pending)** (`timeout_pending`) | `⏸️ Auto-merge skipped — timed out after N min waiting for CI to complete.` + pending 中の run 名 | CI 完了待ち後に手動マージ、または `LOOPPILOT_AUTO_MERGE_TIMEOUT_MINUTES` を上げる |
| **タイムアウト (no runs)** (`timeout_no_runs`) | `⏸️ Auto-merge skipped — timed out after N min waiting for any non-self CI run to appear.` | repo に CI が無いことを確認の上、手動マージ |
| **HEAD 変化** (`head_changed`) | `⏸️ Auto-merge skipped — PR HEAD changed during CI wait` + 旧/新 sha | `/restart-review` で最新 HEAD に対して LoopPilot を再起動 |
| **HEAD 空** (`head_empty`) | `⏸️ Auto-merge skipped — PR HEAD sha is empty` | PR 状態を手動調査 |
| **transient error** (`transient_error`) | `⏸️ Auto-merge skipped — transient error: <detail>` | workflow re-run、または CI が green なら手動マージ |
| **マージ呼び出し失敗** (`merge_call_failed`) | `⏸️ Auto-merge skipped — gh pr merge was rejected: <detail>` | Repository Settings → "Allow auto-merge" が無効になっていないか確認 (上記前提) — 必要なら有効化して再 push、または手動マージ |

通知は **直近 90 秒以内に同じ prefix で始まるコメントがあれば抑制** される (crash 通知と同じ dedup pattern)。dedup API が失敗した場合は fall-open (通知を出す) し、safety-net 性質を保つ。通知の post 自体に失敗しても `core.warning` を出すだけで skip 判定そのものには影響しない (best-effort)。

関連 Repository variable / action input:

| variable | input | default | 役割 |
|----------|-------|---------|------|
| `LOOPPILOT_AUTO_MERGE` | `auto-merge-on-clean` | `false` | 機能の opt-in トグル |
| `LOOPPILOT_AUTO_MERGE_POLL_SECONDS` | `auto-merge-poll-seconds` | `15` | polling 間隔 |
| `LOOPPILOT_AUTO_MERGE_TIMEOUT_MINUTES` | `auto-merge-timeout-minutes` | `10` | CI 待ちの上限 |

### 強制停止
- iteration_count >= `MAX_REVIEW_ITERATIONS`

### 異常停止
以下のような場合は停止候補とする。

- Claude が安全に修正できない
- test / lint / typecheck が通らない（→ [検証コマンドとロールバック](check-and-rollback.md)）
- 同一指摘が繰り返される（→ [ループ検知](../specs/loop-detection.md)）
- 同一箇所の修正が収束しない

### Codex 再依頼失敗 (`codex_request_failed`)

post-fix が repair commit を push した後に `@codex review` を投稿する API 呼び出しが失敗した場合 (rate limit / 認証エラー / network 障害)、`stopped/codex_request_failed` へ降格し、`postTerminalNotification` 経由で top-level コメントとして「Codex 再依頼に失敗したため停止」通知が PR に投稿される。repair commit 自体は branch に残るので、Codex の認証・接続を直してから `/restart-review` (soft) で再開すれば良い。`iterationCount` / `findingsHashHistory` は次 iteration が同じ findings を再評価できるよう保持される。

検知ロジック: `src/main-post-fix.ts` の Phase 4 にある `postCodexReviewRequest` catch ブロック（+ ACK 無応答時の降格）。加えて ES-496 の escalated-tier 自動リトライ (`attemptMaxTurnsAutoRetry`, opt-in) も、その `@codex review` 再投稿失敗 / Codex 無 ACK 時に同じ `codex_request_failed` へ降格する。ただしこの経路は **repair commit を伴わない** (working tree は revert 済み) 点が Phase 4 と異なる — 停止コメントも「commit は無い」旨を明示する。復旧はどちらも `/restart-review` (soft) で、`iterationCount` / `findingsHashHistory` は保持される (auto-retry 経路は `rollbackFixingClaim` で base iteration を巻き戻し済み)。

`/restart-review` 経由でも発火しうる: `handleRestartCommand` の第 1 書き込み (`status: waiting_codex` 確定) 直後に `@codex review` の再投稿が失敗した場合、同じ `codex_request_failed` stop reason で降格し top-level 停止コメントが投稿される。`addRestartReaction` / 「🟢 LoopPilot restarted」audit comment は付かない (restart 自体が成立していないため)。復旧手順は post-fix 経由の場合と同じ — Codex 認証 / 接続を直してから `/restart-review` (soft / hard どちらでも) で再開する。

---

### claude-code-action が 0 件修正で終わった (`action_no_op`)

post-fix が claude-code-action の `outcome=success` を受け取り、`git diff --numstat HEAD` でも untracked enumeration でも変更が 1 件も検出されなかった場合の停止。`stopped/action_no_op` で `postStopComment` 経由の top-level 通知が PR に投稿される。

判定タイミングは 2 箇所ある。**pre-CHECK** (claude-code-action 直後の最初の列挙) に加えて、no-build path (`buildCommand === ""`) では **CHECK_COMMAND 後の再列挙** でも net-zero を検知する。後者は claude の編集が scope check と CHECK_COMMAND を通過したものの、CHECK_COMMAND (formatter / codegen 等) が working tree を HEAD と同一に正規化し戻したケースで、放置すると変更の無いコードに `@codex review` を再投稿して iteration を浪費する。build path はこの net-zero を `action_failure` で停止しており (BUILD_COMMAND が修正を消すのは設定不備のシグナル)、no-build path との扱いが対称になっている。

no-op の場合に「Phase 3 bookkeeping を rollback して `@codex review` を再依頼する」自動リトライは行わない。理由:

- 確率的空振り (Claude の判定揺らぎ等) は `max_turns_exceeded` / `loop_detected` 経由の escalated tier で既にカバー済みで、no-op auto-retry 経路の救済範囲と重複する
- stale findings (state 同期ロス由来) で auto-retry しても次 iteration で `lastCodexReviewReceivedAt` が更新されて `done` に落ちるだけで、1 iteration 分の Opus コスト ($1.5〜$3) が無駄になる
- 操作者からは「沈黙の後に何故か Codex が再 review される」という観測しづらいループに見えて、`LOOPPILOT_FULL_AUTO=true` でも介入判断のシグナルが消える
- ユーザー仕様「エラー時は一律ループ停止 / 再開は `/restart-review` のみ」と整合しない

#### 典型的な発生ケース

| パターン | 復旧方針 |
|----------|----------|
| stale findings (state 同期ロス、例: setup-node 失敗の後遺症) | `/restart-review` (soft) — 次 iteration で最新 Codex review を再評価 |
| Claude が false positive と判断して何もしなかった | Codex finding を人間が確認 → 必要なら `/restart-review` (soft) |
| 広範囲リファクタ要求で one-shot 修正不能 | チケットを切り直し、scope を分割 |
| `LOOPPILOT_BLOCK_PATHS` / scope policy で抑制された | 設定を見直して `/restart-review` (soft) |
| CHECK_COMMAND 失敗を予期して claude 自身が変更を undo した | `/restart-review` (soft) で再評価、または手動修正 |
| 対象コードが既に rename / 削除されている | stale 扱い、`/restart-review` (soft) |

#### 復旧手順

1. PR の status comment History の最新 stopped エントリで停止経緯を確認
2. 必要なら Codex の inline comment を直接確認して finding が今も有効か判断
3. `/restart-review` (soft) で再開。`failureExit` が `iterationCount` / `findingsHashHistory` / `lastFindingsHash` / `fixingStartedAt` を pre-Phase 3 状態に rollback 済みなので、soft restart は同じ findings を新規 iteration として再評価する (= 余分な iteration 消費なし、`previous_max_turns_exceeded` 等のシグナルも保持)
4. 同じ no-op が連続する場合は finding 自体に問題がある (false positive / 自動修正不可) と判断し、人手対応か Codex 側へのフィードバックに切り替える

iteration history を完全にクリアしたい場合のみ `/restart-review --hard` を使う。`secret_leak_suspected` のような hard 必須 gating は無い (=人間が状況を確認すれば soft で十分)。

検知ロジック: `src/main-post-fix.ts` の pre-CHECK `changedFiles.length === 0` 分岐と、no-build path の post-CHECK `postCheckChangedFiles.length === 0` 分岐 → いずれも `failureExit({ stopReason: "action_no_op" })`。

---

### 外部サービスの quota 停止 (`codex_usage_limit`)

Codex が `@codex review` 要求に対して通常のレビュー結果ではなく「`You have reached your Codex usage limits for code reviews.`」のような usage-limit / quota 超過コメントを返した場合、pre-fix は trigger body と投稿者 (`CODEX_BOT_LOGIN`) を見て検知し、`stopped / codex_usage_limit` として停止する。

検知ロジック: `src/codex-status.ts:isCodexUsageLimitMessage`。fixture: `tests/fixtures/codex-usage-limit.txt`。

これは LLM の修正品質ではなく外部サービス制約のため、quota がリセットされた後に `/restart-review` (soft) で再開すれば良い (`iterationCount` / `findingsHashHistory` を保持)。

---

### Workflow crash (`workflow_crashed`)

pre-fix / post-fix が `failureExit` を呼ぶ前に例外で死んだ場合 (state-comment-locker の予期せぬ throw / Claude API error / Node unhandled rejection / network 障害など) は、`runIfNotVitest` の `onError` から `demoteFixingOnCrash` (`src/crash-recovery.ts`) が走り、`fixing` だった hidden state を `stopped / workflow_crashed` に降格させた上で `postStopComment` で top-level ⚠️ 通知を投稿する。

これは「workflow が `conclusion=failure` で終わるが通知が出ない silent failure」の構造的対策。この降格を行わないと hidden state が `fixing` のまま残り、`/restart-review` が拒否され続け、運用者は hidden state を手編集するしかなくなる。

復旧: `/restart-review` (soft) で再開できる。iteration history を消したい場合は `/restart-review --hard`。

#### 二重の safety-net

`demoteFixingOnCrash` 自体が token 失効 / API outage 等で死んだ場合に備え、再利用ワークフロー `.github/workflows/loop.yml`（adopter は薄い caller `looppilot-loop.yml` から参照）の `auto-fix` job 末尾に YAML 側 fail-safe step がある (`Post crash notification on workflow failure`)。これは workflow の `GITHUB_TOKEN` で `gh api` を直接叩き、最低限「止まったこと」を PR に通知する。`postStopComment` のような綺麗な書式は出ないが、workflow run の URL は載るので運用者はログから根本原因を辿れる。

##### dedup ロジック

2A (`demoteFixingOnCrash` の `postStopComment`) と 2B (YAML fail-safe step) は **片方が死んでも通知が届くこと** を目的にしているため、両方成功すると ⚠️ 通知が重複する。

2B step は post する直前に「直前 90 秒以内に `github-actions[bot]` が `⚠️ **LoopPilot stopped**` で始まる top-level コメントを投稿しているか」を `gh api` で check し、ある場合は skip する (`::notice::` ログのみ残す)。dedup check が API 障害等で失敗した場合は **fall open** (post を強行) するので 2B の safety-net 性質は保たれる。

90 秒という短い window は、無関係な過去の停止通知を誤って dedup 対象にしないため。`demoteFixingOnCrash` は crash 検出から数秒以内に 2A を投稿するので、この window で取りこぼすことはない。

##### state demotion 失敗時の挙動

`demoteFixingOnCrash` の `updateStateComment` が失敗 (412 conflict / 5xx / token 失効) した場合、`postStopComment` は **呼び出されない**。理由は次の通り:

- `updateStateComment` 失敗 ⇒ hidden state は `fixing` のまま
- そこで `postStopComment` を呼ぶと、可視 status comment header が `Stopped — workflow_crashed` に書き換わり、top-level ⚠️ 通知も「stopped」を主張する
- 運用者は `/restart-review` を投げるが `applyRestartToState` は hidden state が `fixing` のため reject
- 結果: 「Stopped が見えるのに restart できない」silent-unrecoverable UX が再発する

代わりに 2B step が `⚠️ LoopPilot crashed` (`stopped` ではない) を post する。これは demotion を主張しないので状態不整合は起きない。ただし hidden state は `fixing` のままなので、`/restart-review` は STALE_THRESHOLD_MS (30 分) 経過後の pre-fix stale check で初めて demote される。30 分以内に復旧したい場合は hidden state comment を手編集する必要がある。

トレードオフ:

- **gate あり (現状)**: state 不整合が発生しない代わりに、demotion 失敗時は 30 分待つか hidden state 手編集が必要
- **gate なし (旧 behavior)**: 即時 `/restart-review` を試みられるが、hidden state が `fixing` のため reject されて操作不能

silent-unrecoverable を再発させないため gate ありを採用。実運用での demotion 失敗頻度は低い (concurrent writer は restart race 等の特殊事例のみ) ので、30 分待ち or 手編集の運用コストは許容範囲。

#### 関連経路

`fixing` のまま停止していて 30 分以上経過した状態を pre-fix が次の trigger で検出した場合も同じ `workflow_crashed` で降格する (`src/main-pre-fix.ts` の stale-fixing 検出)。

---

### Secret leak の疑い (`secret_leak_suspected`)

post-fix の secret-scanner (`src/secret-scanner.ts`) が **hard-fail パターン**（既知 token prefix / PEM private-key ブロック）を変更ファイルの内容から検出した場合、scope check 通過後 / CHECK_COMMAND 実行前にロールバック + `stopped / secret_leak_suspected` で停止する。

実装経路: `src/main-post-fix.ts` の scope check 通過直後 → `scanForSecrets` → hard-fail 検出 → `resetWorkingTree` → `failureExit({ stopReason: "secret_leak_suspected" })`。

#### 停止コメントに含まれる情報

- 検出した pattern 名 (例: `github-pat-classic`) と path のみ。**マッチした値そのものは含まれない** — 停止コメント自体が secret leak の vector にならないようにするため
- 復旧手順 (`/restart-review --hard` 必須) と関連 doc へのリンク

#### 復旧手順

1. PR の変更ファイルを手動でレビューし、漏洩した secret を特定する
2. secret 自体を **rotate** する (例: GitHub PAT を revoke、AWS access key を deactivate、private key を再生成)。push 済みなら git history からも除去 (`git filter-repo` 等)
3. **コミット履歴と branch を確認**: post-fix はロールバックを行うため auto-fix の commit は残らないが、claude-code-action が直接編集した working tree は reset 前に存在した。`git log` に新しいコミットが入っていないことを確認
4. `/restart-review --hard` を投稿。**soft restart は `secret_leak_requires_hard_restart` で拒否される** — 同じ Codex finding hash で再 trigger すれば同じ secret 検出経路を踏み無限ループになるため、`--hard` で iteration history を明示的に clear する必要がある
5. 次 iteration を観測。warning パターンの再検出は許容するが、hard-fail が再度出る場合は実装の secret-scanner pattern または Codex finding 自体に問題がある

#### `/restart-review` (soft) を拒否する理由

`applyRestartToState` (`src/restart-command.ts`) が `state.stopReason === "secret_leak_suspected"` + `mode === "soft"` の組合せを `secret_leak_requires_hard_restart` reason で reject する。これは「人間が leak を確認した」という明示的な操作を求めるためで、PR 作者が誤って soft restart を打っても直ちに同じ経路で再 leak することはない。

---

## 停止時コメント例

LoopPilot の終了系イベント (`done` / `stopped` / `init_incomplete`) では **2 つの場所** に情報が出る:

1. **集約 status コメント** (`src/status-comment.ts`): PR ごとに 1 件、History セクションに stopped/done エントリを append
2. **新規 top-level コメント** (`postTerminalNotification`): GitHub 通知を発火させるために、terminal 遷移時のみ別途投稿される

### 1. 集約 status コメントの History エントリ例

```text
### Automation stopped — max iterations reached — `/restart-review --hard` to retry
*2026-05-16T12:34:56Z*

Reason: max iterations reached — `/restart-review --hard` to retry
Last processed Codex review: #987654321
Open in-scope findings remaining: 1
Detail: ...
```

### 2. 新規 top-level コメント (通知用) 例

```markdown
⚠️ **LoopPilot stopped** — max iterations reached — `/restart-review --hard` to retry.

Open in-scope findings remaining: 1. Manual intervention required.
See the [status comment](https://github.com/<owner>/<repo>/pull/<N>#issuecomment-<id>) for the full history.
```

```markdown
✅ **LoopPilot completed** — no findings remaining (3 iterations).

See the [status comment](https://github.com/<owner>/<repo>/pull/<N>#issuecomment-<id>) for the full history.
```

CHECK_COMMAND 失敗 (`stop_reason: test_failure`) のときは、status コメントに `postTestFailureComment` が nonce-fence 付きで CHECK_COMMAND 出力を記録した上で、別途同じ `stopped` フォーマットの top-level 通知が投稿される。出力本文の二重投稿は避けるため、top-level 側はリンクのみで簡潔に出る:

```markdown
⚠️ **LoopPilot stopped** — CHECK_COMMAND failed after the repair — fix the failure and `/restart-review`.

Open in-scope findings remaining: 0. Manual intervention required.
See the [status comment](https://github.com/<owner>/<repo>/pull/<N>#issuecomment-<id>) for the full history.
```

通知用コメントの post は best-effort (`core.warning` で失敗を出すのみ、status コメントの戻り値は維持される)。iteration 進捗 (`auto_fix_applied`) は通知を発火しない。

---

## 停止後のリカバリ手順

自動修正が停止した後、人間が修正を加えて再開する手順を定義する。

### `/restart-review` による再実行

`stopped` または `done(no_findings)` になった LoopPilot は、PR の issue comment に restart command を投稿して再実行する。hidden comment JSON を直接編集しない。

```text
/restart-review
```

soft restart。state を `waiting_codex` に戻し、同じ run で `@codex review` を投稿する。以下の状態から再実行できる。

- `test_failure`
- `max_iterations`（`--hard` 推奨）
- `loop_detected`（`--hard` 推奨。base + escalated 両 tier で同じ finding が再発した状態なので、`--hard` 前に finding 自体の妥当性を人間が再評価する）
- `max_turns_exceeded`（soft 推奨。次 iteration が自動で escalated tier になる）
- `codex_usage_limit`（quota リセット後に soft）
- `codex_request_failed`（Codex 認証 / 接続を直してから soft）
- `action_no_op`（claude-code-action が 0 件修正で終わった場合の停止。typically soft）
- `workflow_crashed`（soft で復旧可能 — pre-fix / post-fix が `failureExit` を呼ぶ前に死んだケース）
- `no_findings`（`done` 状態）
- `waiting_codex`

保持する状態:

- `iterationCount`
- `findingsHashHistory`
- `lastClaudeCommitSha`
- `lastFindingsHash`
- `stopReason` (次 iteration のモデル選定 [`previous_max_turns_exceeded`](security.md#escalation-条件-いずれかが真で-escalated-tier) で参照する。post-fix の clean commit で `null` にリセット)

書き換える状態:

- `status`: `stopped` または `done` → `waiting_codex`
- `lastProcessedReviewId`: `null`
- `lastCodexReviewReceivedAt`: 保持する（過去の Codex inline comment を再処理しないため）
- `lastCodexRequestCommentId`: 新しく投稿した `@codex review` comment ID

```text
/restart-review --hard
```

hard restart。soft restart の操作に加えて、`iterationCount` を `0`、`findingsHashHistory` を `[]`、`lastFindingsHash` を `null` に戻す。`stopReason` の扱いは soft restart と同じく保持する。

`max_iterations` は上限判定を抜けるために hard restart が適している。`loop_detected` は履歴を消すため、人間が修正済みであることを確認してから使う。

### 権限

`/restart-review` を実行できるユーザーは `LOOPPILOT_RESTART_ROLES` で制御する。

- デフォルト: `author,write,maintain,admin`
- `author`: PR 作成者
- `write` / `maintain` / `admin`: GitHub collaborator permission

権限不足の場合、状態は変更せず、PR に拒否コメントを残す。

**Workflow 起動レイヤーの追加ゲート:**
- 再利用ワークフロー `loop.yml`（caller `looppilot-loop.yml`）の job `if` で、`/restart-review` 経路では `github.event.comment.author_association` が `OWNER` / `MEMBER` / `COLLABORATOR` のいずれか、**または** commenter が PR 作者本人 (`github.event.comment.user.login == github.event.issue.user.login`) でない場合は workflow run 自体が起動しない
- これは TS 側の `handleRestartCommand` 内の permission check (上記 `LOOPPILOT_RESTART_ROLES`) を補完する defense-in-depth。public PR で関係ない第三者が `/restart-review` を連投しても、workflow run / Actions minutes / 並行 job スロットを消費しない
- 外部コントリビューター (`CONTRIBUTOR` / `FIRST_TIME_CONTRIBUTOR` / `NONE`) の PR 作者は `LOOPPILOT_RESTART_ROLES` のデフォルト `author` に含まれるため、自分の PR 上で `/restart-review` を発火できる。それ以外の外部ユーザーが restart したい正当な要件は基本的に発生しないため、本 gate を緩める運用は非推奨。例外運用が必要な場合は workflow YAML の `if` 条件を明示的に編集する

**実行内部の順序:**
- `handleRestartCommand` は parse 直後に `canRestart` で権限を確認し、不足時は 1 件の拒否コメントだけ投稿して return する
- state read / `state_corrupted` 通知 / `unsupported_option` 通知などの side effect は全て権限チェックの後に走る。これにより、権限のない `/restart-review` が誤って state や追加コメントを生成する経路を塞ぐ

### 再開フロー

1. 人間が修正を commit / push する
2. 通常は `/restart-review`、回数・履歴も消したい場合は `/restart-review --hard` をPRコメントに投稿する
3. Workflow B が hidden state を `waiting_codex` に戻す
4. Workflow B が `@codex review` を投稿し、Codex の再レビューを起動する

### 状態のリセットが必要なケース
- `iteration_count >= MAX_REVIEW_ITERATIONS` で停止した場合: `/restart-review --hard`
- `loop_detected` で停止した場合: base + escalated 両 tier で同じ指摘が再発した状態。`--hard` で履歴を消す前に、Opus でも修正できなかった指摘なので finding 自体の妥当性を人間が再評価する。修正で指摘内容が変わったことを確認してから `/restart-review --hard`
- `test_failure` で停止した場合: 人間がテストを修正してから `/restart-review`
- `done(no_findings)` 後に同じ PR を再度レビュー・修正ループにかけたい場合: `/restart-review`
- `fixing` のまま停止している場合: 実行中の Workflow B がないことを確認してから `/restart-review --hard`
- `codex_usage_limit` で停止した場合: Codex 側の quota がリセットされたタイミングで `/restart-review` (soft)。`iterationCount` は保持される
- `max_turns_exceeded` で停止した場合: `/restart-review` (soft) で再開する。次 iteration は自動で escalated tier (default Opus) に上がる (`previous_max_turns_exceeded`)。1 回 clean commit に到達すると `stopReason` がクリアされ通常 tiering に戻る (one-shot)
  - **自動リトライ (opt-in, ES-496)**: Repository variable `LOOPPILOT_AUTO_RETRY_ESCALATE=true` を設定すると、**base tier** の `max_turns_exceeded` では停止せず post-fix がその場で `@codex review` を再投稿し `waiting_codex` (`stopReason: max_turns_exceeded` 保持) に戻す → 次 iteration が自動で escalated tier に上がる (`/restart-review` 不要)。発火時は `🔁 LoopPilot auto-retry` で始まる top-level コメントを投稿する。**one-shot**: escalated tier の iteration が再び `max_turns_exceeded` になった場合 (直前 `findingsHashHistory` entry の `modelTier === "escalated"`)、および `BASE === ESCALATED` (固定モデル運用) の場合は自動リトライせず従来どおり停止する。自動リトライの `@codex review` 投稿失敗 / Codex 無 ACK は `stopped/codex_request_failed` に降格する (commit は無いので `/restart-review` で同じ findings を再評価できる)
- `workflow_crashed` で停止した場合: `/restart-review` (soft) で再開する。workflow crash 時には `iterationCount` が消費済みなので、connector / runner 側の不安定さが継続する場合は `/restart-review --hard` を検討

### `state_corrupted` の復旧

`stopped / state_corrupted` には 2 種類の発生経路がある:

1. **JSON unparseable**: pre-fix が hidden comment の `<!-- looppilot-state ... -->` JSON を読めなかった場合 (`stateResult.corrupted === true`)。この場合 `handleRestartCommand` は state を安全に読めないため `/restart-review` を即拒否する (`src/restart-command.ts`)。
2. **論理的 corrupted**: state JSON は parseable だが `stopReason === "state_corrupted"` が記録されている場合。workflow crash / stale-fixing recovery 経路はここではなく `workflow_crashed` に降格する (上記参照)。

#### 復旧手順

**1 番目の経路 (JSON unparseable)** は依然として hidden comment の手動編集が必要:

1. PR の hidden comment（`<!-- looppilot-state ... -->` を含むコメント）を特定する
2. `gh api -X DELETE /repos/:owner/:repo/issues/comments/:id` で削除する
3. Workflow A を手動 dispatch、またはPR操作で再実行して hidden comment を再作成する
4. PR に復旧理由・操作者を含む audit コメントを投稿する

> **注意**: この経路では `/restart-review --hard` でも復旧できない。`handleRestartCommand` は state を読めない時点で early return するため `--hard` の clear ロジックに到達せず、同じ拒否文言が返るだけになる。拒否コメント自体に上記手順が埋め込まれているため、operator が docs を開かなくても 1 コメントで完結する。

**2 番目の経路 (論理的 corrupted)** は `/restart-review --hard` で復旧できる:

- `applyRestartToState` (`src/restart-command.ts`) は `state.stopReason === "state_corrupted"` + `mode === "soft"` の組合せのみを reject する
- `--hard` は iterationCount を 0、findingsHashHistory を `[]` にクリアするため、状態機械がどんな歪み方をしていても安全に再開できる
- soft restart を拒否するのは、論理的 corrupted は何らかの不整合を示すため、明示的なオペレータ操作 (history clear) を求める意図

通常の再実行では `/restart-review` を使い、hidden JSON の直接編集は運用に組み込まない。hidden comment の手動リセットは JSON unparseable の経路でのみ行う。

---

## 関連ドキュメント

- [推奨フローと状態管理](../architecture/flow-and-state.md) — 状態遷移の全体像
- [ループ検知](../specs/loop-detection.md) — 同一指摘ループの検知アルゴリズム
- [検証コマンドとロールバック](check-and-rollback.md) — テスト失敗時の挙動
- [全ドキュメント索引](../README.md)
