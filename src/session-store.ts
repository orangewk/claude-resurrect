import type { SessionMapping } from "./types";

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
    this.mappings = [...initial];
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

  /** Get mappings within TTL (hours) for a project */
  getRestorable(projectPath: string, ttlHours: number): readonly SessionMapping[] {
    const cutoff = Date.now() - ttlHours * 60 * 60 * 1000;
    return this.getByProject(projectPath).filter((m) => m.lastSeen >= cutoff);
  }

  /** Get expired mappings (beyond TTL) for a project */
  getExpired(projectPath: string, ttlHours: number): readonly SessionMapping[] {
    const cutoff = Date.now() - ttlHours * 60 * 60 * 1000;
    return this.getByProject(projectPath).filter((m) => m.lastSeen < cutoff);
  }

  /** Add or update a mapping */
  async upsert(mapping: SessionMapping): Promise<void> {
    const idx = this.mappings.findIndex(
      (m) => m.terminalName === mapping.terminalName &&
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

  /** Remove a mapping by terminal name and project */
  async remove(terminalName: string, projectPath: string): Promise<void> {
    const normalized = normalizePath(projectPath);
    this.mappings = this.mappings.filter(
      (m) =>
        !(m.terminalName === terminalName &&
          normalizePath(m.projectPath) === normalized),
    );
    await this.persist(STORAGE_KEY, this.mappings);
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

/** Normalize path for cross-platform comparison */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}
