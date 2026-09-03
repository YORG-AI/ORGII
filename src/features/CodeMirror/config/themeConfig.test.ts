/**
 * The theme factories must hand back the *same* extension instance on every
 * call.
 *
 * Two separate costs ride on this. `createGithubTheme()` allocates an
 * `EditorView.theme` plus a `HighlightStyle`, i.e. two style-mod
 * `StyleModule`s, and style-mod never unmounts a module once its rules are in
 * the document. And `@uiw/react-codemirror` reconfigures the view whenever the
 * `theme` extension's identity changes — `Editor/index.tsx` calls
 * `getCodeMirrorTheme()` straight from its render body, so a fresh instance per
 * call meant a fresh set of permanent CSS rules per keystroke.
 *
 * Reference equality is the whole invariant, so that is what these assert.
 */
import { describe, expect, it } from "vitest";

import { createCodeMirrorTheme, getCodeMirrorTheme } from "./themeConfig";

describe("getCodeMirrorTheme", () => {
  it("returns the same instance across calls", () => {
    expect(getCodeMirrorTheme()).toBe(getCodeMirrorTheme());
  });

  it("returns a non-empty extension", () => {
    // Guards against the cache latching onto an empty/undefined value and the
    // identity assertion above passing vacuously.
    expect(getCodeMirrorTheme()).toEqual(expect.any(Array));
    expect(getCodeMirrorTheme() as unknown[]).toHaveLength(2);
  });
});

describe("createCodeMirrorTheme", () => {
  it("returns the same instance across calls", () => {
    expect(createCodeMirrorTheme()).toBe(createCodeMirrorTheme());
  });

  it("is a distinct extension from the syntax theme", () => {
    // The two factories are separate extensions with different roles; caching
    // must not collapse them onto one another.
    expect(createCodeMirrorTheme()).not.toBe(getCodeMirrorTheme());
  });
});
