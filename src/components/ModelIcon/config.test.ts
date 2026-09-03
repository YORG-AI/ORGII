import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ICON_MAP, THEMEABLE_ICONS, toIconComponent } from "./config";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_SOURCE = readFileSync(join(HERE, "config.ts"), "utf8");
const MODEL_ICONS_DIR = resolve(HERE, "../../assets/modelIcons");

describe("OpenAI icon consolidation", () => {
  it("uses the shared OpenAI icon for OpenAI and Codex models", () => {
    expect(ICON_MAP.codex).toBe(ICON_MAP.openai);
  });

  it("renders both OpenAI icon identities with theme colors", () => {
    expect(THEMEABLE_ICONS.has("openai")).toBe(true);
    expect(THEMEABLE_ICONS.has("codex")).toBe(true);
  });
});

describe("model icon asset routing", () => {
  const imports = [
    ...CONFIG_SOURCE.matchAll(
      /import \w+ from "@src\/assets\/modelIcons\/([^"?]+\.svg)(\?url)?";/g
    ),
  ].map((match) => ({ file: match[1], asUrl: match[2] === "?url" }));

  it("imports every brand glyph as a URL and every currentColor glyph as a component", () => {
    expect(imports.length).toBeGreaterThan(0);
    for (const { file, asUrl } of imports) {
      const usesCurrentColor = readFileSync(
        join(MODEL_ICONS_DIR, file),
        "utf8"
      ).includes("currentColor");
      expect({ file, asUrl }).toEqual({ file, asUrl: !usesCurrentColor });
    }
  });

  it("adapts URL sources to a stable component and passes components through", () => {
    const urlSource = "/assets/example.svg";
    const first = toIconComponent(urlSource);
    expect(toIconComponent(urlSource)).toBe(first);
    // Under Vite every svg import resolves to a URL string, so use a plain
    // component here; the bundler-facing routing is covered by the test above.
    const component = () => null;
    expect(toIconComponent(component)).toBe(component);
  });
});
