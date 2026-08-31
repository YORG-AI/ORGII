import type { GitApiStatus, GitFileStatus, GitStatusLetter } from "./gitStatus";
import {
  getStatusBgColor,
  getStatusColor,
  getStatusColorForFile,
  getStatusInfo,
  getStatusLabel,
  getStatusLetter,
  getStatusLetterForFile,
  normalizeGitStatus,
} from "./gitStatus";

describe("getStatusLetter", () => {
  describe("single-character API codes", () => {
    it.each<[GitApiStatus, GitStatusLetter]>([
      ["M", "M"],
      ["A", "U"],
      ["?", "U"],
      ["D", "D"],
      ["R", "R"],
      ["C", "C"],
      ["U", "C"],
      ["!", "I"],
    ])("maps %s to %s", (input, expected) => {
      expect(getStatusLetter(input)).toBe(expected);
    });

    it("maps unknown single-character codes to ?", () => {
      expect(getStatusLetter("X")).toBe("?");
    });
  });

  describe("normalized status strings", () => {
    it.each<[GitFileStatus, GitStatusLetter]>([
      ["modified", "M"],
      ["added", "U"],
      ["deleted", "D"],
      ["renamed", "R"],
      ["conflict", "C"],
      ["ignored", "I"],
    ])("maps %s to %s", (input, expected) => {
      expect(getStatusLetter(input)).toBe(expected);
    });

    it("maps unknown multi-character strings to ?", () => {
      expect(getStatusLetter("unknown" as GitFileStatus)).toBe("?");
    });
  });
});

describe("getStatusColor", () => {
  describe("display letters (direct map)", () => {
    it.each<[GitStatusLetter, string]>([
      ["M", "text-warning-6"],
      ["U", "text-success-6"],
      ["A", "text-success-6"],
      ["D", "text-danger-6"],
      ["R", "text-primary-6"],
      ["C", "text-danger-6"],
      ["I", "text-text-3"],
      ["?", "text-text-3"],
    ])("%s → %s", (letter, expected) => {
      expect(getStatusColor(letter)).toBe(expected);
    });
  });

  describe("API codes (single char; ? is a display key with direct map)", () => {
    it.each<[GitApiStatus, string]>([
      ["M", "text-warning-6"],
      ["A", "text-success-6"],
      ["?", "text-text-3"],
      ["D", "text-danger-6"],
      ["R", "text-primary-6"],
      ["C", "text-danger-6"],
      ["!", "text-text-3"],
    ])("%s resolves to expected Tailwind class", (code, expected) => {
      expect(getStatusColor(code)).toBe(expected);
    });
  });

  it("uses direct letter map for API U before conflict conversion (U is a display letter key)", () => {
    expect(getStatusColor("U")).toBe("text-success-6");
  });

  describe("normalized GitFileStatus strings", () => {
    it.each<[GitFileStatus, string]>([
      ["modified", "text-warning-6"],
      ["added", "text-success-6"],
      ["deleted", "text-danger-6"],
      ["renamed", "text-primary-6"],
      ["conflict", "text-danger-6"],
      ["ignored", "text-text-3"],
    ])("%s → %s", (status, expected) => {
      expect(getStatusColor(status)).toBe(expected);
    });
  });

  it("uses unknown letter class when normalized status maps to ?", () => {
    expect(getStatusColor("unknown" as GitFileStatus)).toBe("text-text-3");
  });

  it("uses unknown letter class when API char maps to ?", () => {
    expect(getStatusColor("Z")).toBe("text-text-3");
  });
});

describe("getStatusBgColor", () => {
  describe("display letters (direct map)", () => {
    it.each<[GitStatusLetter, string]>([
      ["M", "bg-warning-5"],
      ["U", "bg-success-5"],
      ["A", "bg-success-5"],
      ["D", "bg-danger-5"],
      ["R", "bg-primary-5"],
      ["C", "bg-danger-5"],
      ["I", "bg-text-3"],
      ["?", "bg-text-3"],
    ])("%s → %s", (letter, expected) => {
      expect(getStatusBgColor(letter)).toBe(expected);
    });
  });

  describe("API codes (single char; ? is a display key with direct map)", () => {
    it.each<[GitApiStatus, string]>([
      ["M", "bg-warning-5"],
      ["A", "bg-success-5"],
      ["?", "bg-text-3"],
      ["D", "bg-danger-5"],
      ["R", "bg-primary-5"],
      ["C", "bg-danger-5"],
      ["!", "bg-text-3"],
    ])("%s resolves to expected Tailwind class", (code, expected) => {
      expect(getStatusBgColor(code)).toBe(expected);
    });
  });

  it("uses direct letter map for API U (display letter key)", () => {
    expect(getStatusBgColor("U")).toBe("bg-success-5");
  });

  describe("normalized GitFileStatus strings", () => {
    it.each<[GitFileStatus, string]>([
      ["modified", "bg-warning-5"],
      ["added", "bg-success-5"],
      ["deleted", "bg-danger-5"],
      ["renamed", "bg-primary-5"],
      ["conflict", "bg-danger-5"],
      ["ignored", "bg-text-3"],
    ])("%s → %s", (status, expected) => {
      expect(getStatusBgColor(status)).toBe(expected);
    });
  });

  it("falls back for unknown normalized status", () => {
    expect(getStatusBgColor("unknown" as GitFileStatus)).toBe("bg-text-3");
  });

  it("falls back for unknown API single char", () => {
    expect(getStatusBgColor("Z")).toBe("bg-text-3");
  });
});

