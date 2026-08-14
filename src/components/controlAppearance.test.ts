import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readComponentSource = (relativePath: string): string =>
  readFileSync(resolve(__dirname, relativePath), "utf8");

describe("control appearance API", () => {
  it("uses one appearance prop for the shared field components", () => {
    const input = readComponentSource("Input/index.tsx");
    const textarea = readComponentSource("Textarea/index.tsx");
    const select = readComponentSource("Select/types.ts");

    for (const source of [input, textarea, select]) {
      expect(source).toContain("appearance?: FieldAppearance");
      expect(source).not.toMatch(/\bfieldVariant\??:/);
      expect(source).not.toMatch(/\bborderless\??:/);
      expect(source).not.toMatch(/\bbgless\??:/);
      expect(source).not.toMatch(/\bvariant\??:.*ghost/);
    }
  });

  it("keeps ghost and bare as distinct field treatments", () => {
    const types = readComponentSource("controlAppearance.ts");
    const inputStyles = readComponentSource("Input/index.scss");
    const selectStyles = readComponentSource("Select/index.scss");

    expect(types).toContain('ControlAppearance = "default" | "ghost"');
    expect(types).toContain('FieldAppearance = ControlAppearance | "bare"');
    expect(types).toContain(
      'BareControlAppearance = Exclude<FieldAppearance, "ghost">'
    );
    expect(inputStyles).toContain("&.input-field-bare");
    expect(inputStyles).toContain("&.input-field-ghost");
    expect(inputStyles).toContain("background: var(--color-surface-hover)");
    expect(selectStyles).toContain(".select-bare .select-selector");
    expect(selectStyles).toContain(
      ".select-ghost.select-open .select-selector"
    );
    expect(selectStyles).toContain(".select-title-row.select-bare");
    expect(selectStyles).toContain("text-decoration-line: underline");
  });

  it("does not retain the old visual naming on migrated composite controls", () => {
    const tabPill = readComponentSource("TabPill/types.ts");
    const pillGroup = readComponentSource("PillGroup/index.tsx");
    const statusBar = readComponentSource(
      "../modules/WorkStation/shared/StatusBar/StatusBarBase.tsx"
    );

    expect(tabPill).toContain("appearance?: TabPillAppearance");
    expect(tabPill).not.toContain("colorScheme?:");
    expect(pillGroup).not.toMatch(/appearance\??:/);
    expect(statusBar).toContain('"primary" | "tertiary"');
    expect(statusBar).not.toMatch(/StatusBarButtonVariant = .*ghost/);
  });
});
