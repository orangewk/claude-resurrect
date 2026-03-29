# Terminal Session Recall

> Unofficial VSCode extension — Automatically restore Claude Code CLI sessions after restart

![Demo](art/demo.gif)

![UI Overview](art/ui-overview.png)

## Features

- Status bar shows live and idle session counts for the current project
- QuickPick session manager: start new sessions, resume interrupted or completed sessions
- Automatically restores interrupted sessions when VSCode restarts
- Reset stale sessions — clear "active" entries whose terminal no longer exists
- Diagnostic logging in the Output panel (channel: "TS Recall") for troubleshooting

## Requirements

- Claude Code CLI must be installed and available on your PATH

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| claudeResurrect.autoRestore | true | Automatically restore interrupted sessions on startup |
| claudeResurrect.autoRestoreMaxAge | 24 | Maximum age (hours) of sessions to auto-restore |
| claudeResurrect.claudePath | "claude" | Path to the Claude CLI executable |

## Limitations

- **Only sessions started through this extension are fully tracked.** The status bar "live" count and auto-restore only cover sessions launched via the QuickPick menu or auto-restore. Sessions started manually in a terminal (e.g., `claude` or `claude --resume`) are not tracked as "live" — they may appear as idle in the session list even while running.
- **This extension does not manage session data.** It only reads what Claude CLI creates. Sessions with no conversation (e.g., opened and immediately closed) are excluded from the session list, but cannot be deleted by this extension.
- **Read-only by design.** Deleting or modifying `~/.claude/` data is out of scope. Use Claude CLI directly to manage session history.
- **WSL2 terminals are not fully supported.** Shell integration does not reliably activate in WSL2 terminals, which can cause session restore commands to be sent before the shell is ready. If you need session persistence in WSL2, consider using tmux or similar terminal multiplexers instead. See [#63](https://github.com/orangewk/terminal-session-recall/issues/63) for details.

## Data Access

This extension reads the following from `~/.claude/`:

- **`history.jsonl`** — session history (session ID, project path, first prompt, timestamp)
- **Directory listing** of `projects/<slug>/` (file names only, to locate session files)
- **File size** of session JSONL files via `stat()` (content is not read)

This extension does NOT:

- Write to `~/.claude/` (read-only access)
- Read authentication tokens or API keys
- Parse full conversation history
- Send any data over the network
- Collect telemetry

### How we enforce this

- All `~/.claude/` access is isolated in a single read-only module (`claude-dir.ts`)
- CI checks block PRs that introduce write APIs or network calls outside allowed modules
- The extension is open source — you can audit the code

---

## 日本語

> 非公式 VSCode 拡張 — Claude Code CLI のセッションを VSCode 再起動後に自動復元

![デモ](art/demo.gif)

![UI 概要](art/ui-overview-ja.png)

### 機能

- ステータスバーにプロジェクトごとのセッション数を表示（live / idle）
- Quick Pick メニューでセッション管理：新規作成、中断・完了セッションの再開
- VSCode 再起動時に中断セッションを自動復元
- ステイルセッションのリセット — ターミナルが消失した "active" エントリを手動クリア
- 「出力」パネルでの診断ログ（チャンネル: "TS Recall"）でトラブルシューティング

### 前提条件

- Claude Code CLI がインストール済みで PATH に通っていること

### 設定

| 設定 | デフォルト | 説明 |
|------|-----------|------|
| claudeResurrect.autoRestore | true | 起動時に中断セッションを自動復元 |
| claudeResurrect.autoRestoreMaxAge | 24 | 自動復元の最大経過時間（時間） |
| claudeResurrect.claudePath | "claude" | Claude CLI のパス |

### 制限事項

- **追跡できるのは、この拡張経由で起動したセッションのみ。** ステータスバーの "live" カウントや自動復元は、QuickPick メニューまたは自動復元で起動したセッションだけが対象。ターミナルで手動起動した `claude` セッションは "live" として追跡されないため、実行中でも idle として一覧に表示されることがある。
- **セッションデータの管理は行わない。** CLI が作成したデータを読み取るだけ。会話が発生していないセッションは一覧に表示されない。
- **読み取り専用。** `~/.claude/` への書き込み・削除は行わない。セッション履歴の管理は Claude CLI 側で行う。
- **WSL2 ターミナルは完全にはサポートされていない。** WSL2 ではシェル統合（Shell Integration）が正常に発火しない場合があり、シェル準備完了前に復元コマンドが送信されることがある。WSL2 でセッション永続化が必要な場合は tmux 等のターミナルマルチプレクサの利用を推奨。詳細は [#63](https://github.com/orangewk/terminal-session-recall/issues/63) を参照。

### データアクセス

`~/.claude/` から以下を読み取り専用で参照:

- **`history.jsonl`** — セッション履歴（セッション ID、プロジェクトパス、最初のプロンプト、タイムスタンプ）
- **`projects/<slug>/`** のディレクトリ一覧（ファイル名のみ）
- **セッション JSONL ファイル**のサイズ（`stat()` のみ、内容は読まない）

この拡張が **行わないこと**:

- `~/.claude/` への書き込み
- 認証トークン・API キーの参照
- 会話内容の読み取り
- ネットワーク通信
- テレメトリ収集

## License

MIT
