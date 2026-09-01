/**
 * Guards the one structural gap between where the base stylesheets declare a
 * token and where a skin overrides it.
 *
 * Skin tokens are written as inline custom properties on `<body>`. A custom
 * property declared at `:root` as an alias — `--a: var(--b)` — has its `var()`
 * substituted against `:root`'s own properties, and descendants inherit the
 * already-substituted result. So overriding `--b` on `<body>` does **not**
 * move `--a`: it keeps whatever the stylesheet computed.
 *
 * That is invisible until two surfaces that are meant to share a color stop
 * matching. It shipped once, as a line-number gutter that kept the base
 * editor background while the code beside it took the skin's.
 *
 * Any `:root` alias whose referent a skin overrides must therefore be emitted
 * by the skin too. This test reads the shipped stylesheets rather than a
 * hand-maintained list, so a new alias is caught when it is added.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SKIN_TOKEN_KEYS } from "./deriveSkinTokens";

const STYLESHEETS = ["orgii_main.css", "orgii_dark.css"];

interface Declarations {
  root: Map<string, string>;
  body: Set<string>;
}

function readStylesheet(name: string): Declarations {
  const css = readFileSync(join(process.cwd(), "public", name), "utf8");
  const block = (selector: string): string =>
    new RegExp(`^${selector} \\{(.*?)^\\}`, "ms").exec(css)?.[1] ?? "";

  const root = new Map<string, string>();
  for (const match of block(":root").matchAll(
    /^\s*(--[a-z0-9-]+):\s*([^;]*);/gms
  )) {
    root.set(match[1], match[2]);
  }

  const body = new Set<string>();
  for (const match of block("body").matchAll(/^\s*(--[a-z0-9-]+):/gm)) {
    body.add(match[1]);
  }

  return { root, body };
}

describe("root-scope alias parity", () => {
  const skinTokens = new Set(SKIN_TOKEN_KEYS);

  it.each(STYLESHEETS)(
    "%s: every :root alias to a skin-owned token is itself skin-owned",
    (name) => {
      const { root, body } = readStylesheet(name);
      const stale: string[] = [];

      for (const [key, value] of root) {
        // Redeclared on `body` — the body declaration wins for descendants and
        // resolves against the skin's values, so the alias is not stale.
        if (body.has(key)) continue;
        if (skinTokens.has(key)) continue;

        for (const [, referent] of value.matchAll(/var\((--[a-z0-9-]+)/g)) {
          if (skinTokens.has(referent)) {
            stale.push(`${key} -> var(${referent})`);
          }
        }
      }

      expect(
        stale,
        `These :root aliases point at tokens a skin overrides on <body>, so they ` +
          `keep the stylesheet's value and drift out of sync. Emit them from ` +
          `deriveSkinTokens, or move their declaration into the body scope.`
      ).toEqual([]);
    }
  );

  it("finds the declarations it is meant to be checking", () => {
    // A regex that silently matched nothing would make this suite vacuous.
    for (const name of STYLESHEETS) {
      const { root, body } = readStylesheet(name);
      expect(root.size, name).toBeGreaterThan(20);
      expect(body.size, name).toBeGreaterThan(20);
      expect(root.has("--cm-editor-gutter-bg"), name).toBe(true);
    }
  });
});
