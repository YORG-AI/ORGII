import { readFileSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

/**
 * Startup-surface guard for macOS windows: the main window and detached
 * (session) windows alike.
 *
 * A macOS window is built transparent with an NSVisualEffectView mounted
 * behind its webview, and it settles on that vibrancy — `html[data-host-
 * desktop="macos"]` in src/index.scss paints only a 15% tint over it. So its
 * pre-paint surface must already BE that tinted vibrancy. Anything opaque
 * painted in the meantime is visible as a flash the moment it drops away,
 * and the window is on screen for the whole cold boot of its webview (each
 * Tauri window re-parses and re-executes the bundle), so "in the meantime" is
 * hundreds of milliseconds — seconds on a dev server.
 *
 * Three independent sources used to paint over it, and each is pinned below:
 *
 * 1. index.html's splash plate, `html, body, #root { background:
 *    var(--splash-bg) }`. On a light theme --splash-bg is #ffffff: a bare
 *    white rectangle that the bundle's stylesheet then replaced with the 15%
 *    tint in a single frame — the "white, then transparent" flip.
 * 2. `apply_window_background_color` in the Rust window paths, which enabled
 *    WKWebView background drawing under a #0d0d0d plate — the webview then
 *    painted its own opaque base beneath the page instead of compositing
 *    onto the material, until the bundle's `remove_window_background` call.
 * 3. A window created visible. Tauri shows it at creation, before the setup
 *    hook has mounted any chrome, so the pre-chrome frames (a clear window
 *    with nothing behind the webview) reached the screen first.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");

const MACOS_HOST = 'html[data-host-desktop="macos"]';

/** Subjects the splash plate paints, and that the override must neutralize. */
const PLATE_SUBJECTS = ["html", "body", "#root"] as const;

/**
 * The settled macOS surface in src/index.scss. The splash override must mix
 * the same share of the app surface into transparent, or the hand-off from
 * the splash to the bundle is itself a visible step.
 */
const SETTLED_TINT_SHARE = "15%";

/**
 * Drop `//` comments so the Rust assertions below read calls, not prose —
 * the functions document at length which helper they must NOT call. Naive on
 * purpose: none of the inspected functions contain a string literal holding
 * `//`.
 */
function stripLineComments(rust: string): string {
  return rust
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function readRepoFile(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

function readIndexHtmlStyles(): postcss.Root {
  const html = readRepoFile("public/index.html");
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

/** The body of a Rust function, from its signature to the given end marker. */
function rustFunction(source: string, signature: string, endMarker: string) {
  const start = source.indexOf(signature);
  const end = source.indexOf(endMarker, start);
  expect(start, signature).toBeGreaterThan(-1);
  expect(end, endMarker).toBeGreaterThan(start);
  return stripLineComments(source.slice(start, end));
}

/**
 * The macOS block of a Rust function: everything after its first
 * `#[cfg(target_os = "macos")]` attribute. Enough for call-order assertions;
 * the block is the only macOS-gated code in each inspected function.
 */
function macosBlock(fn: string): string {
  const start = fn.indexOf('#[cfg(target_os = "macos")]');
  expect(start).toBeGreaterThan(-1);
  return fn.slice(start);
}

function expectVibrancyChromeBeforeShow(block: string, showPattern: RegExp) {
  // `apply_window_background_color` enabled WKWebView background drawing
  // under an opaque plate; nothing may bring it back on any macOS window.
  expect(block).not.toContain("apply_window_background_color");
  expect(block).toContain("apply_macos_window_material");
  expect(block).toContain("remove_window_background_color");

  // Material first (mounted below the webview), then the backdrop cleared
  // so the webview composites onto it, then — and only then — shown.
  const material = block.indexOf("apply_macos_window_material");
  const clear = block.indexOf("remove_window_background_color");
  const show = block.search(showPattern);
  expect(show).toBeGreaterThan(-1);
  expect(material).toBeLessThan(clear);
  expect(clear).toBeLessThan(show);
}

describe("macOS window startup surface", () => {
  describe("index.html splash plate", () => {
    const rules = backgroundRules(readIndexHtmlStyles());

    const plateIndex = rules.findIndex(
      (rule) =>
        rule.background === "var(--splash-bg)" &&
        PLATE_SUBJECTS.every((subject) => rule.selectors.includes(subject))
    );
    const overrideIndex = rules.findIndex(
      (rule) =>
        rule.selectors.every((selector) => selector.startsWith(MACOS_HOST)) &&
        rule.selectors.length === PLATE_SUBJECTS.length
    );

    it("still paints the opaque plate on the default startup surface", () => {
      // Not a leftover: Windows and Linux windows are opaque before first
      // paint and would otherwise flash black on a light theme.
      expect(plateIndex).toBeGreaterThan(-1);
    });

    it("overrides the plate for every macOS window, not only detached ones", () => {
      expect(overrideIndex).toBeGreaterThan(-1);
      // The main window settles on the same vibrancy as a detached window;
      // qualifying the override with the secondary-window marker left the
      // main window on the white plate.
      for (const selector of rules[overrideIndex].selectors) {
        expect(selector).not.toContain("data-orgii-secondary-window");
      }
    });

    it("paints the settled tint, not a plate and not bare transparent", () => {
      // The bundle's `html[data-host-desktop="macos"]` rule mixes 15% of the
      // app surface into transparent. Anything else here — the opaque plate,
      // or fully transparent — is a visible step at the hand-off.
      expect(rules[overrideIndex].background).toBe(
        `color-mix(in srgb, var(--splash-bg) ${SETTLED_TINT_SHARE}, transparent)`
      );
    });

    it("mirrors the share used by the settled surface in src/index.scss", () => {
      const scss = readRepoFile("src/index.scss");
      // Whitespace-tolerant: prettier wraps the color-mix() arguments.
      const settled = scss.match(
        /html\[data-host-desktop="macos"\],\s*html\[data-host-desktop="macos"\] body,\s*html\[data-host-desktop="macos"\] #root \{\s*background: color-mix\(\s*in srgb,\s*var\(--color-bg-2, var\(--splash-bg\)\) (\d+%),\s*transparent\s*\);/
      );
      expect(
        settled,
        "settled macOS surface rule in src/index.scss, falling back to --splash-bg"
      ).not.toBeNull();
      expect(settled?.[1]).toBe(SETTLED_TINT_SHARE);
    });

    it("keeps the settled surfaces painted while the theme stylesheet loads", () => {
      // --color-bg-2 is defined by the theme <link> initTheme() attaches at
      // runtime. A root rule reading it without a fallback computes to
      // transparent for the frames in between — a flash on every host.
      const scss = readRepoFile("src/index.scss");
      const rootSurfacesEnd = scss.indexOf(
        'html[data-host-desktop="windows"] .sidebar-base'
      );
      expect(rootSurfacesEnd).toBeGreaterThan(-1);
      // Only the root-level surfaces: the html/body rules and the per-host
      // overrides above that marker. Component rules paint after boot.
      const rootDecls =
        scss
          .slice(0, rootSurfacesEnd)
          .match(/background: [^;]*--color-bg-2[^;]*;/g) ?? [];
      expect(rootDecls.length).toBeGreaterThanOrEqual(4);
      for (const decl of rootDecls) {
        expect(decl).toContain("var(--color-bg-2, var(--splash-bg))");
      }
    });

    it("neutralizes every subject the plate paints", () => {
      // A subject left behind is a full-window opaque rectangle of its own:
      // #root alone covers the viewport.
      const overrideSubjects = rules[overrideIndex].selectors.map((selector) =>
        selector.slice(MACOS_HOST.length).trim()
      );

      // `html[...]` itself is the html subject, written without a descendant
      // part; body and #root are descendants of it.
      expect(new Set(overrideSubjects)).toEqual(new Set(["", "body", "#root"]));
    });

    it("wins the cascade over the plate", () => {
      // Same layer, so this is decided on specificity and then order. Each
      // override selector is the plate's own selector qualified with an
      // attribute selector on <html>, which is strictly more specific; the
      // source order below only guards against a future equal-specificity
      // rewrite.
      expect(overrideIndex).toBeGreaterThan(plateIndex);
    });

    it("does not leak the tinted surface to other hosts", () => {
      // Windows/Linux windows are opaque (transparent(true) in
      // open_session_window is macOS-only, and the main window's Windows
      // config paints its own backdrop), so the host qualifier must stay.
      for (const selector of rules[overrideIndex].selectors) {
        expect(selector).toContain('[data-host-desktop="macos"]');
      }
    });
  });

  describe("main window", () => {
    it("is built hidden so pre-chrome frames never reach the screen", () => {
      const config = JSON.parse(readRepoFile("src-tauri/tauri.conf.json")) as {
        app: { windows: { label: string; visible?: boolean }[] };
      };
      const main = config.app.windows.find((window) => window.label === "main");
      expect(main).toBeDefined();
      // Tauri shows a `visible` window at creation, before the setup hook
      // runs; the setup hook shows it itself once the chrome is mounted.
      expect(main?.visible).toBe(false);
    });

    it("mounts vibrancy and clears the backdrop before the setup hook shows it", () => {
      const source = readRepoFile("src-tauri/src/app/setup_hook/window.rs");
      const fn = rustFunction(
        source,
        "pub(crate) fn init_runtime_profile_and_window",
        "Ok(runtime_profile)"
      );
      // The `webdriver` debug block earlier in the function shows the window
      // on its own for E2E; the chrome block is the one after
      // `apply_host_desktop_window_chrome`.
      const chrome = fn.slice(fn.indexOf("apply_host_desktop_window_chrome"));
      const block = macosBlock(chrome);
      expectVibrancyChromeBeforeShow(block, /show_after_queued_native_layout/);
      // A synchronous show() would order the window in at its config size,
      // ahead of tao's asynchronously dispatched `maximized` zoom.
      expect(block).not.toMatch(/main_window\s*\.show\(\)/);
    });

    it("gets the same chrome when recreated from the menu", () => {
      const source = readRepoFile("src-tauri/crates/app-window/src/lib.rs");
      const fn = rustFunction(
        source,
        "pub fn recreate_main_window",
        "// Tauri commands live in `commands.rs`"
      );
      expectVibrancyChromeBeforeShow(
        macosBlock(fn),
        /show_after_queued_native_layout/
      );
    });

    it("has no opaque-backdrop helper left to reach for", () => {
      // Deleted, not merely unused: an available helper whose doc comment
      // promised to "fix the transparent flash" is how the plate came back.
      const source = readRepoFile("src-tauri/crates/app-window/src/lib.rs");
      expect(source).not.toContain("fn apply_window_background_color");
    });
  });

  describe("open_session_window native chrome", () => {
    const source = readRepoFile("src-tauri/crates/app-window/src/commands.rs");
    const openFn = rustFunction(
      source,
      "pub async fn open_session_window",
      "mod session_window_tests"
    );

    it("mounts vibrancy and clears the builder backdrop before showing", () => {
      expectVibrancyChromeBeforeShow(
        macosBlock(openFn),
        /window\s*\n?\s*\.show\(\)/
      );
    });

    it("is built hidden and shown as part of creation", () => {
      // Built hidden so the pre-chrome frames never reach the screen. The
      // show() is part of creation, not deferred to first paint — deferring
      // it would make the click that opened the window feel dead.
      expect(openFn).toContain(".visible(false)");
      expect(openFn).toMatch(/window\s*\n?\s*\.show\(\)/);
    });
  });
});
