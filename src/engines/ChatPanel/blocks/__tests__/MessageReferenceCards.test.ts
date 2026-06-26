import { describe, expect, it, vi } from "vitest";

import {
  collapseRelativePathSegments,
  extractMessageReferences,
  resolveOpenPath,
} from "../MessageReferenceCards.helpers";

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn(async () => "/Users/tester"),
}));

describe("collapseRelativePathSegments", () => {
  it("returns paths without parent/current segments unchanged", () => {
    expect(collapseRelativePathSegments("/Users/me/project/src/file.ts")).toBe(
      "/Users/me/project/src/file.ts"
    );
    expect(collapseRelativePathSegments("")).toBe("");
  });

  it("collapses parent-directory segments in absolute paths", () => {
    expect(
      collapseRelativePathSegments("/Users/me/proj/../sibling/file.ts")
    ).toBe("/Users/me/sibling/file.ts");
    expect(
      collapseRelativePathSegments(
        "/Users/vinceorz/Projects/ORGII/../openai_compat/types.rs"
      )
    ).toBe("/Users/vinceorz/Projects/openai_compat/types.rs");
  });

  it("collapses single-dot current-directory segments", () => {
    expect(collapseRelativePathSegments("/A/./B/./C")).toBe("/A/B/C");
  });

  it("treats absolute root as the upper bound", () => {
    expect(collapseRelativePathSegments("/..")).toBe("/");
    expect(collapseRelativePathSegments("/../foo")).toBe("/foo");
    expect(collapseRelativePathSegments("/A/../../B")).toBe("/B");
  });

  it("preserves leading .. segments in relative paths", () => {
    expect(collapseRelativePathSegments("../foo/bar")).toBe("../foo/bar");
    expect(collapseRelativePathSegments("A/B/../../../C")).toBe("../C");
  });

  it("preserves trailing slashes for directory-style paths", () => {
    expect(collapseRelativePathSegments("/A/B/../C/")).toBe("/A/C/");
    expect(collapseRelativePathSegments("/")).toBe("/");
  });

  it("collapses trailing dot-segments", () => {
    expect(collapseRelativePathSegments("/A/B/..")).toBe("/A");
    expect(collapseRelativePathSegments("/A/B/.")).toBe("/A/B");
  });
});

describe("resolveOpenPath", () => {
  it("expands ~/ to the home directory", async () => {
    await expect(resolveOpenPath("~/Documents/file.txt")).resolves.toBe(
      "/Users/tester/Documents/file.txt"
    );
  });

  it("collapses parent-directory segments even on ~/-prefixed inputs", async () => {
    await expect(resolveOpenPath("~/Projects/A/../B/file.ts")).resolves.toBe(
      "/Users/tester/Projects/B/file.ts"
    );
  });

  it("collapses parent-directory segments on non-~ paths without invoking homeDir", async () => {
    await expect(
      resolveOpenPath(
        "/Users/vinceorz/Projects/ORGII/../openai_compat/types.rs"
      )
    ).resolves.toBe("/Users/vinceorz/Projects/openai_compat/types.rs");
  });

  it("passes already-clean paths through unchanged", async () => {
    await expect(resolveOpenPath("/Users/me/proj/src/main.ts")).resolves.toBe(
      "/Users/me/proj/src/main.ts"
    );
  });
});

