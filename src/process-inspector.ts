import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findProjectDir } from "./claude-dir";

export interface ClaudeProcessInfo {
  readonly sessionId: string;
  readonly cwd: string;
  readonly userName: string | undefined;
  readonly args: readonly string[];
}

/**
 * Detect the active Claude session running in a terminal by inspecting
 * the process tree. Currently Linux-only (procfs).
 *
 * Returns undefined on non-Linux platforms or if no claude process is found.
 */
export function detectClaudeSession(
  shellPid: number,
): ClaudeProcessInfo | undefined {
  if (process.platform !== "linux") return undefined;
  return detectClaudeSessionLinux(shellPid);
}

/**
 * Linux implementation: walk /proc to find claude child process,
 * read its cwd, then find the most recently modified session .jsonl.
 */
function detectClaudeSessionLinux(
  shellPid: number,
): ClaudeProcessInfo | undefined {
  const claudePid = findClaudeChildPid(shellPid);
  if (claudePid === undefined) return undefined;

  const cwd = readProcessCwd(claudePid);
  if (!cwd) return undefined;

  const userName = readProcessUserName(claudePid);

  // Try cmdline first for --resume <sessionId>
  const cmdlineSessionId = readSessionIdFromCmdline(claudePid);
  if (cmdlineSessionId) {
    const cliArgs = readClaudeArgsFromSession(cwd, cmdlineSessionId);
    return { sessionId: cmdlineSessionId, cwd, userName, args: cliArgs };
  }

  // Fallback: find most recently modified .jsonl in the project dir
  const sessionId = findActiveSessionByProjectDir(cwd);
  if (sessionId) {
    const cliArgs = readClaudeArgsFromSession(cwd, sessionId);
    return { sessionId, cwd, userName, args: cliArgs };
  }

  return undefined;
}

/**
 * Find a child process named "claude" under the given parent PID.
 * Recursively searches children (shell → su → claude).
 */
function findClaudeChildPid(parentPid: number): number | undefined {
  const children = getChildPids(parentPid);
  for (const childPid of children) {
    if (isClaudeProcess(childPid)) return childPid;
    // Recurse: the claude process may be a grandchild (e.g. shell → su → claude)
    const deeper = findClaudeChildPid(childPid);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
}

/** Read child PIDs from procfs task children files */
function getChildPids(pid: number): number[] {
  const pids: number[] = [];
  const taskDir = `/proc/${pid}/task`;
  try {
    for (const tid of fs.readdirSync(taskDir)) {
      const childrenFile = path.join(taskDir, tid, "children");
      try {
        const content = fs.readFileSync(childrenFile, "utf-8").trim();
        if (content) {
          for (const p of content.split(/\s+/)) {
            const n = parseInt(p, 10);
            if (!isNaN(n)) pids.push(n);
          }
        }
      } catch {
        // skip unreadable
      }
    }
  } catch {
    // /proc/<pid>/task not accessible
  }
  return pids;
}

/** Check if a PID is a claude process by reading /proc/<pid>/cmdline */
function isClaudeProcess(pid: number): boolean {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    const argv0 = cmdline.split("\0")[0];
    return argv0 === "claude" || argv0.endsWith("/claude");
  } catch {
    return false;
  }
}

/** Read process CWD via /proc/<pid>/cwd symlink */
function readProcessCwd(pid: number): string | undefined {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

/** Extract --resume <sessionId> from /proc/<pid>/cmdline */
function readSessionIdFromCmdline(pid: number): string | undefined {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    const args = cmdline.split("\0");
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "--resume" || args[i] === "--session-id") {
        const candidate = args[i + 1];
        if (candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(candidate)) {
          return candidate;
        }
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Find the active session ID by looking at the most recently modified
 * .jsonl file in the claude projects directory for the given CWD.
 */
function findActiveSessionByProjectDir(cwd: string): string | undefined {
  const projectDir = findProjectDir(cwd);
  if (!projectDir) return undefined;

  try {
    const entries = fs.readdirSync(projectDir);
    let bestSessionId: string | undefined;
    let bestMtime = 0;

    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const sessionId = entry.slice(0, -6); // remove .jsonl
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) continue;

      const filePath = path.join(projectDir, entry);
      try {
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink()) continue;
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs;
          bestSessionId = sessionId;
        }
      } catch {
        // skip
      }
    }

    return bestSessionId;
  } catch {
    return undefined;
  }
}

/** Read the OS username of a process from /proc/<pid>/status Uid field */
function readProcessUserName(pid: number): string | undefined {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf-8");
    const uidLine = status.split("\n").find((l) => l.startsWith("Uid:"));
    if (!uidLine) return undefined;
    const realUid = parseInt(uidLine.split("\t")[1], 10);
    if (isNaN(realUid)) return undefined;
    // Current user check: if same as extension host, no userName needed
    if (realUid === os.userInfo().uid) return undefined;
    // Resolve uid to username from /etc/passwd
    try {
      const passwd = fs.readFileSync("/etc/passwd", "utf-8");
      for (const line of passwd.split("\n")) {
        const parts = line.split(":");
        if (parts[2] === String(realUid)) return parts[0];
      }
    } catch {
      // fallback: return uid as string
    }
    return String(realUid);
  } catch {
    return undefined;
  }
}

/**
 * Extract CLI args from session JSONL file.
 * Node.js overwrites /proc/<pid>/cmdline, so args are not available from procfs.
 * Instead, read the session JSONL and infer flags from recorded fields.
 */
function readClaudeArgsFromSession(cwd: string, sessionId: string): string[] {
  const projectDir = findProjectDir(cwd);
  if (!projectDir) return [];

  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return [];

    // Read only the first 8KB — the fields we need appear early in the file
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY);
    try {
      const buf = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      const content = buf.toString("utf-8", 0, bytesRead);

      const args: string[] = [];
      let foundPermission = false;
      let foundModel = false;

      for (const line of content.split("\n")) {
        if (!line || (foundPermission && foundModel)) break;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (!foundPermission && entry.permissionMode === "bypassPermissions") {
            args.push("--dangerously-skip-permissions");
            foundPermission = true;
          }
          if (!foundModel && typeof entry.model === "string") {
            args.push("--model", entry.model as string);
            foundModel = true;
          }
        } catch {
          // skip malformed line
        }
      }

      return args;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}
