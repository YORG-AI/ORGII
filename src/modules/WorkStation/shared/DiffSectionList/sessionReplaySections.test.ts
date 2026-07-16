import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  type SessionReplayDiffEntryLike,
  buildConsolidatedSessionReplayDiffSectionItems,
  buildSessionReplayDiffSectionItems,
} from "./sessionReplaySections";

function minimalSessionEvent(
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    chunk_id: null,
    id: "evt-1",
    sessionId: "sess-1",
    createdAt: "2026-06-10T00:00:00.000Z",
    functionName: "edit_file",
    uiCanonical: "",
    actionType: "tool_call",
    args: {},
    result: {},
    source: "assistant",
    displayText: "",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "agent",
    ...overrides,
  };
}

function diffEntry(
  entryId: string,
  diff: string,
  filePath = "src/foo.ts"
): SessionReplayDiffEntryLike {
  return {
    entryId,
    filePath,
    fileName: "foo.ts",
    event: minimalSessionEvent({
      id: entryId,
      result: {
        content: `Edit applied\n\n\`\`\`diff\n--- a/${filePath}\n+++ b/${filePath}\n${diff}\n\`\`\``,
      },
    }),
  };
}

describe("session replay diff sections", () => {
  it("preserves unified diff hunk start lines for focused entries", () => {
    const sections = buildSessionReplayDiffSectionItems(
      diffEntry("edit-1", "@@ -42,3 +43,4 @@\n context\n-old\n+new\n+next")
    );

    expect(sections).toHaveLength(1);
    expect(sections[0].file.oldStartLine).toBe(42);
    expect(sections[0].file.newStartLine).toBe(43);
    expect(sections[0].file.oldContent).toBe("context\nold");
    expect(sections[0].file.newContent).toBe("context\nnew\nnext");
  });

  it("keeps hunk line starts when consolidating repeated edits by file", () => {
    const sections = buildConsolidatedSessionReplayDiffSectionItems([
      diffEntry("edit-1", "@@ -42,1 +42,1 @@\n-old\n+new"),
      diffEntry("edit-2", "@@ -50,1 +51,1 @@\n-before\n+after"),
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].file.oldStartLine).toBe(42);
    expect(sections[0].file.newStartLine).toBe(42);
    expect(sections[0].entryIds).toEqual(["edit-1", "edit-2"]);
  });

  it("excludes pathless diff events instead of using the tool name as a fake file", () => {
    const sections = buildSessionReplayDiffSectionItems({
      entryId: "empty-1",
      filePath: "",
      fileName: "edit_file_by_replace",
      event: minimalSessionEvent({
        id: "empty-1",
        functionName: "edit_file_by_replace",
        result: {},
      }),
    });

    expect(sections).toEqual([]);
  });

  it("excludes non-delete sections with no old or new content", () => {
    const sections = buildSessionReplayDiffSectionItems({
      entryId: "empty-2",
      filePath: "src/empty.inc",
      fileName: "empty.inc",
      event: minimalSessionEvent({
        id: "empty-2",
        args: { file_path: "src/empty.inc" },
        result: {},
      }),
    });

    expect(sections).toEqual([]);
  });

  it("renders imported Codex apply_patch Update File events", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/app.ts",
      "@@",
      "-const oldValue = true;",
      "+const newValue = true;",
      " export const kept = 1;",
      "*** End Patch",
    ].join("\n");

    const sections = buildSessionReplayDiffSectionItems({
      entryId: "patch-1",
      filePath: "src/app.ts",
      fileName: "app.ts",
      event: minimalSessionEvent({
        id: "patch-1",
        functionName: "edit_file_by_replace",
        args: {
          patch_text: patchText,
          file_path: "src/app.ts",
          target_file: "src/app.ts",
        },
        result: { content: "Success. Updated src/app.ts" },
        filePath: "src/app.ts",
      }),
    });

    expect(sections).toHaveLength(1);
    expect(sections[0].file.path).toBe("src/app.ts");
    expect(sections[0].file.oldContent).toBe(
      "const oldValue = true;\nexport const kept = 1;"
    );
    expect(sections[0].file.newContent).toBe(
      "const newValue = true;\nexport const kept = 1;"
    );
    expect(sections[0].file.oldStartLine).toBeUndefined();
    expect(sections[0].file.newStartLine).toBeUndefined();
    expect(sections[0].file.showLineNumbers).toBe(false);
  });

  it("preserves explicit Codex apply_patch hunk line ranges", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/app.ts",
      "@@ -42,2 +43,2 @@",
      "-const oldValue = true;",
      "+const newValue = true;",
      "*** End Patch",
    ].join("\n");

    const sections = buildSessionReplayDiffSectionItems({
      entryId: "patch-ranged",
      filePath: "src/app.ts",
      fileName: "app.ts",
      event: minimalSessionEvent({
        id: "patch-ranged",
        functionName: "edit_file_by_replace",
        args: {
          patch_text: patchText,
          file_path: "src/app.ts",
          target_file: "src/app.ts",
        },
        result: { content: "Success. Updated src/app.ts" },
        filePath: "src/app.ts",
      }),
    });

    expect(sections).toHaveLength(1);
    expect(sections[0].file.oldStartLine).toBe(42);
    expect(sections[0].file.newStartLine).toBe(43);
    expect(sections[0].file.showLineNumbers).toBeUndefined();
    expect(sections[0].file.oldContent).toBe("const oldValue = true;");
    expect(sections[0].file.newContent).toBe("const newValue = true;");
  });

  it("keeps distant hunks in one unified content pair", () => {
    const sections = buildSessionReplayDiffSectionItems(
      diffEntry(
        "edit-1",
        "@@ -42,2 +42,2 @@\n context\n-old\n+new\n@@ -180,2 +180,2 @@\n tail\n-foo\n+bar"
      )
    );

    expect(sections).toHaveLength(1);
    expect(sections[0].file.oldStartLine).toBe(42);
    expect(sections[0].file.newStartLine).toBe(42);
    expect(sections[0].file.oldContent).toBe("context\nold\ntail\nfoo");
    expect(sections[0].file.newContent).toBe("context\nnew\ntail\nbar");
    expect(sections[0].file.oldContent).not.toContain("\n\n");
    expect(sections[0].file.newContent).not.toContain("\n\n");
  });

  it("keeps consolidated multi-hunk edits in one unified content pair", () => {
    const sections = buildConsolidatedSessionReplayDiffSectionItems([
      diffEntry("edit-1", "@@ -42,1 +42,1 @@\n-old\n+new"),
      diffEntry("edit-2", "@@ -180,1 +180,1 @@\n-before\n+after"),
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].file.oldStartLine).toBe(42);
    expect(sections[0].file.newStartLine).toBe(42);
    expect(sections[0].file.oldContent).toBe("old\nbefore");
    expect(sections[0].file.newContent).toBe("new\nafter");
    expect(sections[0].file.oldContent).not.toContain("\n\n");
    expect(sections[0].file.newContent).not.toContain("\n\n");
  });
});
