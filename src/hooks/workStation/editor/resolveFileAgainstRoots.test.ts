/**
 * resolveFileAgainstRoots — regression tests.
 *
 * Regression target: chat file references (pills / markdown links) with
 * relative paths were always joined onto the active WorkStation root, so
 * a session working in another repo (or a /add-dir root) produced
 * "Unable to locate the file". The resolver must prefer the session's
 * own roots and fall back through the multi-root workspace folders.
 */
import { describe, expect, it } from "vitest";

import {
  buildCandidateRoots,
  isUnderAnyRoot,
  resolveFileAgainstRoots,
} from "./resolveFileAgainstRoots";

function existsIn(...present: string[]) {
  return (path: string) => Promise.resolve(present.includes(path));
}

describe("buildCandidateRoots", () => {
  it("orders session root, additional dirs, active root, then folders", () => {
    expect(
      buildCandidateRoots({
        sessionRepoPath: "/p/cloud-infra",
        sessionAdditionalDirs: ["/p/orgii"],
        activeRootPath: "/p/brick-vault",
        workspaceFolderPaths: ["/p/brick-vault", "/p/other"],
      })
    ).toEqual(["/p/cloud-infra", "/p/orgii", "/p/brick-vault", "/p/other"]);
  });

  it("dedupes overlapping roots and trims trailing slashes", () => {
    expect(
      buildCandidateRoots({
        sessionRepoPath: "/p/repo/",
        activeRootPath: "/p/repo",
        workspaceFolderPaths: ["/p/repo/"],
      })
    ).toEqual(["/p/repo"]);
  });

  it("drops empty/null entries and works without session context", () => {
    expect(
      buildCandidateRoots({
        sessionRepoPath: null,
        activeRootPath: "/p/repo",
        workspaceFolderPaths: ["", "/p/second"],
      })
    ).toEqual(["/p/repo", "/p/second"]);
  });
});

describe("resolveFileAgainstRoots", () => {
  it("resolves against the session root even when the active root differs", async () => {
    const resolved = await resolveFileAgainstRoots(
      "scripts/cloud/wipe-all-and-verify.sql",
      ["/p/cloud-infra", "/p/brick-vault"],
      existsIn("/p/cloud-infra/scripts/cloud/wipe-all-and-verify.sql")
    );
    expect(resolved).toBe(
      "/p/cloud-infra/scripts/cloud/wipe-all-and-verify.sql"
    );
  });

  it("falls through to a later root when earlier roots miss", async () => {
    const resolved = await resolveFileAgainstRoots(
      "src/main.rs",
      ["/p/cloud-infra", "/p/orgii", "/p/brick-vault"],
      existsIn("/p/brick-vault/src/main.rs")
    );
    expect(resolved).toBe("/p/brick-vault/src/main.rs");
  });

  it("prefers the earlier root when the path exists under several", async () => {
    const resolved = await resolveFileAgainstRoots(
      "README.md",
      ["/p/cloud-infra", "/p/brick-vault"],
      existsIn("/p/cloud-infra/README.md", "/p/brick-vault/README.md")
    );
    expect(resolved).toBe("/p/cloud-infra/README.md");
  });

  it("returns null when no root contains the file", async () => {
    const resolved = await resolveFileAgainstRoots(
      "missing.txt",
      ["/p/a", "/p/b"],
      existsIn()
    );
    expect(resolved).toBeNull();
  });

  it("strips a leading ./ before joining", async () => {
    const resolved = await resolveFileAgainstRoots(
      "./src/app.ts",
      ["/p/a"],
      existsIn("/p/a/src/app.ts")
    );
    expect(resolved).toBe("/p/a/src/app.ts");
  });

  it("treats probe errors as miss and keeps scanning", async () => {
    const resolved = await resolveFileAgainstRoots(
      "file.txt",
      ["/p/broken", "/p/ok"],
      (path) =>
        path.startsWith("/p/broken")
          ? Promise.reject(new Error("EACCES"))
          : Promise.resolve(path === "/p/ok/file.txt")
    );
    expect(resolved).toBe("/p/ok/file.txt");
  });
});

describe("isUnderAnyRoot", () => {
  it("matches exact root and descendants, not sibling prefixes", () => {
    const roots = ["/p/repo"];
    expect(isUnderAnyRoot("/p/repo", roots)).toBe(true);
    expect(isUnderAnyRoot("/p/repo/src/a.ts", roots)).toBe(true);
    expect(isUnderAnyRoot("/p/repo-other/a.ts", roots)).toBe(false);
  });
});
