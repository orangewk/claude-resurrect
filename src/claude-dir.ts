import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { HistoryEntry } from "./types";

/** Resolve the ~/.claude directory */
export function getClaudeDir(): string {
  return path.join(os.homedir(), ".claude");
}

/**
 * Convert a project path to the slug used in ~/.claude/projects/.
 * e.g. "C:\dev\quantum-scribe" → "c--dev-quantum-scribe"
 */
export function projectPathToSlug(projectPath: string): string {
  return projectPath
    .toLowerCase()
    .replace(/[:\\/]/g, "-");
}

/** Get the session directory for a project */
export function getProjectSessionDir(projectPath: string): string {
  const slug = projectPathToSlug(projectPath);
  return path.join(getClaudeDir(), "projects", slug);
}

/**
 * List session IDs for a project by scanning JSONL files.
 * Returns session IDs sorted by file modification time (newest first).
 */
export function listSessionIds(projectPath: string): readonly string[] {
  const dir = getProjectSessionDir(projectPath);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const jsonlFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => ({
      name: e.name,
      mtime: fs.statSync(path.join(dir, e.name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return jsonlFiles.map((f) => f.name.replace(".jsonl", ""));
}

/**
 * Read the last entry from history.jsonl for a given session ID.
 * Returns the display text (first user prompt) if found.
 */
export function getSessionDisplayName(sessionId: string): string | undefined {
  const historyPath = path.join(getClaudeDir(), "history.jsonl");
  if (!fs.existsSync(historyPath)) {
    return undefined;
  }

  const content = fs.readFileSync(historyPath, "utf-8");
  const lines = content.trim().split("\n");

  // Search from end (most recent first)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]) as HistoryEntry;
      if (entry.sessionId === sessionId) {
        return entry.display;
      }
    } catch {
      // skip malformed lines
    }
  }
  return undefined;
}

/**
 * Watch a project session directory for new JSONL files.
 * Calls `onNewSession` when a new session file appears.
 * Returns a cleanup function.
 */
export function watchProjectDir(
  projectPath: string,
  knownIds: ReadonlySet<string>,
  onNewSession: (sessionId: string) => void,
): () => void {
  const dir = getProjectSessionDir(projectPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const seen = new Set(knownIds);
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const check = (): void => {
    const current = listSessionIds(projectPath);
    for (const id of current) {
      if (!seen.has(id)) {
        seen.add(id);
        onNewSession(id);
      }
    }
  };

  // Try fs.watch first, fall back to polling
  try {
    const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      if (filename && filename.endsWith(".jsonl")) {
        const id = filename.replace(".jsonl", "");
        if (!seen.has(id)) {
          seen.add(id);
          onNewSession(id);
        }
      }
    });

    return () => {
      watcher.close();
    };
  } catch {
    // Fallback: poll every 2 seconds
    pollTimer = setInterval(check, 2000);
    return () => {
      if (pollTimer) {
        clearInterval(pollTimer);
      }
    };
  }
}
