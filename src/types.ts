export type SessionStatus = "active" | "inactive" | "completed";

/** Terminal-to-session mapping persisted in globalState */
export interface SessionMapping {
  readonly terminalName: string;
  readonly sessionId: string;
  readonly projectPath: string;
  readonly lastSeen: number; // Unix ms timestamp
  readonly firstPrompt?: string; // first user input for display
  readonly status: SessionStatus;
}

/** Entry from ~/.claude/history.jsonl */
export interface HistoryEntry {
  readonly display: string;
  readonly pastedContents: Record<string, unknown>;
  readonly timestamp: number; // Unix ms
  readonly project: string; // absolute path
  readonly sessionId: string; // UUID v4
}
