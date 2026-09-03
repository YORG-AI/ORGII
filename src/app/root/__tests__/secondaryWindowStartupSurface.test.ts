import { readFileSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

/**
 * Startup-surface guard for macOS detached (session) windows.
 *
 * A detached window is built transparent with an NSVisualEffectView mounted
 * behind its webview, and it settles on that vibrancy — `html[data-host-
 * desktop="macos"]` in src/index.scss paints only a 15% tint. So its
 * pre-paint surface must already BE the vibrancy. Anything opaque painted in
 * the meantime is visible as a flash, and the window is on screen for the
 * whole cold boot of its own webview (each Tauri window re-parses and
 * re-executes the bundle), so "in the meantime" is hundreds of milliseconds.
 *
 * Two independent sources used to paint over it, and each is pinned below:
 *
 * 1. index.html's splash plate, `html, body, #root { background:
 *    var(--splash-bg) }`. On a light theme --splash-bg is #ffffff, and
 *    secondary windows suppress the splash mark, so this was a bare white
 *    rectangle.
 * 2. `apply_window_background_color` in the Rust open path, which enables
 *    WKWebView background drawing — the webview then paints its own opaque
 *    base beneath the page instead of compositing onto the material.
 *
 * Both halves are asserted here because neither alone removes the flash.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");

const MACOS_SECONDARY_PREFIX =
  'html[data-host-desktop="macos"][data-orgii-secondary-window]';

/** Subjects the splash plate paints, and that the override must neutralize. */
const PLATE_SUBJECTS = ["html", "body", "#root"] as const;

/**
 * Drop `//` comments so the Rust assertions below read calls, not prose —
 * the function documents at length which helper it must NOT call. Naive on
 * purpose: `open_session_window` contains no string literal holding `//`.
 */
function stripLineComments(rust: string): string {
  return rust
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function readIndexHtmlStyles(): postcss.Root {
  const html = readFileSync(path.join(REPO_ROOT, "public/index.html"), "utf8");
  const opening = html.indexOf("<style");
  const contentStart = html.indexOf(">", opening) + 1;
  const contentEnd = html.indexOf("</style>", contentStart);
  expect(opening).toBeGreaterThan(-1);
  expect(contentEnd).toBeGreaterThan(contentStart);

  return postcss.parse(html.slice(contentStart, contentEnd));
}

/**
 * Rules in document order, flattened out of `@layer base`. Order matters:
 * the override and the plate sit in the same layer, so the later rule wins
 * any tie — though it does not need the tie-break, see below.
 */
function backgroundRules(root: postcss.Root): {
  selectors: string[];
  background: string;
}[] {
  const rules: { selectors: string[]; background: string }[] = [];

  root.walkRules((rule) => {
    let background: string | undefined;
    rule.walkDecls("background", (decl) => {
      background = decl.value;
    });
    if (background === undefined) return;
    rules.push({
      selectors: rule.selectors.map((selector) => selector.trim()),
      background,
    });
  });

  return rules;
}

describe("macOS detached-window startup surface", () => {
  describe("index.html splash plate", () => {
    const rules = backgroundRules(readIndexHtmlStyles());

    const plateIndex = rules.findIndex(
      (rule) =>
        rule.background === "var(--splash-bg)" &&
        PLATE_SUBJECTS.every((subject) => rule.selectors.includes(subject))
    );
    const overrideIndex = rules.findIndex(
      (rule) =>
        rule.background === "transparent" &&
        rule.selectors.every((selector) =>
          selector.startsWith(MACOS_SECONDARY_PREFIX)
        ) &&
        rule.selectors.length === PLATE_SUBJECTS.length
    );

    it("still paints the opaque plate on the default startup surface", () => {
      // Not a leftover: a main window (and every non-macOS window) is opaque
      // before first paint and would otherwise flash black on a light theme.
      expect(plateIndex).toBeGreaterThan(-1);
    });

    it("neutralizes the plate for macOS secondary windows", () => {
      expect(overrideIndex).toBeGreaterThan(-1);
    });

    it("neutralizes every subject the plate paints", () => {
      // A subject left behind is a full-window opaque rectangle of its own:
      // #root alone covers the viewport.
      const overrideSubjects = rules[overrideIndex].selectors.map((selector) =>
        selector.slice(MACOS_SECONDARY_PREFIX.length).trim()
      );

      // `html[...][...]` itself is the html subject, written without a
      // descendant part; body and #root are descendants of it.
      expect(new Set(overrideSubjects)).toEqual(new Set(["", "body", "#root"]));
    });

    it("wins the cascade over the plate", () => {
      // Same layer, so this is decided on specificity and then order. Each
      // override selector is the plate's own selector qualified with two
      // attribute selectors on <html>, which is strictly more specific; the
      // source order below only guards against a future equal-specificity
      // rewrite.
      expect(overrideIndex).toBeGreaterThan(plateIndex);
    });

    it("does not leak the transparent surface to other hosts or to main", () => {
      // Windows/Linux secondary windows are opaque (transparent(true) in
      // open_session_window is macOS-only) and a macOS MAIN window keeps the
      // plate, so both attribute qualifiers must stay on the selector.
      for (const selector of rules[overrideIndex].selectors) {
        expect(selector).toContain('[data-host-desktop="macos"]');
        expect(selector).toContain("[data-orgii-secondary-window]");
      }
    });
  });

  describe("open_session_window native chrome", () => {
    const source = readFileSync(
      path.join(REPO_ROOT, "src-tauri/crates/app-window/src/commands.rs"),
      "utf8"
    );
    const start = source.indexOf("pub async fn open_session_window");
    const end = source.indexOf("mod session_window_tests", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const openFn = stripLineComments(source.slice(start, end));

    it("does not enable WKWebView background drawing", () => {
      // `apply_window_background_color` is correct for the main window, whose
      // settled surface is opaque. Here it repaints the vibrancy away.
      expect(openFn).not.toContain("apply_window_background_color");
    });

    it("mounts the vibrancy material and clears the builder backdrop", () => {
      expect(openFn).toContain("apply_macos_window_material");
      expect(openFn).toContain("remove_window_background_color");
    });

    it("shows the window only after its chrome is applied", () => {
      // Built hidden so the pre-chrome frames never reach the screen. The
      // show() is part of creation, not deferred to first paint — deferring
      // it would make the click that opened the window feel dead.
      expect(openFn).toContain(".visible(false)");
      expect(openFn).toMatch(/window\s*\n?\s*\.show\(\)/);
      expect(openFn.indexOf("apply_macos_window_material")).toBeLessThan(
        openFn.search(/window\s*\n?\s*\.show\(\)/)
      );
    });
  });
});
