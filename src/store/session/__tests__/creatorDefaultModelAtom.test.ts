/**
 * E3 全共享: project-scoped shared model/key/account config.
 *
 * Covers the storage-key resolution and the project-scope read/write
 * fallback chain:
 *   - `project:<projectId>` / `repo:<repoPath>` keys win over category
 *   - category remains the legacy fallback when no scope is set
 *   - scope keys survive prune (they carry the same entry shape)
 */
import { describe, expect, it } from "vitest";

import {
  projectScopeKey,
  resolveModelPairKey,
} from "@src/store/session/creatorDefaultModelAtom";

describe("projectScopeKey", () => {
  it("passes through prefixed project keys", () => {
    expect(projectScopeKey("project:abc-123")).toBe("project:abc-123");
    expect(projectScopeKey("repo:/home/user/myproj")).toBe(
      "repo:/home/user/myproj"
    );
  });

  it("prefixes bare scopes with project:", () => {
    expect(projectScopeKey("abc-123")).toBe("project:abc-123");
  });

  it("returns null for empty scope", () => {
    expect(projectScopeKey(null)).toBeNull();
    expect(projectScopeKey("")).toBeNull();
  });
});

describe("resolveModelPairKey", () => {
  it("prefers project scope over category", () => {
    expect(resolveModelPairKey("project:abc", "rust_agent")).toBe(
      "project:abc"
    );
    expect(resolveModelPairKey("repo:/p", "cli_agent")).toBe("repo:/p");
  });

  it("falls back to category when no scope is set", () => {
    expect(resolveModelPairKey(null, "rust_agent")).toBe("rust_agent");
    expect(resolveModelPairKey("", "cli_agent")).toBe("cli_agent");
  });
});
