---
name: vsix-publish
description: VS Code Marketplace への拡張パブリッシュ。品質ゲート → バージョン更新 → CHANGELOG → ビルド → 公開 → タグの一連を実行。
---

# /vsix-publish コマンド

Terminal Session Recall を VS Code Marketplace に公開する。

## 前提

- main ブランチにすべての変更がマージ済みであること
- `.vsce-pat` に `VSCE_PAT` が設定済みであること（`.gitignore` 済み）

## 手順（Claude が実行する）

### 1. 品質ゲート

```bash
cd /c/dev/terminal-session-recall
git checkout main && git pull
npm run typecheck && npm run test && npm run compile
```

すべて通らなければ中止。

### 2. バージョン決定

- 引数でバージョンが指定されていれば使う（例: `/vsix-publish 1.1.0`）
- 未指定なら `package.json` の現バージョンから patch を +1 して提案し、ユーザー確認を待つ

### 3. バージョン更新 + CHANGELOG

- `package.json` の `version` を更新
- `CHANGELOG.md` に新バージョンのセクションを追加（直近のコミットから変更内容を要約）
- ユーザーに内容を確認してもらう

### 4. コミット + push

```bash
git add package.json CHANGELOG.md
git commit -m "chore: publish v<VERSION>"
git push
```

### 5. ビルド + パブリッシュ

```bash
npm run compile
source .vsce-pat
npx @vscode/vsce publish --pat "$VSCE_PAT"
```

### 6. タグ

```bash
git tag v<VERSION>
git push origin v<VERSION>
```

### 7. 完了報告

バージョン番号と Marketplace URL を報告する。

## 注意事項

- **`@vscode/vsce` を使う**: `npx vsce publish`（`@vscode/` なし）だと古い vsce で PAT 認証に失敗する
- **ビルド忘れ注意**: `npm run compile` を必ず実行してから publish する（0.1.3 でビルド忘れ事故あり）
- **`code --install-extension` は信頼しない**: Claude Code のターミナルから実行すると別プロファイルに入る場合がある。ローカル確認は VS Code の `Install from VSIX...` UI を使う
