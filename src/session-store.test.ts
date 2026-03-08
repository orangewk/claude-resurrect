import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionStore } from "./session-store";
import type { SessionMapping } from "./types";

// Mock process-check module
vi.mock("./process-check", () => ({
  isProcessAlive: vi.fn(),
}));

import { isProcessAlive } from "./process-check";
const mockIsProcessAlive = vi.mocked(isProcessAlive);

function createMapping(overrides: Partial<SessionMapping> = {}): SessionMapping {
  return {
    terminalName: "TS Recall #1",
    sessionId: "aaaa-bbbb-cccc-dddd",
    projectPath: "C:\\dev\\my-project",
    lastSeen: Date.now(),
    status: "active",
    ...overrides,
  };
}

function createStore(initial: SessionMapping[] = []): {
  store: SessionStore;
  persisted: Map<string, unknown>;
} {
  const persisted = new Map<string, unknown>();
  const persist = vi.fn(
    (key: string, value: unknown) => {
      persisted.set(key, value);
      return Promise.resolve();
    },
  );
  return { store: new SessionStore(initial, persist), persisted };
}

describe("SessionStore", () => {
  beforeEach(() => {
    mockIsProcessAlive.mockReset();
  });

  it("starts empty", () => {
    const { store } = createStore();
    expect(store.getAll()).toEqual([]);
  });

  it("upserts a new mapping", async () => {
    const { store } = createStore();
    const mapping = createMapping();
    await store.upsert(mapping);
    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0]).toEqual(mapping);
  });

  it("updates existing mapping by sessionId + projectPath", async () => {
    const original = createMapping({ terminalName: "TS Recall #1" });
    const { store } = createStore([original]);

    const updated = createMapping({ terminalName: "TS Recall: new name" });
    await store.upsert(updated);

    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].terminalName).toBe("TS Recall: new name");
  });

  it("persists on upsert", async () => {
    const { store, persisted } = createStore();
    await store.upsert(createMapping());
    expect(persisted.has("claudeResurrectMappings")).toBe(true);
  });

  it("filters by project path (case-insensitive, slash-normalized)", async () => {
    const { store } = createStore([
      createMapping({ projectPath: "C:\\dev\\project-a", terminalName: "A" }),
      createMapping({ projectPath: "c:/dev/project-a", terminalName: "B" }),
      createMapping({ projectPath: "C:\\dev\\project-b", terminalName: "C" }),
    ]);

    const results = store.getByProject("C:\\dev\\project-a");
    expect(results).toHaveLength(2);
  });

  it("getActive returns only active sessions", () => {
    const { store } = createStore([
      createMapping({ terminalName: "A", status: "active" }),
      createMapping({ terminalName: "B", status: "inactive" }),
      createMapping({ terminalName: "C", status: "completed" }),
    ]);

    const active = store.getActive("C:\\dev\\my-project");
    expect(active).toHaveLength(1);
    expect(active[0].terminalName).toBe("A");
  });

  it("getRestorable returns inactive within TTL", () => {
    const now = Date.now();
    const { store } = createStore([
      createMapping({
        terminalName: "recent-inactive",
        status: "inactive",
        lastSeen: now - 1 * 60 * 60 * 1000,
      }),
      createMapping({
        terminalName: "old-inactive",
        status: "inactive",
        lastSeen: now - 48 * 60 * 60 * 1000,
      }),
      createMapping({
        terminalName: "recent-active",
        status: "active",
        lastSeen: now - 1 * 60 * 60 * 1000,
      }),
      createMapping({
        terminalName: "recent-completed",
        status: "completed",
        lastSeen: now - 1 * 60 * 60 * 1000,
      }),
    ]);

    const restorable = store.getRestorable("C:\\dev\\my-project", 24);
    expect(restorable).toHaveLength(1);
    expect(restorable[0].terminalName).toBe("recent-inactive");
  });

  it("getCompleted returns completed within TTL", () => {
    const now = Date.now();
    const { store } = createStore([
      createMapping({
        terminalName: "recent-completed",
        status: "completed",
        lastSeen: now - 1 * 60 * 60 * 1000,
      }),
      createMapping({
        terminalName: "old-completed",
        status: "completed",
        lastSeen: now - 48 * 60 * 60 * 1000,
      }),
      createMapping({
        terminalName: "recent-active",
        status: "active",
        lastSeen: now - 1 * 60 * 60 * 1000,
      }),
    ]);

    const completed = store.getCompleted("C:\\dev\\my-project", 24);
    expect(completed).toHaveLength(1);
    expect(completed[0].terminalName).toBe("recent-completed");
  });

  it("markInactive transitions active to inactive", async () => {
    const { store } = createStore([
      createMapping({ status: "active" }),
    ]);

    await store.markInactive("TS Recall #1", "C:\\dev\\my-project");
    expect(store.getAll()[0].status).toBe("inactive");
  });

  it("markInactive does not regress completed to inactive", async () => {
    const { store } = createStore([
      createMapping({ status: "completed" }),
    ]);

    await store.markInactive("TS Recall #1", "C:\\dev\\my-project");
    expect(store.getAll()[0].status).toBe("completed");
  });

  it("markCompleted transitions active to completed", async () => {
    const { store } = createStore([
      createMapping({ status: "active" }),
    ]);

    await store.markCompleted("TS Recall #1", "C:\\dev\\my-project");
    expect(store.getAll()[0].status).toBe("completed");
  });

  it("markInactive is no-op when mapping not found", async () => {
    const { store, persisted } = createStore([createMapping()]);
    await store.markInactive("nonexistent", "C:\\dev\\my-project");
    expect(persisted.size).toBe(0); // no persist call
  });

  it("migrates legacy entries without status field", () => {
    const legacy = {
      terminalName: "TS Recall #1",
      sessionId: "aaa",
      projectPath: "C:\\dev\\foo",
      lastSeen: Date.now(),
    } as SessionMapping; // missing status

    const { store } = createStore([legacy]);
    expect(store.getAll()[0].status).toBe("inactive");
  });

  describe("pruneDeadProcesses", () => {
    it("marks dead processes as inactive", async () => {
      mockIsProcessAlive.mockResolvedValue(false);
      const { store } = createStore([
        createMapping({ terminalName: "A", status: "active", pid: 1234, pidCreatedAt: Date.now() }),
      ]);

      const pruned = await store.pruneDeadProcesses("C:\\dev\\my-project");
      expect(pruned).toBe(1);
      expect(store.getAll()[0].status).toBe("inactive");
    });

    it("leaves alive processes as active", async () => {
      mockIsProcessAlive.mockResolvedValue(true);
      const { store } = createStore([
        createMapping({ terminalName: "A", status: "active", pid: 1234, pidCreatedAt: Date.now() }),
      ]);

      const pruned = await store.pruneDeadProcesses("C:\\dev\\my-project");
      expect(pruned).toBe(0);
      expect(store.getAll()[0].status).toBe("active");
    });

    it("skips sessions without pid (safe side)", async () => {
      const { store } = createStore([
        createMapping({ terminalName: "A", status: "active" }),
      ]);

      const pruned = await store.pruneDeadProcesses("C:\\dev\\my-project");
      expect(pruned).toBe(0);
      expect(store.getAll()[0].status).toBe("active");
      expect(mockIsProcessAlive).not.toHaveBeenCalled();
    });

    it("leaves process as active when check returns undefined", async () => {
      mockIsProcessAlive.mockResolvedValue(undefined);
      const { store } = createStore([
        createMapping({ terminalName: "A", status: "active", pid: 1234, pidCreatedAt: Date.now() }),
      ]);

      const pruned = await store.pruneDeadProcesses("C:\\dev\\my-project");
      expect(pruned).toBe(0);
      expect(store.getAll()[0].status).toBe("active");
    });

    it("only prunes sessions for the given project", async () => {
      mockIsProcessAlive.mockResolvedValue(false);
      const { store } = createStore([
        createMapping({ terminalName: "A", status: "active", pid: 1234, pidCreatedAt: Date.now(), projectPath: "C:\\dev\\project-a" }),
        createMapping({ terminalName: "B", status: "active", pid: 5678, pidCreatedAt: Date.now(), projectPath: "C:\\dev\\project-b" }),
      ]);

      const pruned = await store.pruneDeadProcesses("C:\\dev\\project-a");
      expect(pruned).toBe(1);
      expect(store.getAll().find(m => m.terminalName === "A")!.status).toBe("inactive");
      expect(store.getAll().find(m => m.terminalName === "B")!.status).toBe("active");
    });
  });

  it("pruneExpired removes old entries and returns count", async () => {
    const now = Date.now();
    const { store } = createStore([
      createMapping({ terminalName: "A", lastSeen: now }),
      createMapping({
        terminalName: "B",
        lastSeen: now - 48 * 60 * 60 * 1000,
      }),
      createMapping({
        terminalName: "C",
        lastSeen: now - 72 * 60 * 60 * 1000,
      }),
    ]);

    const removed = await store.pruneExpired(24);
    expect(removed).toBe(2);
    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].terminalName).toBe("A");
  });
});
