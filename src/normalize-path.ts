/** Normalize path for cross-platform, case-insensitive comparison */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}
