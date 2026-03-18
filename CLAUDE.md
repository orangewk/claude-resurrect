# Claude Resurrect — Claude Code 設定

## プロジェクト概要

VSCode 再起動時に Claude Code CLI セッションを自動復元する拡張機能。セッションプリセット、プロセス検査（Linux）、ターミナルリネーム同期、マルチユーザー操作をサポート。

## 開発コマンド

```bash
npm run typecheck  # 型チェック
npm run test       # Vitest テスト
npm run compile    # ビルド（esbuild で out/ に出力）
npm run watch      # ファイル変更監視 + 自動ビルド
npm run package    # .vsix パッケージ作成
```

**品質ゲート**（作業完了前に必ず実行）: `npm run typecheck && npm run test && npm run compile`

**VSIX ビルド**（Node 20 必須）: `bash -l -c "nvm exec 20 npx @vscode/vsce package"`

## アーキテクチャ

### ~/.claude/ アクセス制約

- `claude-dir.ts` と `process-inspector.ts` が `~/.claude/` にアクセスする唯一のモジュール
- 他のモジュールから fs で直接 `~/.claude/` に触ることを禁止
- 読み取り専用のみ。書き込み API は一切使用しない

### 主要モジュール

| ファイル | Vitest テスト可能 | 役割 |
|---------|:-:|------|
| claude-dir.ts | Yes | セッション探索、履歴読み取り、表示情報抽出 |
| process-inspector.ts | Yes | Linux procfs ベースの Claude プロセス検出（セッション ID、CWD、ユーザー、引数） |
| session-store.ts | Yes | インメモリセッションストア、永続化コールバック（DI） |
| normalize-path.ts | Yes | 純粋パス正規化関数 |
| extension.ts | No | メイン拡張：コマンド、QuickPick、ステータスバー、ターミナルライフサイクル（F5 デバッグ） |
| preset-webview.ts | No | Webview プリセットマネージャーパネル（F5 デバッグ） |

### セッションストア

- `getByProject()` は `startsWith` プレフィックスマッチング — ワークスペースルートからサブディレクトリのマッピングも検索可能
- `pruneDeadProcesses()` は `process-check.ts` 経由で PID を確認し、死んだアクティブセッションを inactive に変更
- `pruneExpired()` は 336 時間（14 日）より古いエントリを削除

### デバッグログ

- 拡張は Output Channel「TS Recall Log」に `[タグ]` プレフィックス付きでログを出力
- 主要タグ: `[status-bar]`、`[rename-poll]`、`[terminal-open]`、`[terminal-close]`、`[init]`、`[adopt]`

## コーディングスタイル

- TypeScript strict
- イミュータブル操作（spread で新オブジェクト作成）
- `any` 禁止（`unknown` を使う）
