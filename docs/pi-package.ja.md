# Pi パッケージの導入・移行

[English](pi-package.md) · [導入ガイド](getting-started.ja.md)

## 対応範囲

Pi **1.4.0**、pi-subagents **0.83.1**、Node **24.22.1**、ネイティブ Windows と PowerShell 7 で検証しています。Node は Pi/キットの `>=22.19.0` 要件を満たす必要があります。旧版での package-agent discovery は未保証のため、この基準へ更新してから利用してください。macOS/Linux、standalone Pi は今回未検証です。Windows の shell/media 機能には PowerShell や個別の任意依存が必要です。

確認した契約は、インストール済み Pi の README、`docs/packages.md`、`docs/extensions.md`、`docs/configuration.md`、`docs/settings.md`、`docs/cli.md` と、pi-subagents の `docs/agents.md`、`docs/extension-api.md`、公開 `pi-subagents/agents` 型定義です。Pi は `pi` の Skill/拡張を、pi-subagents は **`pi.subagents.agents`** の役割を検出します。Pi 本体に未確認の役割登録 API があるとは仮定していません。既存 orchestrator launcher の runtime 登録は別のプロセス内限定 API であり、配布する named roles の登録には使いません。

## 新規導入・更新

```powershell
pi install npm:@ludi-uni/ludi-agent-kit
pi install npm:pi-subagents  # 別依存。利用者が明示して導入
pi list
# Pi を再起動してから:
# /ludi-doctor
# /subagents-doctor
```

キットの導入元は npm、git、ローカルのうち **1 つ**で十分です。キットの導入処理は pi-subagents の自動導入、認証・役割 override・グローバル指示・モデル設定の変更を行いません。npm lifecycle script はありません。`sync-pi.ps1 -Apply` や手動 Junction は**パッケージ導入手順ではありません**。package roles は利用者の Pi/subagents モデルを継承し、未設定はモデルを呼ばずに診断します。`/ludi-doctor` はロード済み pi-subagents へ受動的に ping し、モデル選択の有無と配置診断を表示するだけです。ディスク上の依存の存在はロード成功の証明ではありません。resource filter や追加 scan/exclude 設定は `pi config` と `/subagents-doctor` でも確認してください。

固定していない導入は `pi update npm:@ludi-uni/ludi-agent-kit` の後に Pi を再起動します。検証済みの Pi では `pi update` 単独は Pi 本体の更新です。固定した版は自動で進まないため、必要な版を明示して `pi install` してください。`pi list` で導入元と版を確認します。ユーザー/プロジェクトの agent 定義が package roles より優先され、`subagents.agentOverrides` は保持されます。利用者の tool/model override は配布 policy を変更できます。shadowing の警告を独自定義削除の許可と解釈しないでください。

`coder` / `tester` だけが固定 policy の child-only provider と `ludi_exec` を取得し、生の `bash` / `powershell` は許可リストに入りません。他の役割は元の tools を保持し、新しい権限/provider は追加されません。shell-gate は command policy の検査であり **OS sandbox ではありません**。許可されたテスト/build はプロセス権限でリポジトリのコードを実行するため、作業対象とコマンドを信頼できることが前提です。悪意ある repository code や利用者 override を隔離しません。

Pi 内の orchestration は `<agent-dir>/ludi-agent-kit/state.db` と `activity/clients/` に状態を保存し、インストールされたパッケージ内には書きません。`<agent-dir>` は `PI_CODING_AGENT_DIR`、未指定時は `~/.pi/agent` です。明示 `store` / `LUDI_ORCHESTRATION_STORE` も使えますが、package 内のパス（既存 Junction 経由も含む）は拒否します。ソース用 CLI のプレビューや旧 sync は checkout 内 `out/` を生成するため、npm 配置内ではなく書込み可能なソースで実行してください。

## 読取り専用の診断

`$kit` は `pi list` で確認した導入済み package、または checkout のルートです。空白・日本語を含むパスも使えます。

