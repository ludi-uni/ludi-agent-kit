# One-shot async evidence

## Scope

`adapters/pi/lib/invoke.mjs` の model 待機を `spawnSync` から非同期 `spawn` に置換。
既存の read-only 並行スケジューリングを妨げていた event-loop blocking を取り除いた。
routing、並行数、writer 排他、無関係な git / test / inventory の同期処理は変更していない。

変更対象：
- `adapters/pi/lib/invoke.mjs`
- `lib/orchestrator/runner.mjs` の oneshot signal / cancellation 処理
- `tests/invoke-long-prompt.test.mjs`
- `tests/invoke-async.test.mjs`
- `tests/fixtures/oneshot-child.mjs`

## Acceptance

Main が実行した focused tests は **40/40 成功**。
外部 provider / model API は呼ばず、Node 子プロセスと ChildProcess doubles を使用した。
通常の開発用 subagent 実行とは別であり、作業全体のモデル利用がゼロという意味ではない。

- 二つの実プロセスが各開始マーカーを作るまで、完了用 barrier を開かない。
  単なる時間比較ではなく、同時に生存して待機したことを検証。
- 独立した prompt files、子が動作中のファイル生存、close 後の削除を検証。
- 実プロセス待機中も host timer が進むことを検証。
- UTF-8 の実 stdout と、一バイト単位に分割した決定的な stream double を検証。
- stdout / stderr それぞれ 16 MiB の byte bound、stream error、非0 exit、signal exit、
  空応答、spawn throw / failure を検証。
- SIGTERM → grace → SIGKILL の順で、直接所有する子だけに停止を要求。
  両要求後も close がなければ結果と prompt を保持し、後から届く close で終了する。
- abort-before-spawn、spawn 中に起きる abort、abort listener の解除を検証。
- すでにキャンセル済みの oneshot runner は invoke しない。キャンセル後の遅い成功応答、
  planned task、parent task でも abort を優先し、次 model 候補を呼ばない。
  通常の model failure の候補進行は維持する。
- 明示的な不正 timer bounds は予算を拡大して既定値に置換せず、起動前に拒否する。

## Review and corrections

coder 実装後、別の fresh-context reviewer が read-only でレビューした。
Main はレビューの受入判断をそのまま採用せず、停止未確認で結果を返して prompt を削除する
経路を検出して修正した。grace は停止証拠ではなく、強制停止を要求する時点とした。
追加で stream errors、timer bounds、キャンセルの late-success / planned-task 優先順位を
修正し、対応する回帰テストを Main が実行した。subagent はテストを実行していない。

## Limits

- `createPiInvoker` の標準の入力 / 結果形式と CLI flags は維持する。
  optional `signal` と `killGraceMs` を追加。`spawnImpl` test seam は同期結果 object ではなく
  Node `spawn` 互換の ChildProcess を返す必要がある。
- 全 consumer に新たな cancellation 経路を設けたわけではない。
  planner / maintenance / legacy pipeline への signal 配線と top-level cancel command は対象外。
- 時間監視は共有 event loop に依存する。timeout は停止要求の期限であり、終了応答の
  厳密な期限ではない。強制停止後も OS の close が確認できなければ Promise は pending のまま。
  停止を捏造して次候補を開始することはしない。
- 停止対象は直接所有する CLI process。任意の plugin、子孫プロセス、OS の sandbox を
  保証しない。既存の extension 読み込み・認証・tool flags は変更していない。
- 実 hosted model を使った性能測定や、orchestrator 全体の新しい live E2E は行っていない。
  実際の並行性は adapter のローカル子プロセスで確認し、既存スケジューラは全回帰で確認する。
- 実ユーザー設定、installed package、model binding は変更しない。既存の未コミット変更を保持。

## Validation

```powershell
node --test tests/invoke-long-prompt.test.mjs tests/invoke-async.test.mjs tests/pi-entry.test.mjs tests/orchestrator-tools.test.mjs
```

- 上記 focused tests：40/40 成功。
- `tests/*.test.mjs` 56 ファイルを明示列挙：**606 tests / 605 passed / 0 failed / 1 skipped**。
  skip は Windows の file symlink 権限不足による既知のケース。
  この Node 24 環境では `node --test tests/` が directory を解決できないため明示列挙した。
- `pwsh -NoProfile -File tests/test-sync-pi.ps1`：成功。auth 非変更も確認。
- `node scripts/validate.mjs`：成功、errors なし。
- `node scripts/check-pi.mjs --json`：37/37 成功、一時領域の削除を確認。
- `git diff --check`：成功。

Asana connector は利用できず、project 同期は行っていない。commit、実ユーザー設定の
反映、installed package の更新も行っていない。
