import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("node:fs");
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

import { discoverSessions, readHistoryEntries, getClaudeDir } from "./claude-dir";

describe("getClaudeDir", () => {
  it("returns ~/.claude", () => {
    expect(getClaudeDir()).toBe(path.join("/home/testuser", ".claude"));
  });
});

describe("readHistoryEntries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when file does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(readHistoryEntries()).toEqual([]);
  });

  it("parses valid JSONL lines", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        JSON.stringify({ display: "hello", pastedContents: {}, timestamp: 1000, project: "C:\\dev\\foo", sessionId: "aaa" }),
        JSON.stringify({ display: "world", pastedContents: {}, timestamp: 2000, project: "C:\\dev\\foo", sessionId: "bbb" }),
      ].join("\n"),
    );

    const entries = readHistoryEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].display).toBe("hello");
    expect(entries[1].sessionId).toBe("bbb");
  });

  it("skips malformed lines", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        JSON.stringify({ display: "good", pastedContents: {}, timestamp: 1000, project: "C:\\dev\\foo", sessionId: "aaa" }),
        "not json {{{",
        JSON.stringify({ display: "also good", pastedContents: {}, timestamp: 2000, project: "C:\\dev\\foo", sessionId: "bbb" }),
      ].join("\n"),
    );

    const entries = readHistoryEntries();
    expect(entries).toHaveLength(2);
  });
});

describe("discoverSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no history file", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(discoverSessions("C:\\dev\\foo")).toEqual([]);
  });

  it("filters sessions by project path (case-insensitive)", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        JSON.stringify({ display: "match", pastedContents: {}, timestamp: 1000, project: "C:\\dev\\my-project", sessionId: "aaa" }),
        JSON.stringify({ display: "no match", pastedContents: {}, timestamp: 2000, project: "C:\\dev\\other", sessionId: "bbb" }),
        JSON.stringify({ display: "case match", pastedContents: {}, timestamp: 3000, project: "c:\\dev\\My-Project", sessionId: "ccc" }),
      ].join("\n"),
    );

    const sessions = discoverSessions("C:\\dev\\my-project");
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.sessionId)).toEqual(["ccc", "aaa"]);
  });

  it("deduplicates by sessionId and keeps latest timestamp", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        JSON.stringify({ display: "first msg", pastedContents: {}, timestamp: 1000, project: "C:\\dev\\foo", sessionId: "aaa" }),
        JSON.stringify({ display: "second msg", pastedContents: {}, timestamp: 5000, project: "C:\\dev\\foo", sessionId: "aaa" }),
        JSON.stringify({ display: "third msg", pastedContents: {}, timestamp: 3000, project: "C:\\dev\\foo", sessionId: "aaa" }),
      ].join("\n"),
    );

    const sessions = discoverSessions("C:\\dev\\foo");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].firstPrompt).toBe("first msg");
    expect(sessions[0].lastSeen).toBe(5000);
  });

  it("sorts by lastSeen descending", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        JSON.stringify({ display: "old", pastedContents: {}, timestamp: 1000, project: "C:\\dev\\foo", sessionId: "old-id" }),
        JSON.stringify({ display: "new", pastedContents: {}, timestamp: 9000, project: "C:\\dev\\foo", sessionId: "new-id" }),
        JSON.stringify({ display: "mid", pastedContents: {}, timestamp: 5000, project: "C:\\dev\\foo", sessionId: "mid-id" }),
      ].join("\n"),
    );

    const sessions = discoverSessions("C:\\dev\\foo");
    expect(sessions.map((s) => s.sessionId)).toEqual(["new-id", "mid-id", "old-id"]);
  });

  it("normalizes Windows backslash vs forward slash", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ display: "hi", pastedContents: {}, timestamp: 1000, project: "C:\\dev\\foo", sessionId: "aaa" }),
    );

    const sessions = discoverSessions("C:/dev/foo");
    expect(sessions).toHaveLength(1);
  });
});
