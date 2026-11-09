# 導入ガイド

[English](getting-started.md) · [日本語 README](../README.ja.md)

## 必要な環境

**Pi パッケージとして利用する場合**の検証基準は、ネイティブ Windows 上の Pi 1.4.0 + pi-subagents 0.83.1 です（Node >=22.19.0、検証は Node 24.22.1）。実タスクでは認証済みプロバイダー、モデル ID、利用枠も必要です。版・OS 制限は[パッケージ導入・移行](pi-package.ja.md)を確認してください。**ソースから利用する場合**は、Windows・PowerShell 7・Git・`node:sqlite` 対応の Node.js が必要です（Node 24 で検証）。基本スクリプトに `npm install` は不要です。

## Pi に導入する

```powershell
pi install npm:@ludi-uni/ludi-agent-kit
pi list
```

Git から導入する場合は `pi install git:github.com/ludi-uni/ludi-agent-kit` を使います。`npm install @ludi-uni/ludi-agent-kit` だけでは、Skill や拡張が Pi に登録されません。

バージョンを固定せず導入した場合は `pi update npm:@ludi-uni/ludi-agent-kit` で更新できます。`npm:@ludi-uni/ludi-agent-kit@0.1.2` のように固定した場合、その指定のままでは新しい版に進まないため、必要な版を明示して `pi install` し、`pi list` で確認してください。拡張を読み直すには Pi セッションを再起動します。

導入すると `pi-workflow`、`project-management`、`visual-verification` の Skill と、loop guard・`ludi_orchestrate` 拡張が読み込まれます。拡張は Pi プロセスの権限で動くため、利用前にソースを確認してください。子エージェント専用の `shell-gate` は全体には読み込まれません。postinstall が Pi の設定や認証情報を書き換えることもありません。

### 実行前にモデルを対応付ける

`adapters/pi/models.json` は設定例であり、**そのままで利用できるモデルや認証情報ではありません**。ソースを取得した場合は、次のように例をユーザー領域へコピーし、`pi --list-models` で利用できる ID を調べて編集してください。

```powershell
$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME '.pi/agent' }
$bindingDir = Join-Path $agentDir 'ludi-agent-kit'
New-Item -ItemType Directory -Force $bindingDir | Out-Null
$bindingPath = Join-Path $bindingDir 'models.local.json'
if (Test-Path $bindingPath) { throw '既存の対応付けを上書きせず、編集・マージしてください。' }
Copy-Item adapters/pi/models.local.example.json $bindingPath
pi --list-models
```

