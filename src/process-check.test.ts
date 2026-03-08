import { describe, it, expect } from "vitest";
import { parseWmicDate } from "./process-check";

describe("parseWmicDate", () => {
  it("parses a standard WMIC CreationDate", () => {
    // 2026-03-07 09:12:12.123456
    const result = parseWmicDate("20260307091212.123456");
    expect(result).toBeDefined();
    const date = new Date(result!);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(2); // March = 2
    expect(date.getDate()).toBe(7);
    expect(date.getHours()).toBe(9);
    expect(date.getMinutes()).toBe(12);
    expect(date.getSeconds()).toBe(12);
    expect(date.getMilliseconds()).toBe(123);
  });

  it("returns undefined for invalid format", () => {
    expect(parseWmicDate("not-a-date")).toBeUndefined();
    expect(parseWmicDate("")).toBeUndefined();
    expect(parseWmicDate("2026030709121")).toBeUndefined();
  });

  it("handles midnight correctly", () => {
    const result = parseWmicDate("20260101000000.000000");
    expect(result).toBeDefined();
    const date = new Date(result!);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(0);
    expect(date.getDate()).toBe(1);
    expect(date.getHours()).toBe(0);
  });
});
