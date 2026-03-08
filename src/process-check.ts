import { execFile } from "node:child_process";

/**
 * Check whether a process is alive by PID + creation time.
 *
 * Returns:
 *   true  — process exists and creation time matches
 *   false — process does not exist, or PID was reused (creation time mismatch)
 *   undefined — unable to determine (e.g. command failed)
 */
export async function isProcessAlive(
  pid: number,
  expectedCreatedAt: number,
  toleranceMs = 5000,
): Promise<boolean | undefined> {
  if (process.platform !== "win32") {
    return isProcessAliveUnix(pid, expectedCreatedAt, toleranceMs);
  }
  return isProcessAliveWin32(pid, expectedCreatedAt, toleranceMs);
}

async function isProcessAliveWin32(
  pid: number,
  expectedCreatedAt: number,
  toleranceMs: number,
): Promise<boolean | undefined> {
  try {
    const stdout = await execFileAsync("wmic", [
      "process",
      "where",
      `ProcessId=${pid}`,
      "get",
      "CreationDate",
      "/value",
    ]);

    const match = stdout.match(/CreationDate=(\d{14}\.\d+)([+-]\d+)/);
    if (!match) return false; // process not found

    const creationDate = parseWmicDate(match[1]);
    if (creationDate == null) return undefined;

    return Math.abs(creationDate - expectedCreatedAt) <= toleranceMs;
  } catch {
    return undefined;
  }
}

async function isProcessAliveUnix(
  pid: number,
  expectedCreatedAt: number,
  toleranceMs: number,
): Promise<boolean | undefined> {
  try {
    // ps -o lstart= -p <pid> gives the start time
    const stdout = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
    const trimmed = stdout.trim();
    if (!trimmed) return false;

    const startTime = Date.parse(trimmed);
    if (isNaN(startTime)) return undefined;

    return Math.abs(startTime - expectedCreatedAt) <= toleranceMs;
  } catch {
    // ps fails if process doesn't exist (exit code 1)
    return false;
  }
}

/** Parse WMIC CreationDate format: 20260307091212.123456 → Unix ms */
export function parseWmicDate(wmicDate: string): number | undefined {
  // Format: YYYYMMDDHHmmss.ffffff
  const m = wmicDate.match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d+)$/,
  );
  if (!m) return undefined;

  const [, year, month, day, hour, min, sec, frac] = m;
  // Use local time (WMIC reports local time)
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(min),
    Number(sec),
    Number(frac.slice(0, 3)), // ms from microseconds
  );
  return date.getTime();
}

function execFileAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}
