import { describe, expect, it } from "vitest";

import type { ComposerSnapshot } from "@src/components/ComposerInput";

import {
  memberMentionsFromSnapshot,
  serializeSubmissionSnapshot,
} from "../useSubmitMessage";

function memberPill(memberId: string, displayName: string) {
  return {
    kind: "pill" as const,
    attrs: {
      filePath: memberId,
      fileName: displayName,
      iconType: "member" as const,
      isFolder: false,
      lineStart: null,
      lineEnd: null,
    },
  };
}

describe("structured Agent Team Member pill submission snapshot", () => {
  it("preserves canonical pill order, deduplicates ids, and removes only Member pills", () => {
    const snapshot: ComposerSnapshot = {
      parts: [
        memberPill("member://alice", "Same Name"),
        { kind: "text", text: " " },
        memberPill("member://bob", "Same Name"),
        { kind: "text", text: " please inspect " },
        memberPill("member://alice", "Renamed Alice"),
        { kind: "newline" },
        {
          kind: "pill",
          attrs: {
            filePath: "/tmp/source.ts",
            fileName: "source.ts",
            iconType: "file",
            isFolder: false,
            lineStart: null,
            lineEnd: null,
          },
        },
      ],
    };

    expect(memberMentionsFromSnapshot(snapshot)).toEqual([
      { memberId: "alice", displayName: "Same Name" },
      { memberId: "bob", displayName: "Same Name" },
    ]);
    expect(serializeSubmissionSnapshot(snapshot, false)).toContain(
      "@Same Name @Same Name"
    );
    const withoutMembers = serializeSubmissionSnapshot(snapshot, true);
    expect(withoutMembers).not.toContain("@Same Name");
    expect(withoutMembers).not.toContain("@Renamed Alice");
    expect(withoutMembers).toContain("please inspect");
    expect(withoutMembers).toContain("source.ts [file:/tmp/source.ts]");
  });

  it("rejects malformed Member pills instead of silently falling back to Root", () => {
    const malformed: ComposerSnapshot = {
      parts: [memberPill("legacy-member-id", "Legacy")],
    };
    expect(() => memberMentionsFromSnapshot(malformed)).toThrow(
      "no canonical member:// id"
    );
  });
});
