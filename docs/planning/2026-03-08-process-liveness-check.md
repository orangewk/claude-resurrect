# 復元時プロセス生存確認 (#48)

## 要件の再確認

- セッション復元時（`activate` → `autoRestoreSessions`）に、`"active"` な SessionMapping の OS プロセスが実際に生きているか確認する
- 死んでいれば `"inactive"` に更新してから復元フローに進む
- PID 再利用を誤検出しない（PID + 起動時刻で照合）
- プロセス情報取得失敗時は安全側に倒す（`"active"` のまま維持）

## 現状の復元フロー

```
activate()
  → store.pruneExpired(336)       // 14日超を削除
  → autoRestoreSessions()         // "active" を復元
      → store.getActive(project)  // status === "active" を取得
      → resumeSession() × N      // claude --resume で復元
```

**問題:** `getActive()` が返すセッションに、OS プロセスが既に死んでいるものが含まれる。

## 設計

### 方針

`autoRestoreSessions()` の**前**に、`"active"` セッションの生存確認を挟む。

```
activate()
  → store.pruneExpired(336)
  → store.pruneDeadProcesses(project)  // ★ 追加
  → autoRestoreSessions()
```

### SessionMapping の型拡張

```typescript
export interface SessionMapping {
  readonly terminalName: string;
  readonly sessionId: string;
  readonly projectPath: string;
  readonly lastSeen: number;
  readonly status: SessionStatus;
  readonly pid?: number;            // ★ 追加
  readonly pidCreatedAt?: number;   // ★ 追加（Unix ms）
}
```

`pid` と `pidCreatedAt` は `startNewSession()` / `resumeSession()` でターミナル作成後に記録する。

### プロセス生存確認ロジック

新ファイル: `src/process-check.ts`

```typescript
export interface ProcessInfo {
  pid: number;
  creationDate: number; // Unix ms
}

/**
 * PID が生きていて、かつ起動時刻が一致するか確認する。
 * 取得失敗時は undefined を返す（判定不能）。
 */
export async function isProcessAlive(
  pid: number,
  expectedCreatedAt: number,
  toleranceMs?: number
): Promise<boolean | undefined>
```

**Windows 実装:**

```typescript
// child_process.execFile で tasklist を使う
// tasklist /FI "PID eq <pid>" /FO CSV /NH
// → プロセス存在チェック
//
// 起動時刻の取得は wmic or PowerShell:
// wmic process where "ProcessId=<pid>" get CreationDate
// → 20260307091212.123456+540 形式 → parse して比較
```

**判定ロジック:**
1. `pid` が `undefined` → 判定不能 → `undefined`（安全側: active のまま）
2. プロセスが存在しない → `false`（死亡確定）
3. プロセスが存在 + 起動時刻が `toleranceMs`（デフォルト 5000ms）以内で一致 → `true`
4. プロセスが存在 + 起動時刻が不一致 → `false`（PID 再利用）
5. 起動時刻の取得失敗 → `undefined`（安全側）

### SessionStore への追加メソッド

```typescript
async pruneDeadProcesses(projectPath: string): Promise<number> {
  const actives = this.getActive(projectPath);
  let pruned = 0;
  for (const m of actives) {
    if (m.pid == null) continue;  // pid未記録 → スキップ（安全側）
    const alive = await isProcessAlive(m.pid, m.pidCreatedAt ?? 0);
    if (alive === false) {
      await this.markInactive(m.terminalName, m.projectPath);
      pruned++;
    }
    // alive === true or undefined → 何もしない
  }
  return pruned;
}
```

### pid の記録タイミング

`startNewSession()` と `resumeSession()` で、ターミナル作成後に `processId` を取得:

```typescript
const terminal = vscode.window.createTerminal({ name, cwd });
// Terminal.processId は Thenable<number | undefined>
const pid = await terminal.processId;
if (pid != null) {
  // pid + 現在時刻（近似値）で upsert
  await store.upsert({ ...mapping, pid, pidCreatedAt: Date.now() });
}
```

**注意:** `pidCreatedAt` は厳密にはプロセスの起動時刻ではなく「記録時刻」。`toleranceMs` で吸収する。

## 影響範囲

| ファイル | 変更内容 |
|---------|---------|
| `src/types.ts` | `pid?`, `pidCreatedAt?` 追加 |
| `src/process-check.ts` | **新規** — プロセス生存確認 |
| `src/session-store.ts` | `pruneDeadProcesses()` 追加 |
| `src/extension.ts` | activate で呼び出し + pid 記録 |
| `src/process-check.test.ts` | **新規** — 生存確認テスト |
| `src/session-store.test.ts` | `pruneDeadProcesses` テスト追加 |
| `src/extension.test.ts` | pid 記録の検証追加 |

## 実装フェーズ

### Phase 1: 型拡張 + process-check モジュール
- `types.ts` に `pid?`, `pidCreatedAt?` 追加
- `process-check.ts` 新規作成（`isProcessAlive()`）
- `process-check.test.ts` でユニットテスト

### Phase 2: SessionStore 拡張
- `pruneDeadProcesses()` 追加
- テスト追加（mock で `isProcessAlive` を注入）

### Phase 3: extension.ts 統合
- `activate()` で `pruneDeadProcesses()` 呼び出し
- `startNewSession()` / `resumeSession()` で pid 記録
- テスト更新

### Phase 4: 動作確認
- ビルド + 手動テスト（セッション起動 → プロセス kill → VS Code リロード → ゾンビが消えること）
- 既存テスト全通過

## リスク

| リスク | 重大度 | 対策 |
|-------|--------|------|
| `wmic` が将来の Windows で非推奨化 | LOW | PowerShell にフォールバック可能。現時点では wmic で十分 |
| `Terminal.processId` が shell の PID で、claude CLI の PID ではない | MEDIUM | shell が死ねば CLI も死ぬので、shell PID の生存確認で十分 |
| 既存の pid 未記録セッション | LOW | `pid == null` はスキップ（安全側）。徐々に記録済みに移行 |
| `pidCreatedAt` の精度 | LOW | toleranceMs = 5000ms で吸収。完全一致は求めない |

## 複雑度: 低〜中

新規ファイル1つ、既存変更3ファイル。ロジックはシンプルだが Windows プロセス情報取得の実装詳細に注意。