describe("extractMessageReferences", () => {
  it("extracts agent commit lines into commit reference cards", () => {
    const references = extractMessageReferences(`
Committed the diff-view work.

Commit:

4e7c7b77 fix(diff): align replay line numbers and submission filters
Pre-commit checks passed, including:

lint-staged
scoped TypeScript check
staged file lint stats
`);

    expect(references[0]).toMatchObject({
      kind: "git_commit",
      value: "4e7c7b77",
      title: "fix(diff): align replay line numbers and submission filters",
      subtitle: "4e7c7b77",
      sha: "4e7c7b77",
      shortSha: "4e7c7b77",
    });
  });

  it("upgrades GitHub commit URLs to commit reference cards", () => {
    const references = extractMessageReferences(
      "Commit: https://github.com/orgii/app/commit/abcdef1234567890"
    );

    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      kind: "git_commit",
      value: "abcdef1234567890",
      title: "Commit abcdef1",
      subtitle: "abcdef1 · orgii/app",
      url: "https://github.com/orgii/app/commit/abcdef1234567890",
    });
  });

  it("keeps non-GitHub URLs as generic web URL cards", () => {
    const references = extractMessageReferences(
      "Docs: https://example.com/docs"
    );

    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      kind: "web_url",
      value: "https://example.com/docs",
    });
  });

  it("does not extract template placeholder hosts as URL cards", () => {
    const references = extractMessageReferences(
      "The server logs http://localhost:1998 and http://${host}/"
    );

    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      kind: "web_url",
      value: "http://localhost:1998/",
    });
  });

  it("does not extract local filesystem paths as reference cards", () => {
    const references = extractMessageReferences(
      "Open /Users/me/project/src and ~/Documents/file.txt"
    );

    expect(references).toHaveLength(0);
  });

  it("does not treat custom URI schemes embedded in text as drive-letter paths", () => {
    const references = extractMessageReferences(
      "看一下 @session://abc-123/456 的逻辑链"
    );

    expect(
      references.find((item) => item.kind === "local_path")
    ).toBeUndefined();
  });

  it("does not treat lowercase keywords inside other words as home-relative roots", () => {
    const references = extractMessageReferences(
      "Visit subdocuments/readme.md inside the project"
    );

    expect(
      references.find((item) => item.kind === "local_path")
    ).toBeUndefined();
  });

  it("extracts session ids as session cards, not commits", () => {
    const references = extractMessageReferences(
      "queue flushed into sdeagent-ee970f47-dfcb-4a78-97e5-fc56e3451821 after it failed"
    );

    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      kind: "session",
      value: "sdeagent-ee970f47-dfcb-4a78-97e5-fc56e3451821",
      sessionId: "sdeagent-ee970f47-dfcb-4a78-97e5-fc56e3451821",
      title: "sdeagent-ee970f47…",
    });
  });

  it("extracts delegate worker handles as session cards", () => {
    const references = extractMessageReferences(
      "see agent-builtin:explore-93edacaf-c1e2-44bb-8e13-4bf5362aaecb for details"
    );

    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      kind: "session",
      sessionId: "agent-builtin:explore-93edacaf-c1e2-44bb-8e13-4bf5362aaecb",
    });
  });

  it("session id in commit-context prose does not produce a commit card", () => {
    const references = extractMessageReferences(
      "已 commit。queue flush 进了 session sdeagent-ee970f47-dfcb-4a78-97e5-fc56e3451821"
    );

    expect(
      references.find((item) => item.kind === "git_commit")
    ).toBeUndefined();
    expect(references.find((item) => item.kind === "session")).toBeDefined();
  });

  it("keeps a real commit alongside a session card", () => {
    const references = extractMessageReferences(
      "committed f55f430b; session sdeagent-9be175b5-aacb-4b2b-b23a-b46a8d4d6a35 continues"
    );

    expect(references.map((item) => item.kind).sort()).toEqual([
      "git_commit",
      "session",
    ]);
  });

  it("does not extract session ids embedded in longer job handles", () => {
    const references = extractMessageReferences(
      "job extract-mem-sdeagent-9be175b5-aacb-4b2b-b23a-b46a8d4d6a35-ad0ba9f1-b874-4927-b2f9-03b936aa0aef ran"
    );

    expect(references.find((item) => item.kind === "session")).toBeUndefined();
  });

  it("keeps serialized session pill labels instead of falling back to ids", () => {
    const id = "sdeagent-ee970f47-dfcb-4a78-97e5-fc56e3451821";
    const references = extractMessageReferences(
      `please review 审计-policy-啊permission-那些... [session:${id}]`
    );

    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      kind: "session",
      value: id,
      sessionId: id,
      title: "审计-policy-啊permission-那些...",
      subtitle: id,
    });
  });

  it("dedupes serialized session pill ids against bare session ids", () => {
    const id = "sdeagent-ee970f47-dfcb-4a78-97e5-fc56e3451821";
    const references = extractMessageReferences(
      `session-title [session:${id}] then bare ${id}`
    );

    expect(references.filter((item) => item.kind === "session")).toHaveLength(
      1
    );
    expect(references[0]?.title).toBe("session-title");
  });
});
