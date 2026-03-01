import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { HistoryEntry } from "./types";
import { normalizePath } from "./normalize-path";

/** Resolve the ~/.claude directory */
export function getClaudeDir(): string {
  return path.join(os.homedir(), ".claude");
}

/** Discovered session from history.jsonl */
export interface DiscoveredSession {
  readonly sessionId: string;
  readonly firstPrompt: string;
  readonly lastSeen: number; // Unix ms timestamp
  readonly fileSize: number; // bytes, 0 if file not found
}

/**
 * Discover sessions for a project by reading history.jsonl.
 * Returns unique sessions sorted by last seen (newest first).
 */
export function discoverSessions(
  workspacePath: string,
): readonly DiscoveredSession[] {
  const entries = readHistoryEntries();
  const normalizedWorkspace = normalizePath(workspacePath);
  const projectDir = findProjectDir(workspacePath);

  // Group by sessionId, keep latest timestamp and first prompt per session
  const sessionMap = new Map<
    string,
    { firstPrompt: string; lastSeen: number }
  >();

  for (const entry of entries) {
    if (normalizePath(entry.project) !== normalizedWorkspace) continue;

    const existing = sessionMap.get(entry.sessionId);
    if (existing) {
      // Update lastSeen to the most recent entry
      if (entry.timestamp > existing.lastSeen) {
        sessionMap.set(entry.sessionId, {
          ...existing,
          lastSeen: entry.timestamp,
        });
      }
    } else {
      sessionMap.set(entry.sessionId, {
        firstPrompt: entry.display,
        lastSeen: entry.timestamp,
      });
    }
  }

  const sessions: DiscoveredSession[] = [];
  for (const [sessionId, data] of sessionMap) {
    const fileSize = projectDir ? getSessionFileSize(projectDir, sessionId) : 0;
    sessions.push({ sessionId, ...data, fileSize });
  }

  return sessions.sort((a, b) => b.lastSeen - a.lastSeen);
}

/**
 * Get session .jsonl file size in bytes.
 * Returns 0 if file not found.
 */
function getSessionFileSize(projectDir: string, sessionId: string): number {
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Find the project directory under ~/.claude/projects/ matching a workspace path.
 * CLI slug: path.replace(/[^a-zA-Z0-9]/g, "-") — case-sensitive, so we try both.
 */
function findProjectDir(workspacePath: string): string | undefined {
  const projectsDir = path.join(getClaudeDir(), "projects");
  if (!fs.existsSync(projectsDir)) return undefined;
  const slug = workspacePath.replace(/[^a-zA-Z0-9]/g, "-");
  const candidate = path.join(projectsDir, slug);
  if (fs.existsSync(candidate)) return candidate;
  // Case mismatch fallback: scan dirs
  try {
    const normalizedSlug = slug.toLowerCase();
    for (const dir of fs.readdirSync(projectsDir)) {
      if (dir.toLowerCase() === normalizedSlug) {
        return path.join(projectsDir, dir);
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Look up the .jsonl file size for a session.
 */
export function lookupSessionFileSize(
  workspacePath: string,
  sessionId: string,
): number {
  const projectDir = findProjectDir(workspacePath);
  if (!projectDir) return 0;
  return getSessionFileSize(projectDir, sessionId);
}

/**
 * Read and parse all entries from history.jsonl.
 * Returns entries in file order (oldest first).
 */
export function readHistoryEntries(): readonly HistoryEntry[] {
  const historyPath = path.join(getClaudeDir(), "history.jsonl");
  if (!fs.existsSync(historyPath)) {
    return [];
  }

  const content = fs.readFileSync(historyPath, "utf-8");
  const lines = content.trim().split("\n");
  const entries: HistoryEntry[] = [];

  for (const line of lines) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as HistoryEntry);
    } catch {
      // skip malformed lines
    }
  }

  return entries;
}