describe("getStatusLabel", () => {
  describe("via single-char resolution", () => {
    it.each<[GitApiStatus, string]>([
      ["M", "Modified"],
      ["A", "Untracked"],
      ["?", "Untracked"],
      ["D", "Deleted"],
      ["R", "Renamed"],
      ["C", "Conflict"],
      ["U", "Conflict"],
      ["!", "Ignored"],
    ])("%s → %s", (code, label) => {
      expect(getStatusLabel(code)).toBe(label);
    });
  });

  describe("single-character inputs are interpreted as API codes first", () => {
    it.each<[GitStatusLetter, string]>([
      ["M", "Modified"],
      ["U", "Conflict"],
      ["A", "Untracked"],
      ["D", "Deleted"],
      ["R", "Renamed"],
      ["C", "Conflict"],
      ["I", "Unknown"],
      ["?", "Untracked"],
    ])("%s → %s", (code, label) => {
      expect(getStatusLabel(code)).toBe(label);
    });
  });

  describe("normalized GitFileStatus strings", () => {
    it.each<[GitFileStatus, string]>([
      ["modified", "Modified"],
      ["added", "Untracked"],
      ["deleted", "Deleted"],
      ["renamed", "Renamed"],
      ["conflict", "Conflict"],
      ["ignored", "Ignored"],
    ])("%s → %s", (status, label) => {
      expect(getStatusLabel(status)).toBe(label);
    });
  });
});

describe("normalizeGitStatus", () => {
  it.each<[GitApiStatus, GitFileStatus]>([
    ["M", "modified"],
    ["A", "added"],
    ["?", "added"],
    ["D", "deleted"],
    ["R", "renamed"],
    ["C", "conflict"],
    ["U", "conflict"],
    ["!", "ignored"],
  ])("maps %s to %s", (input, expected) => {
    expect(normalizeGitStatus(input)).toBe(expected);
  });

  it("defaults unknown API status to modified", () => {
    expect(normalizeGitStatus("X")).toBe("modified");
  });
});

describe("getStatusInfo", () => {
  it("returns combined letter, textColor, bgColor, and label for API codes", () => {
    expect(getStatusInfo("M")).toEqual({
      letter: "M",
      textColor: "text-warning-6",
      bgColor: "bg-warning-5",
      label: "Modified",
    });
    expect(getStatusInfo("!")).toEqual({
      letter: "I",
      textColor: "text-text-3",
      bgColor: "bg-text-3",
      label: "Unknown",
    });
  });

  it("returns combined fields for normalized status", () => {
    expect(getStatusInfo("added")).toEqual({
      letter: "U",
      textColor: "text-success-6",
      bgColor: "bg-success-5",
      label: "Conflict",
    });
  });
});

describe("getStatusLetterForFile", () => {
  it("returns A for staged added paths (word, A, or ?)", () => {
    expect(getStatusLetterForFile("added", true)).toBe("A");
    expect(getStatusLetterForFile("A", true)).toBe("A");
    expect(getStatusLetterForFile("?", true)).toBe("A");
  });

  it("returns U for unstaged added-equivalent statuses", () => {
    expect(getStatusLetterForFile("added", false)).toBe("U");
    expect(getStatusLetterForFile("A", false)).toBe("U");
    expect(getStatusLetterForFile("?", false)).toBe("U");
  });

  it("delegates other statuses to getStatusLetter regardless of staged", () => {
    expect(getStatusLetterForFile("M", true)).toBe("M");
    expect(getStatusLetterForFile("M", false)).toBe("M");
    expect(getStatusLetterForFile("D", true)).toBe("D");
    expect(getStatusLetterForFile("modified", true)).toBe("M");
    expect(getStatusLetterForFile("deleted", false)).toBe("D");
  });
});

describe("getStatusColorForFile", () => {
  it("matches color for letter from getStatusLetterForFile", () => {
    expect(getStatusColorForFile("A", true)).toBe("text-success-6");
    expect(getStatusColorForFile("A", false)).toBe("text-success-6");
    expect(getStatusColorForFile("M", false)).toBe("text-warning-6");
  });

  it("uses Added styling for staged new file (letter A)", () => {
    expect(getStatusColorForFile("added", true)).toBe("text-success-6");
  });

  it("uses Untracked styling for unstaged new file (letter U)", () => {
    expect(getStatusColorForFile("added", false)).toBe("text-success-6");
  });
});