```powershell
node "$kit/adapters/pi/package.mjs" doctor
node "$kit/adapters/pi/package.mjs" doctor "--agent-dir=$agentDir" "--project-dir=$projectDir"
```

標準の agent directory は `PI_CODING_AGENT_DIR` に従います。旧 local/npm 宣言、解決できない参照、切れたリンク、旧リンク、独自役割/名前競合、モデル/依存の未確認を報告します。auth を読んだり settings の内容を出力したりしません。ただし JSON にはローカルパスを含むため、公開前に確認してください。これは filesystem 診断であり host inventory の完全な代替ではありません。git/local 依存、resource filter、親ディレクトリの project 設定、任意の追加 scan root は Pi でも確認してください。警告がなくても認証・利用枠を保証しません。

## 明示的な旧リンク移行・復元

1. 診断と `pi list` を読み、導入元を 1 つ選びます。不要な**正確な宣言**を Pi の `pi remove <source>`（project は `--local`）で外し、必要なら採用する導入元を install します。helper は settings を書き換えず、ソース本体も削除しません。切れた/不明な参照は手動レビューします。
2. 旧 `agents/ludi-agent-kit` が生の `agents/` を指していると、安全な package profiles より優先されます。旧 Skill/拡張リンクも二重登録の原因になります。**選択した 1 リンク**の退避を先に確認します。

   ```powershell
   node "$kit/adapters/pi/package.mjs" migrate --entry=agents/ludi-agent-kit "--expect-target=$oldTarget"
   # その entry/target を承認した場合だけ:
   node "$kit/adapters/pi/package.mjs" migrate --entry=agents/ludi-agent-kit "--expect-target=$oldTarget" --apply
   ```

   許可 slot は `agents/ludi-agent-kit`、`extensions/ludi-agent-kit`、`extensions/ludi-orchestrator`、`skills/pi-workflow`、`skills/project-management`、`skills/visual-verification` のみです。target の一致と上位の kit `package.json` による所有確認が必要です。独自ファイル/通常ディレクトリ、相対リンク、リンクされた親ディレクトリ、所有確認できない切れた target は拒否します。再帰削除や target 本体の変更はしません。`agents` 全体が旧 Junction の場合、無理に helper を通さず手動で範囲を確認してください。
3. リンク自体を `<agent-dir>/ludi-agent-kit/migrations/<backup-id>/link` へ rename し、復元 manifest と返された ID を保持します。backup は役割として走査せず、自動削除もしません。復元も標準は preview で、元の場所に何かあれば上書きせず拒否します。

   ```powershell
   node "$kit/adapters/pi/package.mjs" restore --backup-id=<backup-id>
   node "$kit/adapters/pi/package.mjs" restore --backup-id=<backup-id> --apply
   ```

4. Pi を再起動し、`/ludi-doctor`、`/subagents-doctor` と実効 role/model を確認します。復元は旧リンクとその shadowing を戻すだけで、npm の版やモデル設定を巻き戻しません。移行中は Pi や他の設定 editor を停止してください。複数プロセスを横断する設定 transaction ではありません。旧生成 `AGENTS.md` や無関係な codex-setting リンクは helper の変更範囲外です。

## 配布生成・検証

共通 `agents/*.md` を編集後、`node adapters/pi/build-profiles.mjs` を明示実行します。追跡対象の `adapters/pi/generated/agent-profiles/` を npm/git に配布し、`--check` で古い/余分な生成物を読取り専用で検出します。install/startup での生成はありません。相対 provider import は package 全体の移動後も解決します。生成物/旧出力は kit 内 `adapters/pi/{generated,out}/agent-profiles/` に置く必要があり、profiles 単体のコピーには対応しません。

実際の `npm pack` を隔離 install/update/移行し、公開 preflight での役割検出、実 provider の許可/禁止、依存不在/モデル未設定時の起動、日本語・空白パス、使用量ゼロ、package 内容不変を検査する手順は [Distribution checklist（英語）](distribution.md) を参照してください。
