import type { SessionMapping } from "./types";
import { normalizePath } from "./normalize-path";
import { isProcessAlive } from "./process-check";

const STORAGE_KEY = "claudeResurrectMappings";

/**
 * In-memory session store backed by a persistence callback.
 * Decoupled from vscode.Memento so it can be tested with Vitest.
 */
export class SessionStore {
  private mappings: SessionMapping[];
  private readonly persist: (key: string, value: unknown) => Thenable<void>;

  constructor(
    initial: SessionMapping[],
    persist: (key: string, value: unknown) => Thenable<void>,
  ) {
    // Migrate legacy entries that lack a status field
    this.mappings = initial.map((m) => ({
      ...m,
      status: m.status ?? "inactive",
    }));
    this.persist = persist;
  }

  /** Load from globalState */
  static fromState(state: {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void>;
  }): SessionStore {
    const saved = state.get<SessionMapping[]>(STORAGE_KEY, []);
    return new SessionStore(saved, (k, v) => state.update(k, v));
  }

  getAll(): readonly SessionMapping[] {
    return this.mappings;
  }

  /** Get mappings for a specific project path */
  getByProject(projectPath: string): readonly SessionMapping[] {
    const normalized = normalizePath(projectPath);
    return this.mappings.filter(
      (m) => normalizePath(m.projectPath) === normalized,
    );
  }

  /** Get active sessions (interrupted by VSCode restart) for auto-restore */
  getActive(projectPath: string): readonly SessionMapping[] {
    return this.getByProject(projectPath).filter(
      (m) => m.status === "active",
    );
  }

  /** Get inactive sessions within TTL for Quick Pick display */
  getRestorable(projectPath: string, ttlHours: number): readonly SessionMapping[] {
    const cutoff = Date.now() - ttlHours * 60 * 60 * 1000;
    return this.getByProject(projectPath).filter(
      (m) => m.status === "inactive" && m.lastSeen >= cutoff,
    );
  }

  /** Get completed sessions within TTL for Quick Pick display */
  getCompleted(projectPath: string, ttlHours: number): readonly SessionMapping[] {
    const cutoff = Date.now() - ttlHours * 60 * 60 * 1000;
    return this.getByProject(projectPath).filter(
      (m) => m.status === "completed" && m.lastSeen >= cutoff,
    );
  }

  /** Add or update a mapping (keyed by sessionId + projectPath) */
  async upsert(mapping: SessionMapping): Promise<void> {
    const idx = this.mappings.findIndex(
      (m) => m.sessionId === mapping.sessionId &&
        normalizePath(m.projectPath) === normalizePath(mapping.projectPath),
    );
    if (idx >= 0) {
      this.mappings = [
        ...this.mappings.slice(0, idx),
        mapping,
        ...this.mappings.slice(idx + 1),
      ];
    } else {
      this.mappings = [...this.mappings, mapping];
    }
    await this.persist(STORAGE_KEY, this.mappings);
  }

  /** Mark a session as inactive (terminal closed by user) */
  async markInactive(terminalName: string, projectPath: string): Promise<void> {
    const normalized = normalizePath(projectPath);
    const idx = this.mappings.findIndex(
      (m) => m.terminalName === terminalName &&
        normalizePath(m.projectPath) === normalized,
    );
    if (idx < 0) return;

    const existing = this.mappings[idx];
    // completed is a terminal state — don't regress to inactive
    if (existing.status === "completed") return;

    this.mappings = [
      ...this.mappings.slice(0, idx),
      { ...existing, status: "inactive", lastSeen: Date.now() },
      ...this.mappings.slice(idx + 1),
    ];
    await this.persist(STORAGE_KEY, this.mappings);
  }

  /** Mark a session as completed (CLI exited normally) */
  async markCompleted(terminalName: string, projectPath: string): Promise<void> {
    const normalized = normalizePath(projectPath);
    const idx = this.mappings.findIndex(
      (m) => m.terminalName === terminalName &&
        normalizePath(m.projectPath) === normalized,
    );
    if (idx < 0) return;

    const existing = this.mappings[idx];
    this.mappings = [
      ...this.mappings.slice(0, idx),
      { ...existing, status: "completed", lastSeen: Date.now() },
      ...this.mappings.slice(idx + 1),
    ];
    await this.persist(STORAGE_KEY, this.mappings);
  }

  /** Mark active sessions whose OS process has died as inactive */
  async pruneDeadProcesses(projectPath: string): Promise<number> {
    const actives = this.getActive(projectPath);
    let pruned = 0;
    for (const m of actives) {
      if (m.pid == null) continue; // no pid recorded — skip (safe side)
      const alive = await isProcessAlive(m.pid, m.pidCreatedAt ?? 0);
      if (alive === false) {
        await this.markInactive(m.terminalName, m.projectPath);
        pruned++;
      }
      // alive === true or undefined → leave as active
    }
    return pruned;
  }

  /** Remove all expired mappings */
  async pruneExpired(ttlHours: number): Promise<number> {
    const cutoff = Date.now() - ttlHours * 60 * 60 * 1000;
    const before = this.mappings.length;
    this.mappings = this.mappings.filter((m) => m.lastSeen >= cutoff);
    const removed = before - this.mappings.length;
    if (removed > 0) {
      await this.persist(STORAGE_KEY, this.mappings);
    }
    return removed;
  }
}
