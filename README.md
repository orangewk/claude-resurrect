# Terminal Session Recall

> Unofficial VSCode extension — Automatically restore Claude Code CLI sessions after restart

## Features

- Status bar shows live and idle session counts for the current project
- QuickPick session manager: start new sessions, resume interrupted or completed sessions
- Automatically restores interrupted sessions when VSCode restarts

## Requirements

- Claude Code CLI must be installed and available on your PATH

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| claudeResurrect.autoRestore | true | Automatically restore interrupted sessions on startup |
| claudeResurrect.autoRestoreMaxAge | 24 | Maximum age (hours) of sessions to auto-restore |
| claudeResurrect.claudePath | "claude" | Path to the Claude CLI executable |

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

## License

MIT
