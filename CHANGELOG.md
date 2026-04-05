# Changelog

## 1.1.0 (pre-release)

> **Beta**: Claude CLI v2.1.90+ のダイアログ変更への緊急対応。ターミナル出力のパターンマッチに依存しており、動作が不安定になる可能性があります。

- Add: Claude CLI v2.1.90+ の resume ダイアログ（"Resume from summary" / "Resume full session"）を検知し自動応答 (#92)
- Add: `resumeDialogAction` 設定 — `summary`（デフォルト）/ `full` / `ask` で応答を制御
- Add: Shell Integration `executeCommand` + `read()` によるターミナル出力監視（Shell Integration 無効時は `sendText` フォールバック）
- Add: 15 秒タイムアウト保護 — CLI のダイアログ文言変更・廃止時にもハングしない

## 1.0.8

- Revert: WSL2 対策の sendTextWhenReady 遅延処理を削除 — 根本原因は起動スクリプトのクォーテーション差異であり、遅延は不要かつ動作を阻害していた (#77)

## 1.0.7

- Docs: README にデモ GIF を追加（Marketplace ストアページ用）

## 1.0.6

- Fix: conversation data なしセッションが active のまま残り、毎起動時に警告が繰り返される問題を修正 (#64)
- Fix: WSL2 環境で sendText が早すぎてシェルパースエラーになる問題を改善 — 3 段フォールバック（Shell Integration → shell type 検出+遅延 → 15s タイムアウト）に変更 (#63)
- Add: QuickPick に「Reset Stale Sessions」アクションを追加 — ターミナルが消失した active セッションを手動リセット可能に (#62)
- Add: LogOutputChannel によるランタイムログ出力（「出力」パネル → TS Recall で確認可能）

## 1.0.5

- Fix: WSL2 環境で autoRestore 時にシェル構文エラーが発生する問題を修正（Shell Integration API でシェル ready を待機）

## 1.0.4

- Fix: Full Close → Restart 後に autoRestore が動作しない問題を修正（pruneDeadProcesses との実行順序を修正）

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
