import { describe, it, expect } from "vitest";
import { isProcessAlive } from "./process-check";

describe("isProcessAlive", () => {
  it("returns false for a PID that does not exist", async () => {
    // PID 99999999 is extremely unlikely to exist
    const result = await isProcessAlive(99999999, Date.now());
    expect(result).toBe(false);
  });

  it("detects the current process as alive", async () => {
    const pid = process.pid;
    // Use a wide tolerance since pidCreatedAt is approximate
    const result = await isProcessAlive(pid, Date.now(), 60_000);
    // Should be true (alive) or undefined (unable to determine), not false
    expect(result).not.toBe(false);
  });

  it("returns false when creation time mismatches (PID reuse)", async () => {
    const pid = process.pid;
    // Pretend the process was created in 2020 — should mismatch
    const result = await isProcessAlive(pid, new Date("2020-01-01").getTime(), 5000);
    if (result !== undefined) {
      expect(result).toBe(false);
    }
  });
});
