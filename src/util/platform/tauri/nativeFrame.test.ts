import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getNativeFrameScale,
  resolveNativeFrameScale,
  toNativeFrame,
  toNativeFrameFromCorners,
} from "./nativeFrame";

function makeDOMRect(
  x: number,
  y: number,
  width: number,
  height: number
): DOMRect {
  return {
    x,
    y,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    toJSON() {
      return this;
    },
  };
}

function stubNativeFrameScale(value: string): void {
  const mockGetPropertyValue = vi
    .fn()
    .mockImplementation((property: string) => {
      if (property === "--native-frame-scale") return value;
      return "";
    });
  vi.stubGlobal("document", {
    documentElement: {
      style: { getPropertyValue: vi.fn() },
    },
  });
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: mockGetPropertyValue,
  }));
}

describe("getNativeFrameScale", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 1 when document is undefined", () => {
    vi.stubGlobal("document", undefined);
    expect(getNativeFrameScale()).toBe(1);
  });

  it("returns 1 when --native-frame-scale is empty", () => {
    stubNativeFrameScale("");
    expect(getNativeFrameScale()).toBe(1);
  });

  it("returns the numeric value of --native-frame-scale", () => {
    stubNativeFrameScale("0.8");
    expect(getNativeFrameScale()).toBeCloseTo(0.8);
  });

  it("returns 1 for invalid scale values", () => {
    stubNativeFrameScale("abc");
    expect(getNativeFrameScale()).toBe(1);

    stubNativeFrameScale("0");
    expect(getNativeFrameScale()).toBe(1);

    stubNativeFrameScale("-0.5");
    expect(getNativeFrameScale()).toBe(1);
  });

  it("handles whitespace-padded values", () => {
    stubNativeFrameScale("  1.5  ");
    expect(getNativeFrameScale()).toBeCloseTo(1.5);
  });
});

describe("toNativeFrame", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns start and end corners when scale is 1", () => {
    stubNativeFrameScale("1");
    const rect = makeDOMRect(100, 200, 800, 600);
    expect(toNativeFrame(rect)).toEqual({
      x: 100,
      y: 200,
      a: 900,
      b: 800,
      width: 800,
      height: 600,
    });
  });

  it("multiplies all corners by the native frame scale", () => {
    stubNativeFrameScale("0.8");
    const rect = makeDOMRect(100, 200, 800, 600);
    expect(toNativeFrame(rect)).toEqual({
      x: 80,
      y: 160,
      a: 720,
      b: 640,
      width: 640,
      height: 480,
    });
  });

  it("applies inset before scaling", () => {
    stubNativeFrameScale("1");
    const rect = makeDOMRect(10, 20, 200, 100);
    expect(toNativeFrame(rect, 2)).toEqual({
      x: 12,
      y: 22,
      a: 208,
      b: 118,
      width: 196,
      height: 96,
    });
  });

  it("applies inset and scale together", () => {
    stubNativeFrameScale("2");
    const rect = makeDOMRect(10, 20, 200, 100);
    expect(toNativeFrame(rect, 5)).toEqual({
      x: 30,
      y: 50,
      a: 410,
      b: 230,
      width: 380,
      height: 180,
    });
  });

  it("rounds start and end corners before deriving size", () => {
    expect(
      toNativeFrameFromCorners({
        left: 10.4,
        top: 20.4,
        right: 111.6,
        bottom: 71.6,
      })
    ).toEqual({ x: 10, y: 20, a: 112, b: 72, width: 102, height: 52 });
  });

  it("rounds results to nearest integer", () => {
    stubNativeFrameScale("0.75");
    const rect = makeDOMRect(1, 1, 10, 10);
    const result = toNativeFrame(rect);
    expect(Number.isInteger(result.x)).toBe(true);
    expect(Number.isInteger(result.y)).toBe(true);
    expect(Number.isInteger(result.a)).toBe(true);
    expect(Number.isInteger(result.b)).toBe(true);
    expect(Number.isInteger(result.width)).toBe(true);
    expect(Number.isInteger(result.height)).toBe(true);
  });

  it("defaults inset to 0 when not provided", () => {
    stubNativeFrameScale("1");
    const rect = makeDOMRect(0, 0, 100, 50);
    expect(toNativeFrame(rect)).toEqual({
      x: 0,
      y: 0,
      a: 100,
      b: 50,
      width: 100,
      height: 50,
    });
  });
});

describe("resolveNativeFrameScale", () => {
  it("uses the measured DOM CSS pixel to Tauri logical pixel ratio", () => {
    expect(resolveNativeFrameScale(1.575, 1.5, 1)).toBeCloseTo(1.05);
  });

  it("falls back when the measured ratio is invalid", () => {
    expect(resolveNativeFrameScale(1.5, 0, 0.9)).toBe(0.9);
    expect(resolveNativeFrameScale(Number.NaN, 1.5, 0.9)).toBe(0.9);
    expect(resolveNativeFrameScale(1.5, Number.POSITIVE_INFINITY, 0.9)).toBe(
      0.9
    );
  });

  it("uses 1 when both the measured ratio and fallback are invalid", () => {
    expect(resolveNativeFrameScale(1.5, 0, 0)).toBe(1);
    expect(resolveNativeFrameScale(1.5, 0, Number.NaN)).toBe(1);
  });
});