npm パッケージから利用する場合、コピー元はインストールされたパッケージ内の `adapters/pi/models.local.example.json` です。キットはユーザー領域の `models.local.json` を**読み取るだけ**で、書き込みません。ここに認証情報は保存しないでください。優先順位や移行方法は [Pi adapter: model selection（英語）](../adapters/pi/README.md#model-selection-flow) を参照してください。オーケストレータの実行前チェックは対応付けの有無だけを調べ、認証・利用枠までは確認しません。

native roles を使う場合は別依存を `pi install npm:pi-subagents` で明示導入します。キットの `pi.subagents.agents` manifest が可搬な生成 profiles を自動公開するため、**`sync-pi.ps1 -Apply` や手動 Junction は不要**です。Pi を再起動し `/ludi-doctor` と `/subagents-doctor` を確認してください。ユーザー/プロジェクト定義やモデル override は保持され、package roles は Pi/subagents のモデルを継承します。一方、キット orchestration は上記 capability bindings を使います。Pi 内の実行状態は npm package 内ではなく `<agent-dir>/ludi-agent-kit/` に保存します。旧リンク、複数導入元、dry-run 移行/復元、安全境界と検証範囲は[パッケージ導入・移行](pi-package.ja.md)を参照してください。以下の旧 sync はソース用の代替であり、package 導入後の手順ではありません。

## 実行する前に

ソースを取得したディレクトリで、モデルを起動せずに計画を確認できます。

```powershell
node scripts/orchestrate.mjs --dry-run "Fix the failing test"
```

実行すると外部モデルの利用枠を消費する場合があります。先に計画と [Orchestrator のオプション・安全上の注意（英語）](orchestrator.md) を確認してください。標準の rules planner は計画用モデルを呼びません。`--planner model` は任意の有料／外部呼び出しを伴い得ます。Pi の `ludi_orchestrate` ツールは履歴の保存、状態確認、判断への回答、再開にも対応します。

## ソースから利用する場合

外部モデルを呼ばずに検証できます。

```powershell
node scripts/validate.mjs
node --test (Get-ChildItem tests -Filter '*.test.mjs' | ForEach-Object FullName)
pwsh -NoProfile -File tests/test-sync-pi.ps1
pwsh -NoProfile -File adapters/pi/sync-pi.ps1  # dry-run。-Apply の前に内容を確認
pwsh -NoProfile -File scripts/check-environment.ps1
node scripts/check-pi.mjs                      # オフライン隔離スタートアップ/RPC 登録チェック
```

`scripts/check-pi.mjs`（ネイティブ Windows + pwsh + インストール済み Pi が必要）は一時的なエージェントディレクトリを作成し、`sync-pi.ps1 -Apply`（`-ApplySettings` ではない）で展開してから、インストール済み Pi をオフライン RPC モード（`--offline --no-mcp --no-session`）で起動し、`orchestrate` コマンド・3 つの `skill:*` コマンド・物理ターゲット・メッセージ/トークン/コストがゼロであること、そして期待されるキットのリンクと loop-guard 拡張エントリが一意であることを、チェック自身が所有する一時ディレクトリを使って検証します（`--keep-temp` で検査用に残せます）。同期処理はキット内の `adapters/pi/out/`（gitignored）にあるプレビューも更新しますが、実ユーザー設定は変更しません。プロンプト送信やモデル呼び出しは一切行いません。エージェント定義はキットとの構造比較で検証します。RPC にはエージェントレジストリや拡張フック数を問い合わせる公開手段がなく、別パッケージの pi-subagents はこのチェックでは導入・検証しません。実機の Pi に対しては `node scripts/check-pi.mjs --json` で実行してください。`tests/pi-startup.test.mjs` のユニットテストはモックのみを使用し、実チェックの合格を証明するものではありません。

`sync-pi.ps1` は標準では提案を `adapters/pi/out/` に生成します。`-Apply` は Junction と `AGENTS.md` を作成し、競合をバックアップします。`agents/ludi-agent-kit` Junction は `adapters/pi/out/agent-profiles/`（派生 pi-subagents プロファイル）を指します。pi-subagents の `tools:` は厳密な許可リストで `access:` を解釈しないため、承認済みの coder/tester ワーカーロールにだけ生成した policy 固定の shell-gate 拡張経由で `ludi_exec` が供給されます。それ以外のロールは `tools:`/frontmatter をそのまま保持し（例: browser は `powershell` を保持）、provider は付きません。生の `powershell`/`bash` は `ludi_exec` 経由でも一切許可しません。素の `agents/` を指す旧 Junction は conflict になるため `-BackupConflicts` で向きを変えてください。`auth.json` とモデルの認証情報は変更しません。`settings.json` は別途明示する `-ApplySettings` を付けた場合のみ変更されます。解決したモデルを `subagents.agentOverrides.{scout,coder,visual,reviewer}` の `model`/`thinking` だけにマージし（その他のフィールド・ロール・キーは保持）、元ファイルを `<AgentDir>/ludi-agent-kit/backup-*/settings.json` にバイト単位でバックアップし、JSON ラウンドトリップを検証し、計画取得後にファイルが変更されていれば拒否します。これは楽観的な競合検出であり、カーネルの compare-and-swap ではないため、同期実行中に settings.json を編集しないでください。反映には pi の再起動または `/reload` が必要です。project 設定や provider 別 override が優先される場合もあるため、`/subagents-models` で実効値を確認してください。

```powershell
pwsh -NoProfile -File adapters/pi/sync-pi.ps1                # まず提案を確認
pwsh -NoProfile -File adapters/pi/sync-pi.ps1 -ApplySettings # 明示した場合だけ4ロールのモデル設定を適用
```

その他の例:

```powershell
node scripts/context-pack.mjs context-pack/examples/example-fix.md --json
node scripts/resolve-capabilities.mjs routing/routing.json adapters/pi/models.json
node scripts/run-pipeline.mjs --repo <fixture-copy> --task "Fix the failing test" --dry-run
```

最後のコマンドはプレビューです。`--dry-run` を外すと scout → Context Pack → coder → テストを実行し、モデルを呼び出して対象リポジトリを書き換える可能性があります。生成物は `adapters/pi/out/` に保存されます。詳しくは [Phase 2 report（英語）](phase2-report.md) を参照してください。`node tests/e2e-real-pi.mjs` も任意実行の実モデルテストで、利用枠を消費します。

公開前には [Distribution checklist（英語）](distribution.md)、外部ツールについては [third-party dependencies（英語）](third-party.md) を参照してください。
