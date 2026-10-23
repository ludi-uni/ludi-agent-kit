# Native launcher evidence

## Scope

2026-10-22 UTC、native Windows。インストール済み Pi 1.1.0 / pi-subagents
0.76.1 と、プロセス内の固定応答 provider `ludi-native-fixture/fixed` を使用。
**外部モデルへの API 呼び出し・課金はなし**。実際の公開 API owner を通した検証であり、
mock event bus だけの検証ではない。一方、Devin/Qoder の native 実行、orchestrator
全体の E2E、OS sandbox の保証は対象外。

実装対象は `adapters/pi/lib/native-subagent.mjs`、`native-guard.mjs`、
`adapters/pi/shell-gate/` と汎用 runner / workspace lease。
Pi-hosted extension は native を優先し、standalone CLI は subprocess を維持する。

## Installed-owner checks

以下の受入試験はすべて exit 0。成功系は固定応答の completed 宣言だけでなく、
実際の読み取り内容またはファイルの生成結果も検査した。

| Scenario | Observed evidence | Local provider calls |
| --- | --- | ---: |
| read | tool result に既知のテキストを確認 (`readVerified:true`)。terminal と guard quiescence を確認。 | 2 |
| write | `native-output.txt` の内容が要求値と完全一致。guard quiescence を確認。 | 2 |
| shell | limited policy で `node --test shell.test.mjs` を実行し、`shell-ran.txt` を確認。 | 2 |
| turn-limit | 次の provider 呼び出しを防止。失敗と `guard-turn-limit` を確認。owner の turn 集計と provider 呼出回数は同義ではない。 | 1 |
| abort | 固定応答 stream 待機中に呼出元から abort。キャンセルの terminal と guard quiescence を確認。 | 1 |
| shell-abort | 実行した Node test の開始マーカーを待って abort。キャンセル、guard quiescence、記録した test / runner 両 PID の消滅を確認 (`shellStopped:true`)。 | 1 |
| missing-guard | registration 後に当該試験の guard extension を削除。provider 呼び出しなし。guard 証拠不在のため `unconfirmedStop` に止まり、fallback なし。 | 0 |

初期の shell 試験は limited allowlist 外の `node --version` を使っていた。
固定応答の completed 宣言による判定は**偽陽性**であり、実行証拠には採用していない。
許可済みの test command と生成マーカーの検査に置き換えた。
最初の shell-abort 試験も同じ理由で失敗し、修正後は実行開始とプロセス消滅まで確認した。

補足として、一時 PowerShell の `Start-Sleep` を直接 `runCommand` でキャンセルし、
567 ms、code 130、停止確認済みで終了した。これは helper の検証であり、
limited shell gate がそのコマンドを許可したという意味ではない。

owner は `extensions:[]` に対する警告を出す。ambient / MCP / nested-agent extension
を読み込ませない意図的な設定である。親で登録済みの固定応答 provider は実際の native
foreground path で解決した。他の provider / plugin 構成への一般化は未検証。

## Safety acceptance

- `requestId + ownerRunId + nodeId` の完全一致で応答を照合する。
  dispatch 前の owner 不在だけが subprocess を選択できる。native 失敗、不正結果、
  キャンセル、予期しない launcher 例外では別 model / transport を再実行しない。
- 必須の hidden guard sentinel、継続する tool 拒否、provider 呼出前の turn 上限を使用。
  guard は対応する tool ID ごとの未完了状態と shutdown を追跡する。
- owner は tool 終了前に hard-finish できるため、terminal だけでは停止証拠にしない。
  `shutdown:true, pendingTools:0` も必要。不在・古い証拠では listener、registration、
  guard files、writer lease を保持する。
- native shell は実際の close と Windows owned process-tree の停止確認を待つ。
  kill grace が過ぎただけでは停止扱いにしない。
- native writer の dispatch 前に、同期の非公開 callback で SQLite lease を
  `manual_recovery=1` にする。**親 PID の死亡だけでは自動回収しない**。
  orphan shell が残り得るため、operator による残存プロセス確認・停止と当該 entry の
  手動復旧が必要。自動処理はこれを行わない。schema 追加は transaction 内で実行し、
  未保護の従来 lease の dead-owner recovery は維持する。
  この協調プロトコルを使う全 runtime の更新が前提であり、旧 client や OS に対する強制隔離ではない。
- child ごとの shell policy は immutable。同時実行で共有環境変数を書き換えない。
  一時 runtime identity に既存の named role override はコピーしない。
  operator 全体の scope / ceiling と kit routing は引き続き適用される。
  時間監視は host event loop に依存し、同期処理に対する OS preemption の保証ではない。
- retention Promise / callback は task / trace JSON に入れない。
  不明な metrics を 0 として捏造しない。

## Reproduce

repository root で、インストール済み公開 extension entry を指定する。

```powershell
node tests/e2e-native-subagents.mjs <pi-subagents-index.js> read
# Other bounded scenarios: write, shell, turn-limit, abort, shell-abort, missing-guard
```

一時 agent / work directory と offline RPC を使用し、実ユーザー設定、インストール済み
package、model binding は変更しない。表示した OS temp root に `result.json`、
`calls.jsonl`、`rpc.json`、`stderr.log` と生成マーカーを保存する。
直接 adapter を呼ぶ write fixture は専有の使い捨て workspace を使用する。
永続的なプロセス間 lease の挙動は、別途 runner / lease tests でも検証する。

## Validation

- Node test files 55 本を明示列挙して実行：**591 tests / 590 passed / 0 failed / 1 skipped**。
  skip は Windows の file symlink 権限不足による既知のケース。
  `node --test tests/` はこの Node 24 環境で directory を解決できないため、
  `Get-ChildItem tests -Filter '*.test.mjs'` の結果を引数として渡した。
- `pwsh -NoProfile -File tests/test-sync-pi.ps1`：成功。設定の限定 merge、backup、
  dry-run、idempotence、auth 非変更を確認。
- `node scripts/validate.mjs`：成功、errors なし。
- `node scripts/check-pi.mjs --json`：37/37 成功。一時領域の削除を確認。
  message / tool / token / cost はすべて 0。
- `git diff --check`：成功。

既存の未コミット変更は保持し、commit、実ユーザー設定の反映、package 更新は行っていない。
