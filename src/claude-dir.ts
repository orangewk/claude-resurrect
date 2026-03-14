import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { HistoryEntry } from "./types";
import { normalizePath } from "./normalize-path";

/** Resolve the ~/.claude directory */
export function getClaudeDir(): string {
  return path.join(os.homedir(), ".claude");
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Validate that a session ID is a well-formed lowercase UUID */
export function isValidSessionId(id: string): boolean {
  return UUID_RE.test(id);
}

/** Display info extracted from a session JSONL file */
export interface SessionDisplayInfo {
  readonly customTitle: string | undefined;
  readonly firstPrompt: string | undefined;
}

/** Discovered session from history.jsonl */
export interface DiscoveredSession {
  readonly sessionId: string;
  readonly projectPath: string;
  readonly firstPrompt: string;
  readonly customTitle: string | undefined;
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

  console.log(`[TS Recall] discoverSessions workspace=${workspacePath} normalizedWorkspace=${normalizedWorkspace} historyEntries=${entries.length}`);

  // Group by sessionId, keep latest timestamp and first prompt per session
  const sessionMap = new Map<
    string,
    { firstPrompt: string; lastSeen: number; projectPath: string }
  >();

  let matchedEntries = 0;
  for (const entry of entries) {
    if (!normalizePath(entry.project).startsWith(normalizedWorkspace)) continue;
    matchedEntries++;
    if (!isValidSessionId(entry.sessionId)) continue;

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
        projectPath: entry.project,
      });
    }
  }

  console.log(`[TS Recall] matchedEntries=${matchedEntries} uniqueSessions=${sessionMap.size}`);

  const sessions: DiscoveredSession[] = [];
  for (const [sessionId, data] of sessionMap) {
    const sessionProjectDir = findProjectDir(data.projectPath);
    const fileSize = sessionProjectDir ? getSessionFileSize(sessionProjectDir, sessionId) : 0;
    if (fileSize === 0) {
      console.log(`[TS Recall]   ${sessionId.slice(0, 8)} fileSize=0 projectPath=${data.projectPath} projectDir=${sessionProjectDir ?? "NOT_FOUND"}`);
    }
    const displayInfo = readSessionDisplayInfo(data.projectPath, sessionId);
    sessions.push({ sessionId, ...data, customTitle: displayInfo.customTitle, fileSize });
  }

  const withFile = sessions.filter(s => s.fileSize > 0).length;
  console.log(`[TS Recall] total sessions=${sessions.length} withFile=${withFile} withoutFile=${sessions.length - withFile}`);

  return sessions.sort((a, b) => b.lastSeen - a.lastSeen);
}

/**
 * Get session .jsonl file size in bytes.
 * Returns 0 if file not found or if the path is a symbolic link.
 */
function getSessionFileSize(projectDir: string, sessionId: string): number {
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return 0;
    return stat.size;
  } catch {
    return 0;
  }
}

/**
 * Return true if the path exists and is NOT a symbolic link.
 */
function existsAndNotSymlink(p: string): boolean {
  try {
    return !fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Find the project directory under ~/.claude/projects/ matching a workspace path.
 * CLI slug: path.replace(/[^a-zA-Z0-9]/g, "-") — case-sensitive, so we try both.
 * Directories that are symbolic links are ignored.
 */
export function findProjectDir(workspacePath: string): string | undefined {
  const projectsDir = path.join(getClaudeDir(), "projects");
  if (!existsAndNotSymlink(projectsDir)) return undefined;
  const slug = workspacePath.replace(/[^a-zA-Z0-9]/g, "-");
  const candidate = path.join(projectsDir, slug);
  if (existsAndNotSymlink(candidate)) return candidate;
  // Case mismatch fallback: scan dirs
  try {
    const normalizedSlug = slug.toLowerCase();
    for (const dir of fs.readdirSync(projectsDir)) {
      const dirPath = path.join(projectsDir, dir);
      if (dir.toLowerCase() === normalizedSlug && existsAndNotSymlink(dirPath)) {
        return dirPath;
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
 * Read display info (customTitle + firstPrompt) from a session JSONL file.
 * Scans the entire file once to find:
 * - The last `type: "custom-title"` entry (most recent rename)
 * - The first `type: "user"` message text
 */
export function readSessionDisplayInfo(
  workspacePath: string,
  sessionId: string,
): SessionDisplayInfo {
  const empty: SessionDisplayInfo = { customTitle: undefined, firstPrompt: undefined };
  if (!isValidSessionId(sessionId)) return empty;
  const projectDir = findProjectDir(workspacePath);
  if (!projectDir) return empty;
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return empty;
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY);
    try {
      const content = fs.readFileSync(fd, "utf-8");
      return parseSessionDisplayInfo(content);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return empty;
  }
}

/** Parse JSONL content to extract customTitle and firstPrompt */
export function parseSessionDisplayInfo(content: string): SessionDisplayInfo {
  let customTitle: string | undefined;
  let firstPrompt: string | undefined;

  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        customTitle?: string;
        message?: { content?: unknown };
      };
      if (entry.type === "custom-title" && typeof entry.customTitle === "string") {
        customTitle = entry.customTitle;
      }
      if (!firstPrompt && entry.type === "user" && entry.message?.content) {
        const text =
          typeof entry.message.content === "string"
            ? entry.message.content
            : Array.isArray(entry.message.content)
              ? (entry.message.content as { type: string; text?: string }[]).find(
                  (c) => c.type === "text",
                )?.text ?? ""
              : "";
        const trimmed = text.slice(0, 80);
        if (trimmed) firstPrompt = trimmed;
      }
    } catch {
      // skip malformed line
    }
  }

  return { customTitle, firstPrompt };
}

/** Resolve display name with priority: customTitle > firstPrompt > short sessionId */
export function resolveDisplayName(
  info: SessionDisplayInfo,
  sessionId: string,
): string {
  return info.customTitle ?? info.firstPrompt ?? sessionId.slice(0, 8);
}

/**
 * Read the first user prompt from a session JSONL file.
 * @deprecated Use readSessionDisplayInfo() + resolveDisplayName() instead.
 */
export function readFirstPrompt(
  workspacePath: string,
  sessionId: string,
): string | undefined {
  return readSessionDisplayInfo(workspacePath, sessionId).firstPrompt;
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
