import { describe, it, expect, vi } from "vitest";
import { SessionStore } from "./session-store";
import type { SessionMapping } from "./types";

function createMapping(overrides: Partial<SessionMapping> = {}): SessionMapping {
  return {
    terminalName: "Claude #1",
    sessionId: "aaaa-bbbb-cccc-dddd",
    projectPath: "C:\\dev\\my-project",
    lastSeen: Date.now(),
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

  it("updates existing mapping by terminalName + projectPath", async () => {
    const original = createMapping({ sessionId: "old-id" });
    const { store } = createStore([original]);

    const updated = createMapping({ sessionId: "new-id" });
    await store.upsert(updated);

    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].sessionId).toBe("new-id");
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

  it("getRestorable filters by TTL", () => {
    const now = Date.now();
    const { store } = createStore([
      createMapping({
        terminalName: "recent",
        lastSeen: now - 1 * 60 * 60 * 1000, // 1 hour ago
      }),
      createMapping({
        terminalName: "old",
        lastSeen: now - 48 * 60 * 60 * 1000, // 48 hours ago
      }),
    ]);

    const restorable = store.getRestorable("C:\\dev\\my-project", 24);
    expect(restorable).toHaveLength(1);
    expect(restorable[0].terminalName).toBe("recent");
  });

  it("getExpired returns only expired mappings", () => {
    const now = Date.now();
    const { store } = createStore([
      createMapping({
        terminalName: "recent",
        lastSeen: now - 1 * 60 * 60 * 1000,
      }),
      createMapping({
        terminalName: "old",
        lastSeen: now - 48 * 60 * 60 * 1000,
      }),
    ]);

    const expired = store.getExpired("C:\\dev\\my-project", 24);
    expect(expired).toHaveLength(1);
    expect(expired[0].terminalName).toBe("old");
  });

  it("removes a mapping", async () => {
    const { store } = createStore([createMapping()]);
    await store.remove("Claude #1", "C:\\dev\\my-project");
    expect(store.getAll()).toHaveLength(0);
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
