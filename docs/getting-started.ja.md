# 導入ガイド

[English](getting-started.md) · [日本語 README](../README.ja.md)

## 必要な環境

**Pi パッケージとして利用する場合**は、対応する Pi と、認証済みのプロバイダーが必要です。実行するモデルの ID と利用枠も確認してください。**ソースから利用する場合**は、Windows・PowerShell 7・Git・`node:sqlite` 対応の Node.js が必要です（Node 24 で検証）。基本スクリプトに `npm install` は不要です。

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
Copy-Item adapters/pi/models.local.example.json (Join-Path $bindingDir 'models.local.json')
pi --list-models
```

npm パッケージから利用する場合、コピー元はインストールされたパッケージ内の `adapters/pi/models.local.example.json` です。キットはユーザー領域の `models.local.json` を**読み取るだけ**で、書き込みません。ここに認証情報は保存しないでください。優先順位や移行方法は [Pi adapter: model selection（英語）](../adapters/pi/README.md#model-selection-flow) を参照してください。オーケストレータの実行前チェックは対応付けの有無だけを調べ、認証・利用枠までは確認しません。

`pi-subagents` は別パッケージです。Pi への導入だけでは `agents/*.md` を pi-subagents の役割として自動登録しません。必要なら別途導入・設定してください。`sync-pi.ps1` は**ソースから利用する場合の代替手段**であり、インストール後の必須操作ではありません。二重登録を確認せず同じパッケージに `-Apply` しないでください。

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
```

`sync-pi.ps1` は標準では提案を `adapters/pi/out/` に生成します。`-Apply` は Junction と `AGENTS.md` を作成し、競合をバックアップします。`settings.json`、`auth.json`、モデルの認証情報は変更しません。その他の例:

```powershell
node scripts/context-pack.mjs context-pack/examples/example-fix.md --json
node scripts/resolve-capabilities.mjs routing/routing.json adapters/pi/models.json
node scripts/run-pipeline.mjs --repo <fixture-copy> --task "Fix the failing test" --dry-run
```

最後のコマンドはプレビューです。`--dry-run` を外すと scout → Context Pack → coder → テストを実行し、モデルを呼び出して対象リポジトリを書き換える可能性があります。生成物は `adapters/pi/out/` に保存されます。詳しくは [Phase 2 report（英語）](phase2-report.md) を参照してください。`node tests/e2e-real-pi.mjs` も任意実行の実モデルテストで、利用枠を消費します。

公開前には [Distribution checklist（英語）](distribution.md)、外部ツールについては [third-party dependencies（英語）](third-party.md) を参照してください。
