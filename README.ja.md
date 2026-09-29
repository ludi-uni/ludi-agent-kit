# ludi-agent-kit

[English README](README.md)

Windows を中心に、複数の AI コーディングエージェントを扱うためのキットです。**Pi** を主な実行環境とし、Codex・ローカルモデルなどをバックエンドとして切り替えます。開発が凍結された `codex-setting` の後継です。

## まず読む資料

| やりたいこと | 案内 |
| --- | --- |
| Pi に導入し、モデルを設定する | [導入ガイド](docs/getting-started.ja.md) |
| ソースから利用し、検証する | [導入ガイド: ソースから利用](docs/getting-started.ja.md#ソースから利用する場合) |
| オーケストレーションを実行する | [Orchestrator（英語）](docs/orchestrator.md) |
| 構成や設定を詳しく知る | [Architecture（英語）](docs/architecture.md) · [Pi adapter（英語）](adapters/pi/README.md) |
| 公開前の確認をする | [Distribution checklist（英語）](docs/distribution.md) |

```powershell
pi install npm:@ludi-uni/ludi-agent-kit
pi list
```

Pi への導入で `pi-workflow`、`project-management`、`visual-verification` の各 Skill と、loop guard・`ludi_orchestrate` 拡張が読み込まれます。**実際にエージェントを動かす前に、モデルの対応付けを別途設定してください。** `npm install` だけでは Pi にリソースが登録されません。Git からは `pi install git:github.com/ludi-uni/ludi-agent-kit` でも導入できます。安全な手順、更新方法、検証コマンドは[導入ガイド](docs/getting-started.ja.md)にまとめています。

## 基本構成

- エージェントはモデル名ではなく **capability** を指定します。`routing/` がバックエンドを選び、`adapters/pi/` が Pi のプロバイダー・モデルに対応付けます。
- [Context Pack](context-pack/SPEC.md) は、リポジトリ全体ではなく必要な情報をモデルへ渡す仕組みです。
- `orchestration/` と `lib/orchestrator/` が計画・委譲・検証・実行履歴の保存を担当します。実行にはモデル利用枠を消費する場合があるため、先に[計画を確認](docs/getting-started.ja.md#実行する前に)してください。
- `rules/`、`skills/`、`agents/`、`routing/`、`context-pack/` は共通の知識です。具体的なプロバイダーやインストール先の設定は `adapters/<backend>/` に置きます。

対応範囲と制限は [roadmap（英語）](docs/roadmap.md)、外部ツールの条件は [third-party dependencies（英語）](docs/third-party.md) を参照してください。このリポジトリは MIT ライセンスです（[LICENSE](LICENSE)）。
