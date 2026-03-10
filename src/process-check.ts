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
    // PowerShell: get process start time as Unix ms (wmic removed in Win11)
    const script = `try { (Get-Process -Id ${pid}).StartTime.ToUniversalTime().Subtract([datetime]'1970-01-01').TotalMilliseconds } catch { 'NOT_FOUND' }`;
    const stdout = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);

    const trimmed = stdout.trim();
    if (!trimmed || trimmed === "NOT_FOUND") return false;

    const startTimeMs = Number(trimmed);
    if (isNaN(startTimeMs)) return undefined;

    return Math.abs(startTimeMs - expectedCreatedAt) <= toleranceMs;
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


function execFileAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}
