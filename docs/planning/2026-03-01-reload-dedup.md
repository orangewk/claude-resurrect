# Reload Window 時のターミナル二重生成防止

## 経緯

### 問題の発見

`isTransient: true`（PR #15）で VSCode 完全終了→再起動のゴーストターミナルは解消した。
しかし **Reload Window** では別の経路で二重生成が発生することが判明。

### なぜ起きるか

Reload Window の挙動は Full Close とは異なる:

| | Full Close → Restart | Reload Window |
|---|---|---|
| ターミナルプロセス | 死ぬ | **メモリ上で生存** |
| `isTransient` の効果 | 復元されない ✅ | 関係ない（永続化ではなくメモリ保持） |
| `onDidCloseTerminal` | 発火しない | **発火しない** |
| globalState の状態 | `active` のまま | `active` のまま |
| `autoRestoreSessions` | 新規作成（正常） | 新規作成（**二重**） |

結果: 元のターミナル（生存中）+ auto-restore が作った新規ターミナル = 同じセッションが 2 つ。

## 要件

- Reload Window 後に同じセッションのターミナルが二重に存在しないこと
- Full Close → Restart の auto-restore 動作は維持すること

## 設計

### アプローチ

`autoRestoreSessions` の中で、ターミナル作成前に `vscode.window.terminals` を確認する。
既に同名のターミナルが存在していればスキップし、globalState を `active` のまま保つ。

```typescript
async function autoRestoreSessions(...): Promise<void> {
  const active = store.getActive(projectPath);
  if (active.length === 0) return;

  const existingNames = new Set(vscode.window.terminals.map(t => t.name));

  let restored = 0;
  for (const mapping of active) {
    if (existingNames.has(mapping.terminalName)) continue; // Reload: skip
    const displayName = mapping.firstPrompt ?? mapping.sessionId.slice(0, 8);
    await resumeSession(store, mapping.sessionId, displayName, projectPath, onUpdate);
    restored++;
  }

  if (restored > 0) {
    vscode.window.showInformationMessage(
      `Claude Resurrect: Restored ${restored} interrupted session(s).`,
    );
  }
}
```

### 変更点

1. **二重生成防止**: `existingNames.has()` で既存ターミナルとの重複チェック追加
2. **通知メッセージのバグ修正**: 現コードは `active.length`（スキップ含む全数）を表示しているが、`restored`（実際に作成した数）に修正する

### ターミナル名の遷移と比較の成立根拠

`startNewSession` は `"Claude #N"` で命名し、`resumeSession` は `"Claude: <displayName>"` で命名する。
`resumeSession` は `store.upsert()` で `terminalName` を上書き保存する。

つまり:
1. ユーザーが `startNewSession` で `"Claude #1"` を作る → globalState に `terminalName: "Claude #1"` 保存
2. Full Close → Restart → `autoRestoreSessions` → `resumeSession` が `"Claude: <firstPrompt>"` で新ターミナル作成 → globalState の `terminalName` が `"Claude: <firstPrompt>"` に上書き
3. 以降の Reload Window では `vscode.window.terminals` に `"Claude: <firstPrompt>"` が存在 → globalState の `terminalName` と一致 → スキップ成立

初回 Full Close → Restart 後の最初の Reload で名前遷移が起きるが、`resumeSession` が `upsert` で名前を同期するため、比較は常に成立する。

### なぜこれで正しいか

| シナリオ | `existingNames` にマッチ | 動作 |
|---|---|---|
| Reload Window | ✅（元ターミナルが生存） | スキップ → 二重防止 |
| Full Close → Restart | ❌（ターミナルなし） | 新規作成 → 正常復元 |
| Reload 後に手動でターミナル閉じた | ❌ | `onDidCloseTerminal` で inactive 化 → 次回 auto-restore 対象外 |

### エッジケース

- **ユーザーがターミナル名を変更した場合**: マッチしない → 新規作成される（二重になるが、手動操作の結果なので許容）
- **名前の衝突**: 拡張が作ったターミナル名と同じ名前の手動ターミナルがある場合 → スキップされる（false positive だが実害は低い。次回 Quick Pick から再開可能）

## 実装前検証（ブロッカー）

設計全体が「Reload 後の `activate()` 時点で `vscode.window.terminals` にターミナルが列挙されている」ことを前提とする。
この前提を実機で検証する:

```typescript
// activate() 冒頭に一時的に追加
console.log('terminals at activate:', vscode.window.terminals.map(t => t.name));
```

- **列挙される** → 設計通り実装可能
- **空** → `onDidOpenTerminal` で遅延チェック、または `setTimeout` 後に再確認するフォールバックが必要

## リスク

| リスク | 影響 | 対策 |
|--------|------|------|
| `vscode.window.terminals` が activate 時点で空 | Reload なのに新規作成してしまう | **実装前に検証**（上記ブロッカー） |
| 名前の false positive | auto-restore がスキップされる | 実害低。Quick Pick から手動で再開可能 |

## 複雑度: 低

`autoRestoreSessions` 内の変更 + 通知メッセージ修正。globalState の構造変更なし。差し戻し容易。

---

## 批評レビュー結果

| 指摘 | 対応 |
|------|------|
| `resumeSession` が `terminalName` を上書きすることへの言及がない | 「ターミナル名の遷移と比較の成立根拠」セクションを追加 |
| `active.length` → `restored` の変更がバグ修正であることが不明確 | 「変更点」セクションにバグ修正として明記 |
| `vscode.window.terminals` の列挙タイミングが未検証 | 「実装前検証（ブロッカー）」セクションを追加 |
