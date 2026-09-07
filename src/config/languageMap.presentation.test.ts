import { getLanguageDisplayName, getLanguageIconFile } from "./languageMap";

describe("getLanguageIconFile", () => {
  it("maps known language labels to representative filenames", () => {
    expect(getLanguageIconFile("TypeScript")).toBe("file.ts");
    expect(getLanguageIconFile("python")).toBe("file.py");
    expect(getLanguageIconFile("Rust")).toBe("file.rs");
  });

  it("normalizes by lowercasing and trimming", () => {
    expect(getLanguageIconFile("  JavaScript  ")).toBe("file.js");
  });

  it("falls back to plain text icon for unknown languages", () => {
    expect(getLanguageIconFile("")).toBe("file.txt");
    expect(getLanguageIconFile("UnknownLang")).toBe("file.txt");
  });
});

describe("getLanguageDisplayName", () => {
  it("maps codes to display names from the registry", () => {
    expect(getLanguageDisplayName("typescript")).toBe("TypeScript");
    expect(getLanguageDisplayName("py")).toBe("Python");
    expect(getLanguageDisplayName("tsx")).toBe("TypeScript React");
  });

  it("returns the original string when not in the registry", () => {
    expect(getLanguageDisplayName("custom-lang")).toBe("custom-lang");
  });

  it("uses Code when language is empty after normalization", () => {
    expect(getLanguageDisplayName("")).toBe("Code");
  });
});
