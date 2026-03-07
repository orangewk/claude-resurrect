# Changelog

## 1.0.0

- Focus active terminal from QuickPick instead of opening a duplicate
- Fix session duplication when terminal is dragged to another window
- Custom title (`/title`) support in session list
- Session deduplication by sessionId in QuickPick

## 0.1.0

- Status bar showing live / idle session counts per project
- Quick Pick session manager: new session, continue last, resume past sessions
- Auto-restore interrupted sessions on VSCode restart
- Session discovery from `~/.claude/history.jsonl`
- File size and first prompt display in session list
- `isTransient` terminals — no ghost terminals after restart
