import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { FileDiffIcon } from "@src/icons";

import { ICON_NAME_MAP } from "./iconMapping";

const SRC_DIR = path.join(process.cwd(), "src");
function collectSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(fullPath);
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith(".test.ts")) {
      return [];
    }
    return [fullPath];
  });
}

describe("diff icon policy", () => {
  it("maps dynamic diff icon names to FileDiffIcon", () => {
    expect(ICON_NAME_MAP.diff).toBe(FileDiffIcon);
    expect(ICON_NAME_MAP["file-diff"]).toBe(FileDiffIcon);
    expect(ICON_NAME_MAP["git-compare-arrows"]).toBe(FileDiffIcon);
  });

  it("does not import DiffIcon from the shared icon barrel", () => {
    const files = collectSourceFiles(SRC_DIR)
      .filter((file) => {
        const source = fs.readFileSync(file, "utf8");
        return Array.from(
          source.matchAll(
            /import\s*\{(?<imports>[^}]*)\}\s*from\s*"@src\/icons";/gs
          )
        ).some((match) => /\bDiffIcon\b/.test(match.groups?.imports ?? ""));
      })
      .map((file) => path.relative(process.cwd(), file))
      .sort();

    expect(files).toEqual([]);
  });
});
