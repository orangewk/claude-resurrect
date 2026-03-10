# Changelog

## 1.0.3

- Fix: Windows 11 でゾンビセッションが残り続ける問題を修正（`wmic` → PowerShell に差し替え）

## 1.0.2

- Prune dead processes on startup — sessions whose OS process has died are marked inactive instead of resurrecting as zombies
- Record terminal PID and creation time for liveness verification (PID reuse safe)
- Add `Dump State (Debug)` command to inspect all session mappings in Output Channel

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
