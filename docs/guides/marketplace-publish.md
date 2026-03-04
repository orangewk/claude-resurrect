# Marketplace 公開手順

## 前提

- Publisher: `orange-creatives`
- PAT: `.vsce-pat` ファイルの `VSCE_PAT` に保存済み（`.gitignore` 済み）
- PAT 期限切れ時の再発行: Azure DevOps → User Settings → Personal Access Tokens（スコープ: Marketplace → Publish）

## 手順

```bash
cd /c/dev/terminal-session-recall

# 1. ソース修正が main にマージ済みであることを確認
git checkout main && git pull

# 2. バージョンを上げる（package.json の version フィールド）
# 例: "version": "0.1.4" → "0.1.5"

# 3. コミット & プッシュ
git add package.json
git commit -m "chore: bump version to 0.1.5"
git push origin main

# 4. ビルド & 公開（.vsce-pat から PAT を読み込む）
npm run compile
source .vsce-pat
npx @vscode/vsce publish --pat "$VSCE_PAT"
```

## 注意

- **`@vscode/vsce` を使う**: `npx vsce publish`（`@vscode/` なし）だと古い vsce で PAT 認証に失敗する場合がある
- **ビルド忘れ注意**: ソース修正後は `npm run compile` を必ず実行してから publish すること。0.1.3 でビルド忘れ事故あり
