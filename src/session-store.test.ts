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

  describe("markInactiveBySessionId / markCompletedBySessionId", () => {
    it("markInactiveBySessionId transitions active to inactive", async () => {
      const { store } = createStore([
        createMapping({ sessionId: "sess-1", status: "active" }),
      ]);

      await store.markInactiveBySessionId("sess-1", "C:\\dev\\my-project");
      expect(store.getAll()[0].status).toBe("inactive");
    });

    it("markInactiveBySessionId does not regress completed to inactive", async () => {
      const { store } = createStore([
        createMapping({ sessionId: "sess-1", status: "completed" }),
      ]);

      await store.markInactiveBySessionId("sess-1", "C:\\dev\\my-project");
      expect(store.getAll()[0].status).toBe("completed");
    });

    it("markCompletedBySessionId transitions active to completed", async () => {
      const { store } = createStore([
        createMapping({ sessionId: "sess-1", status: "active" }),
      ]);

      await store.markCompletedBySessionId("sess-1", "C:\\dev\\my-project");
      expect(store.getAll()[0].status).toBe("completed");
    });

    it("markInactiveBySessionId is no-op when sessionId not found", async () => {
      const { store, persisted } = createStore([createMapping()]);
      await store.markInactiveBySessionId("nonexistent", "C:\\dev\\my-project");
      expect(persisted.size).toBe(0);
    });

    it("sessionId correctly targets the right entry among duplicates with same terminalName", async () => {
      // Ghost bug reproduction: two entries with same terminalName "TS Recall #1"
      const { store } = createStore([
        createMapping({ terminalName: "TS Recall #1", sessionId: "sess-old", status: "inactive" }),
        createMapping({ terminalName: "TS Recall #1", sessionId: "sess-new", status: "active" }),
      ]);

      // Mark the NEW active session as completed by sessionId
      await store.markCompletedBySessionId("sess-new", "C:\\dev\\my-project");

      const all = store.getAll();
      expect(all.find((m) => m.sessionId === "sess-old")!.status).toBe("inactive");
      expect(all.find((m) => m.sessionId === "sess-new")!.status).toBe("completed");
    });
  });

  describe("markInactive / markCompleted (terminalName fallback)", () => {
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

    it("markInactive prefers active entry when duplicate terminalNames exist", async () => {
      // Active-priority match: should target the active entry, not the older inactive one
      const { store } = createStore([
        createMapping({ terminalName: "TS Recall #1", sessionId: "sess-old", status: "inactive" }),
        createMapping({ terminalName: "TS Recall #1", sessionId: "sess-new", status: "active" }),
      ]);

      await store.markInactive("TS Recall #1", "C:\\dev\\my-project");

      const all = store.getAll();
      expect(all.find((m) => m.sessionId === "sess-old")!.status).toBe("inactive");
      expect(all.find((m) => m.sessionId === "sess-new")!.status).toBe("inactive");
    });

    it("markCompleted prefers active entry when duplicate terminalNames exist", async () => {
      const { store } = createStore([
        createMapping({ terminalName: "TS Recall #1", sessionId: "sess-old", status: "inactive" }),
        createMapping({ terminalName: "TS Recall #1", sessionId: "sess-new", status: "active" }),
      ]);

      await store.markCompleted("TS Recall #1", "C:\\dev\\my-project");

      const all = store.getAll();
      expect(all.find((m) => m.sessionId === "sess-old")!.status).toBe("inactive");
      expect(all.find((m) => m.sessionId === "sess-new")!.status).toBe("completed");
    });
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
        createMapping({ terminalName: "A", sessionId: "sess-a", status: "active", pid: 1234, pidCreatedAt: Date.now(), projectPath: "C:\\dev\\project-a" }),
        createMapping({ terminalName: "B", sessionId: "sess-b", status: "active", pid: 5678, pidCreatedAt: Date.now(), projectPath: "C:\\dev\\project-b" }),
      ]);

      const pruned = await store.pruneDeadProcesses("C:\\dev\\project-a");
      expect(pruned).toBe(1);
      expect(store.getAll().find(m => m.sessionId === "sess-a")!.status).toBe("inactive");
      expect(store.getAll().find(m => m.sessionId === "sess-b")!.status).toBe("active");
    });

    it("uses sessionId to prune correct entry among duplicate terminalNames", async () => {
      mockIsProcessAlive.mockImplementation(async (pid: number) => pid === 1111 ? false : true);
      const { store } = createStore([
        createMapping({ terminalName: "TS Recall #1", sessionId: "sess-dead", status: "active", pid: 1111, pidCreatedAt: Date.now() }),
        createMapping({ terminalName: "TS Recall #1", sessionId: "sess-alive", status: "active", pid: 2222, pidCreatedAt: Date.now() }),
      ]);

      const pruned = await store.pruneDeadProcesses("C:\\dev\\my-project");
      expect(pruned).toBe(1);
      expect(store.getAll().find(m => m.sessionId === "sess-dead")!.status).toBe("inactive");
      expect(store.getAll().find(m => m.sessionId === "sess-alive")!.status).toBe("active");
    });
  });

  describe("resetStale", () => {
    it("marks active sessions with no matching terminal as inactive", async () => {
      const { store } = createStore([
        createMapping({ terminalName: "TS Recall #1", sessionId: "sess-1", status: "active" }),
        createMapping({ terminalName: "TS Recall #2", sessionId: "sess-2", status: "active" }),
      ]);

      const reset = await store.resetStale("C:\\dev\\my-project", ["TS Recall #1"]);
      expect(reset).toBe(1);
      expect(store.getAll().find(m => m.sessionId === "sess-1")!.status).toBe("active");
      expect(store.getAll().find(m => m.sessionId === "sess-2")!.status).toBe("inactive");
    });

    it("does not touch inactive or completed sessions", async () => {
      const { store } = createStore([
        createMapping({ terminalName: "A", sessionId: "sess-1", status: "inactive" }),
        createMapping({ terminalName: "B", sessionId: "sess-2", status: "completed" }),
      ]);

      const reset = await store.resetStale("C:\\dev\\my-project", []);
      expect(reset).toBe(0);
      expect(store.getAll().find(m => m.sessionId === "sess-1")!.status).toBe("inactive");
      expect(store.getAll().find(m => m.sessionId === "sess-2")!.status).toBe("completed");
    });

    it("returns 0 when all active sessions have matching terminals", async () => {
      const { store } = createStore([
        createMapping({ terminalName: "TS Recall #1", sessionId: "sess-1", status: "active" }),
      ]);

      const reset = await store.resetStale("C:\\dev\\my-project", ["TS Recall #1"]);
      expect(reset).toBe(0);
      expect(store.getAll()[0].status).toBe("active");
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
