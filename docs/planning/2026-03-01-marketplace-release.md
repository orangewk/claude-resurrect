# マーケットプレイス公開計画

## 背景

セッション管理の再設計（PR #8）が完了。F5 テストで基本動作は確認済み。
マーケットプレイス公開前にドッグフーディング期間を設けて品質を担保する。

## フェーズ

### Phase 1: ローカルインストール + ドッグフーディング（〜1 週間）

**目的**: 実使用で問題を洗い出す

1. `npm run package` で `.vsix` を生成
2. `code --install-extension claude-resurrect-0.1.0.vsix` でインストール
3. 普段の開発で使い、以下を観察:
   - セッションが正しく追跡されるか
   - VSCode 再起動後に active セッションが自動復元されるか
   - Quick Pick の表示が正しいか（live/idle カウント、セクション分類）
   - history.jsonl が大量にあるときのパフォーマンス
   - 複数ワークスペースでの動作
4. 発見した問題は Issue に起票、修正してから次のフェーズへ

### Phase 2: マーケットプレイス準備

**目的**: 公開に必要なアセットを揃える

| アセット | 状態 | 備考 |
|---------|------|------|
| README.md | 未作成 | 機能説明、スクリーンショット、インストール手順 |
| CHANGELOG.md | 未作成 | v0.1.0 の変更内容 |
| LICENSE | 未作成 | MIT（package.json に宣言済み） |
| アイコン | 未作成 | 128x128 PNG、マーケットプレイス表示用 |
| package.json `icon` フィールド | 未設定 | アイコンファイルへのパス |
| package.json `categories` | `Other` | 必要に応じて見直し |
| `.vscodeignore` | 未作成 | src/、docs/ 等を .vsix から除外 |

### Phase 3: マーケットプレイス公開

**目的**: 公開して利用可能にする

1. Azure DevOps で Personal Access Token を取得
2. `vsce login orangewk`
3. `vsce publish --pre-release`（初回は pre-release 推奨）
4. マーケットプレイスで表示確認
5. GitHub リポの README にマーケットプレイスバッジを追加

## 複雑度: 低

コード変更はほぼなく、ドキュメント・アセット準備が中心。
