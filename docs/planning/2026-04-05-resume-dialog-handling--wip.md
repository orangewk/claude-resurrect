# Claude CLI resume ダイアログ対応

## 要件の再確認

Claude CLI v2.1.90+ で、大きいセッションの `--resume` / `--continue` 時にインタラクティブダイアログが表示されるようになった。

```
This session is 7d 4h old and 101k tokens.

Resuming the full session will consume a substantial portion of your usage
limits. We recommend resuming from a summary.

❯ 1. Resume from summary (recommended)
  2. Resume full session as-is
  3. Don't ask me again
```

- 数字キー `1`, `2`, `3` で選択可能（`sendText("1")` で動作確認済み）
- `~/.claude.json` の `resumeReturnDismissed: true` で非表示にできる
- 閾値不明（トークン数 + 経過時間ベース。100k tokens / 7d で表示確認）

### 問題

本拡張は `terminal.sendText("claude --resume <id>")` で復元するが、ダイアログへの応答機能がない。
→ 入力待ちブロック → **CPU 25% 食い続ける**

## 技術調査

### ターミナル出力の読み取り方法

| API | 利用可否 | 備考 |
|-----|---------|------|
| `TerminalShellIntegration.executeCommand()` + `read()` | ✅ 推奨 | Shell Integration 有効時のみ。出力ストリームを async iterable で読める |
| `terminal.sendText()` | 現状使用中 | 出力を読めない。ダイアログ対応不可 |

**方針**: `shellIntegration.executeCommand()` に移行する。Shell Integration が無効な環境では `sendText()` にフォールバックし、タイムアウトで保護する。

### executeCommand + read の流れ

```typescript
// Shell Integration 待ち
window.onDidChangeTerminalShellIntegration(({ terminal, shellIntegration }) => {
  const execution = shellIntegration.executeCommand(`claude --resume ${sessionId}`);
  const stream = execution.read();
  for await (const data of stream) {
    if (data.includes("Resume from summary")) {
      // ダイアログ検知 → 応答
      terminal.sendText("1"); // or "2"
      break;
    }
  }
});
```

### フォールバック（Shell Integration なし）

```typescript
setTimeout(() => {
  if (!terminal.shellIntegration) {
    terminal.sendText(`claude --resume ${sessionId}`);
    // ダイアログ対応不可 → タイムアウト後に警告
  }
}, 3000);
```

## 実装計画

### Phase 1: ターミナル出力監視 + ダイアログ自動応答

**変更ファイル**: `src/extension.ts`

1. `resumeSession()` を `executeCommand()` ベースに書き換え
   - Shell Integration 待ち（`onDidChangeTerminalShellIntegration`）
   - タイムアウト付き（3秒で fallback to `sendText`）
2. `read()` ストリームでダイアログ検知
   - 検知パターン: `"Resume from summary"` を含む出力
   - autoRestore 時: 設定に従い `sendText("1")` or `sendText("2")`
   - 手動 resume 時（`"ask"` 設定）: VSCode QuickPick を表示 → ユーザー選択 → `sendText`
3. `continue` アクション（QuickPick の "Continue Last"）にも同様の監視を追加

### Phase 2: 設定追加

**変更ファイル**: `package.json`

```json
"claudeResurrect.resumeDialogAction": {
  "type": "string",
  "enum": ["summary", "full", "ask"],
  "default": "summary",
  "description": "How to handle Claude CLI's resume dialog: 'summary' auto-selects Resume from summary, 'full' auto-selects Resume full session, 'ask' shows a VS Code picker"
}
```

### Phase 3: 堅牢性

CLI 仕様変更（文字列変更・ダイアログ廃止）時にハングしないための保護:

1. **ストリーム読み取りタイムアウト**: `read()` 開始から N 秒以内にダイアログ検知できなければ「ダイアログなし」と判断して監視終了
   - ダイアログが廃止された場合 → タイムアウトで正常終了
   - 文字列が変わった場合 → 同上（ハングしない）
2. **Shell Integration フォールバック**: WSL2 等で Shell Integration が効かない環境では `sendText()` にフォールバック
3. **検知パターンの緩さ**: 完全一致ではなく部分一致（`"Resume from summary"` or `"resume"` + `"summary"` の組み合わせ）
4. **ログ出力**: 検知・応答・タイムアウトすべてログに記録

## 影響範囲

| ファイル | 変更内容 |
|---------|---------|
| `src/extension.ts` | `resumeSession()` の実行方式変更、ダイアログ監視ロジック追加 |
| `package.json` | `claudeResurrect.resumeDialogAction` 設定追加 |
| `src/types.ts` | 必要に応じて型追加 |

## リスク

| レベル | リスク | 対策 |
|--------|--------|------|
| **HIGH** | Shell Integration が有効にならない環境（WSL2等）ではダイアログ対応不可 | sendText フォールバック + タイムアウト保護。README で注記 |
| **MEDIUM** | CLI のダイアログ文言が変わる | 部分一致検知 + タイムアウトで保護。ハングはしない |
| **MEDIUM** | `executeCommand()` への移行で既存の動作が変わる | Shell Integration 待ちのタイムアウトで従来の sendText にフォールバック |
| **LOW** | `read()` ストリームが大量データを返す | ダイアログ検知後すぐ break。タイムアウトでも打ち切り |

## 複雑度: 中

`executeCommand` + `read` への移行が主な変更。ダイアログ検知ロジック自体はシンプル。

## 確認事項（ユーザーへ）

1. **デフォルト値**: `resumeDialogAction` のデフォルトは `"summary"` でよいか？
2. **タイムアウト秒数**: ダイアログ検知のタイムアウトは何秒が適切か？（提案: 15秒 — CLI の起動 + workspace trust 等を考慮）
3. **Shell Integration 前提への移行**: `engines.vscode` は現在 `^1.96.0`。`executeCommand` は 1.93+ で使用可能なので問題なし
