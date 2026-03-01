import { describe, it, expect } from "vitest";
import { projectPathToSlug } from "./claude-dir";

describe("projectPathToSlug", () => {
  it("converts Windows path", () => {
    expect(projectPathToSlug("C:\\dev\\quantum-scribe")).toBe(
      "c--dev-quantum-scribe",
    );
  });

  it("converts Unix path", () => {
    expect(projectPathToSlug("/home/user/project")).toBe(
      "-home-user-project",
    );
  });

  it("handles drive letter", () => {
    expect(projectPathToSlug("D:\\workspace\\app")).toBe(
      "d--workspace-app",
    );
  });

  it("is case-insensitive", () => {
    expect(projectPathToSlug("C:\\Dev\\MyProject")).toBe(
      "c--dev-myproject",
    );
  });
});
