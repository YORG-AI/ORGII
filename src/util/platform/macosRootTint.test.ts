// @vitest-environment jsdom
/**
 * The macOS root tint mirrored into a native layer must equal what the CSS
 * stack painted, or the sidebar and every other transparent surface would
 * visibly change when the attribute flips. These tests pin the colour math
 * and the attribute contract; the native layer itself is exercised by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NATIVE_ROOT_TINT_ATTRIBUTE,
  compositeSrcOver,
  measureCssRootTint,
  parseCssColor,
  syncMacosRootTint,
} from "./macosRootTint";

const { invoke, isMacOS } = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
  isMacOS: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@src/util/platform/tauri", () => ({ isMacOS }));

describe("parseCssColor", () => {
  it("reads the legacy comma serialisation", () => {
    expect(parseCssColor("rgba(13, 13, 13, 0.15)")).toEqual({
      r: 13 / 255,
      g: 13 / 255,
      b: 13 / 255,
      a: 0.15,
    });
    expect(parseCssColor("rgb(255, 0, 128)")).toEqual({
      r: 1,
      g: 0,
      b: 128 / 255,
      a: 1,
    });
  });

  it("reads the modern space serialisations WebKit emits for color-mix", () => {
    expect(parseCssColor("rgb(13 13 13 / 0.15)")).toEqual({
      r: 13 / 255,
      g: 13 / 255,
      b: 13 / 255,
      a: 0.15,
    });
    expect(parseCssColor("color(srgb 0.05 0.05 0.05 / 0.15)")).toEqual({
      r: 0.05,
      g: 0.05,
      b: 0.05,
      a: 0.15,
    });
    expect(parseCssColor("color(srgb 1 0 0)")).toEqual({
      r: 1,
      g: 0,
      b: 0,
      a: 1,
    });
  });

  it("treats transparent as a zero-alpha layer", () => {
    expect(parseCssColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseCssColor("rgba(0, 0, 0, 0)")?.a).toBe(0);
  });

  it("rejects colour spaces it cannot composite in", () => {
    expect(parseCssColor("color(display-p3 1 0 0)")).toBeNull();
    expect(parseCssColor("lab(50% 0 0)")).toBeNull();
    expect(parseCssColor("url(x.png)")).toBeNull();
  });
});

describe("compositeSrcOver", () => {
  it("collapses three equal 15% tints into one 38.6% tint of the same colour", () => {
    const tint = { r: 13 / 255, g: 13 / 255, b: 13 / 255, a: 0.15 };
    const result = compositeSrcOver([tint, tint, tint]);
    expect(result.a).toBeCloseTo(1 - 0.85 ** 3, 10);
    expect(result.r).toBeCloseTo(tint.r, 10);
    expect(result.g).toBeCloseTo(tint.g, 10);
    expect(result.b).toBeCloseTo(tint.b, 10);
  });

  it("weights an upper layer by its own alpha over the lower composite", () => {
    const below = { r: 0, g: 0, b: 0, a: 0.5 };
    const above = { r: 1, g: 1, b: 1, a: 0.5 };
    const result = compositeSrcOver([below, above]);
    expect(result.a).toBeCloseTo(0.75, 10);
    // 0.5 of white over 0.25 of black, normalised by 0.75.
    expect(result.r).toBeCloseTo(0.5 / 0.75, 10);
  });

  it("is transparent when every layer is", () => {
    expect(compositeSrcOver([{ r: 1, g: 1, b: 1, a: 0 }])).toEqual({
      r: 0,
      g: 0,
      b: 0,
      a: 0,
    });
  });
});

describe("syncMacosRootTint", () => {
  const html = document.documentElement;

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    isMacOS.mockReturnValue(true);
    delete html.dataset[NATIVE_ROOT_TINT_ATTRIBUTE];
    html.style.backgroundColor = "rgba(13, 13, 13, 0.15)";
    document.body.style.backgroundColor = "rgba(13, 13, 13, 0.15)";
    document.body.innerHTML = '<div id="root"></div>';
    document.getElementById("root")!.style.backgroundColor =
      "rgba(13, 13, 13, 0.15)";
  });

  afterEach(() => {
    delete html.dataset[NATIVE_ROOT_TINT_ATTRIBUTE];
    html.style.backgroundColor = "";
    document.body.style.backgroundColor = "";
    document.body.innerHTML = "";
  });

  it("pushes the composite of html, body and #root, then flips the attribute", async () => {
    await syncMacosRootTint();

    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, args] = invoke.mock.calls[0];
    expect(command).toBe("set_window_root_tint");
    const color = (args as { color: number[] }).color;
    expect(color[0]).toBeCloseTo(13 / 255, 10);
    expect(color[3]).toBeCloseTo(1 - 0.85 ** 3, 10);
    expect(html.dataset[NATIVE_ROOT_TINT_ATTRIBUTE]).toBe("1");
  });

  it("measures the stylesheet, not the transparent override, on a re-sync", () => {
    html.dataset[NATIVE_ROOT_TINT_ATTRIBUTE] = "1";
    // jsdom does not apply the attribute rule from index.scss, so stand in
    // for it: the read must lift the attribute while measuring and restore it.
    const observed: Array<string | undefined> = [];
    const original = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      observed.push(html.dataset[NATIVE_ROOT_TINT_ATTRIBUTE]);
      return original(element);
    });

    const tint = measureCssRootTint();

    expect(observed).toEqual([undefined, undefined, undefined]);
    expect(html.dataset[NATIVE_ROOT_TINT_ATTRIBUTE]).toBe("1");
    expect(tint?.a).toBeCloseTo(1 - 0.85 ** 3, 10);
    vi.restoreAllMocks();
  });

  it("keeps the CSS tint when the native call fails", async () => {
    invoke.mockRejectedValue(new Error("window closed"));

    await expect(syncMacosRootTint()).resolves.toBeUndefined();

    expect(html.dataset[NATIVE_ROOT_TINT_ATTRIBUTE]).toBeUndefined();
  });

  it("coalesces a call made while a push is in flight into one follow-up", async () => {
    let release: () => void = () => {};
    invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const first = syncMacosRootTint();
    const second = syncMacosRootTint();
    const third = syncMacosRootTint();
    expect(second).toBe(first);
    expect(third).toBe(first);
    // The first invoke only happens after the dynamic import resolves.
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    release();
    await first;

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("is a no-op off macOS", async () => {
    isMacOS.mockReturnValue(false);

    await syncMacosRootTint();

    expect(invoke).not.toHaveBeenCalled();
    expect(html.dataset[NATIVE_ROOT_TINT_ATTRIBUTE]).toBeUndefined();
  });
});
