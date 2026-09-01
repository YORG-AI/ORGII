/**
 * Caret parity: the code-editor caret and the terminal cursor must be the same
 * accent as an input caret (`caret-color: var(--color-primary-6)`).
 *
 * Two ways that drifted before:
 *  - the light theme pinned `--cm-editor-caret` / `--terminal-caret` to an
 *    indigo (#4f6dff) that its `--color-primary-6` had since moved away from;
 *  - the tokens were literals at all, so the primary-color presets — which
 *    write `--color-primary-*` inline on <body> — recolored every input caret
 *    while the editor and terminal stayed blue.
 *
 * The fix is that the body scope aliases both tokens to `--color-primary-6`.
 * These assertions pin that alias, and pin the literals that stand in before
 * it resolves (the `:root` copies and the xterm palette fallbacks) to the same
 * color, so a first paint is never a different accent than the second.
 */
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { TERMINAL_THEMES } from "@src/util/ui/terminal/themes";

const THEME_FILES = ["orgii_main.css", "orgii_dark.css"] as const;

const CARET_TOKENS = ["--cm-editor-caret", "--terminal-caret"] as const;

const PRIMARY_ALIAS = "var(--color-primary-6)";

interface ThemeScopes {
  /** Declarations on `:root` — inherited by <html>, where no accent exists. */
  root: string;
  /** Declarations on `body`, where --color-primary-6 is defined and overridden. */
  body: string;
}

function readThemeScopes(fileName: string): ThemeScopes {
  const source = readFileSync(
    resolve(process.cwd(), "public", fileName),
    "utf8"
  );
  const [root, body] = source.split("body {");
  expect(body, `${fileName} should declare a body scope`).toBeDefined();
  return { root, body };
}

function declaredValue(scope: string, token: string): string | undefined {
  const match = new RegExp(`^\\s*${token}:\\s*([^;]+);`, "m").exec(scope);
  return match?.[1].trim();
}

describe.each(THEME_FILES)("%s caret tokens", (fileName) => {
  const { root, body } = readThemeScopes(fileName);
  const primary6 = declaredValue(body, "--color-primary-6");

  it("defines the accent it aliases", () => {
    expect(primary6).toMatch(/^#[\da-f]{6}$/i);
  });

  it.each(CARET_TOKENS)(
    "aliases %s to the accent in the body scope",
    (token) => {
      expect(declaredValue(body, token)).toBe(PRIMARY_ALIAS);
    }
  );

  it.each(CARET_TOKENS)(
    "keeps the :root literal for %s on the default accent",
    (token) => {
      expect(declaredValue(root, token)).toBe(primary6);
    }
  );
});

describe("xterm palette fallbacks", () => {
  it.each([
    ["light", "orgii_main.css"],
    ["dark", "orgii_dark.css"],
  ] as const)(
    "pins the %s pre-mount cursor to that theme's accent",
    (paletteName, fileName) => {
      const { body } = readThemeScopes(fileName);

      expect(TERMINAL_THEMES[paletteName].cursor).toBe(
        declaredValue(body, "--color-primary-6")
      );
    }
  );
});

/**
 * Sweep guard: nothing in the app may paint a caret in a color that is not the
 * accent. Design-system fields declare it per component, native fields inherit
 * the shared default in index.scss, and editors/terminals go through the
 * `--cm-editor-caret` / `--terminal-caret` aliases — those are the only three
 * shapes allowed. A caret pinned to a text color (as the code viewer's editable
 * overlay was) is the drift this catches.
 */
const ACCENT_TOKENS = [
  "--color-primary-6",
  "--cm-editor-caret",
  "--terminal-caret",
];

const SOURCE_EXTENSIONS = new Set([".scss", ".css", ".ts", ".tsx"]);

const CARET_DECLARATION = /(?:caret-color|caretColor):\s*"?([^;"\n]+)"?/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    if (!SOURCE_EXTENSIONS.has(extname(entry.name))) return [];
    if (entry.name.includes(".test.")) return [];
    return [entryPath];
  });
}

describe("caret declarations", () => {
  const srcRoot = resolve(process.cwd(), "src");

  const declarations = sourceFiles(srcRoot).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(CARET_DECLARATION)].map(
      (match) => `${relative(srcRoot, file)}: ${match[1].trim()}`
    );
  });

  it("are actually found by this sweep", () => {
    // Guards the regex itself: a scan that matches nothing would pass the
    // assertion below without having checked anything.
    expect(declarations.length).toBeGreaterThanOrEqual(6);
  });

  it("only ever paint the accent", () => {
    const offenders = declarations.filter(
      (declaration) =>
        !ACCENT_TOKENS.some((token) => declaration.includes(token))
    );

    expect(offenders).toEqual([]);
  });

  it("give native fields the accent without opting in", () => {
    const globalStyles = readFileSync(join(srcRoot, "index.scss"), "utf8");

    const sharedDefault =
      /input,\ntextarea,\n\[contenteditable=""\],\n\[contenteditable="true"\],\n\[contenteditable="plaintext-only"\] \{\n {2}caret-color: var\(--color-primary-6\);\n\}/;

    expect(globalStyles).toMatch(sharedDefault);
  });
});
