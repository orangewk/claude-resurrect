export type SessionStatus = "active" | "inactive" | "completed";

/** Terminal-to-session mapping persisted in globalState */
export interface SessionMapping {
  readonly terminalName: string;
  readonly sessionId: string;
  readonly projectPath: string;
  readonly lastSeen: number; // Unix ms timestamp
  readonly status: SessionStatus;
  readonly pid?: number;
  readonly pidCreatedAt?: number; // Unix ms — approximate process creation time
}

/** Entry from ~/.claude/history.jsonl */
export interface HistoryEntry {
  readonly display: string;
  readonly pastedContents: Record<string, unknown>;
  readonly timestamp: number; // Unix ms
  readonly project: string; // absolute path
  readonly sessionId: string; // UUID v4
}

/** Pre-configured session template for one-click launch */
export interface SessionPreset {
  readonly label: string;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly args?: readonly string[];
  readonly terminalName?: string;
  readonly autoLaunch?: boolean;
  readonly userName?: string;
  readonly shellWrapper?: string;
}
