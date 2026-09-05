import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_GIT_DIFF_EDIT_DRAFTS,
  clearGitDiffEditDrafts,
  deleteGitDiffEditDraft,
  hasGitDiffEditDraft,
  restoreGitDiffEditDraft,
  setGitDiffEditDraft,
} from "./gitDiffEditDrafts";

const FILE = "/repo/src/a.ts";

describe("gitDiffEditDrafts", () => {
  beforeEach(() => {
    clearGitDiffEditDrafts();
  });

  it("restores a draft onto the base content it was written against", () => {
    setGitDiffEditDraft(FILE, "base", "edited");
    expect(restoreGitDiffEditDraft(FILE, "base")).toBe("edited");
    // Restoring is not consuming: a second mount for the same base sees it too.
    expect(restoreGitDiffEditDraft(FILE, "base")).toBe("edited");
  });

  it("discards a draft whose base no longer matches the working tree", () => {
    setGitDiffEditDraft(FILE, "base", "edited");
    expect(restoreGitDiffEditDraft(FILE, "changed on disk")).toBeNull();
    expect(hasGitDiffEditDraft(FILE)).toBe(false);
    // …and does not come back even for the original base afterwards.
    expect(restoreGitDiffEditDraft(FILE, "base")).toBeNull();
  });

  it("does not keep a draft equal to its base", () => {
    setGitDiffEditDraft(FILE, "base", "edited");
    setGitDiffEditDraft(FILE, "base", "base");
    expect(hasGitDiffEditDraft(FILE)).toBe(false);
  });

  it("forgets a draft on explicit delete (save / discard / tab close)", () => {
    setGitDiffEditDraft(FILE, "base", "edited");
    deleteGitDiffEditDraft(FILE);
    expect(restoreGitDiffEditDraft(FILE, "base")).toBeNull();
  });

  it("ignores empty paths", () => {
    setGitDiffEditDraft("", "base", "edited");
    expect(restoreGitDiffEditDraft("", "base")).toBeNull();
  });

  it("keeps at most the configured number of files", () => {
    for (let index = 0; index <= MAX_GIT_DIFF_EDIT_DRAFTS; index += 1) {
      setGitDiffEditDraft(`/repo/${index}.ts`, "base", `edit ${index}`);
    }
    expect(hasGitDiffEditDraft("/repo/0.ts")).toBe(false);
    expect(
      restoreGitDiffEditDraft(`/repo/${MAX_GIT_DIFF_EDIT_DRAFTS}.ts`, "base")
    ).toBe(`edit ${MAX_GIT_DIFF_EDIT_DRAFTS}`);
  });
});
