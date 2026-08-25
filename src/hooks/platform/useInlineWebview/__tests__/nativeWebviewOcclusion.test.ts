import {
  coalesceOcclusionRects,
  computeNativeWebviewOcclusions,
} from "../nativeWebviewOcclusion";

describe("nativeWebviewOcclusion", () => {
  it("intersects viewport overlays and converts them to local scaled points", () => {
    expect(
      computeNativeWebviewOcclusions(
        { left: 100, top: 50, right: 500, bottom: 350 },
        [
          { x: 450, y: 20, width: 100, height: 100 },
          { x: 10, y: 10, width: 20, height: 20 },
        ],
        1.25
      )
    ).toEqual([{ x: 438, y: 0, width: 62, height: 87 }]);
  });

  it("returns no holes for overlays outside the webview", () => {
    expect(
      computeNativeWebviewOcclusions(
        { left: 100, top: 100, right: 300, bottom: 300 },
        [{ x: 0, y: 0, width: 50, height: 50 }],
        1
      )
    ).toEqual([]);
  });

  it("merges overlapping holes so even-odd masking cannot XOR the overlap", () => {
    expect(
      coalesceOcclusionRects([
        { x: 10, y: 10, width: 30, height: 30 },
        { x: 30, y: 20, width: 30, height: 20 },
        { x: 80, y: 80, width: 10, height: 10 },
      ])
    ).toEqual([
      { x: 10, y: 10, width: 50, height: 30 },
      { x: 80, y: 80, width: 10, height: 10 },
    ]);
  });

  it("rejects invalid geometry and scale", () => {
    expect(
      computeNativeWebviewOcclusions(
        { left: 0, top: 0, right: 100, bottom: 100 },
        [{ x: 10, y: 10, width: Number.NaN, height: 20 }],
        1
      )
    ).toEqual([]);
    expect(
      computeNativeWebviewOcclusions(
        { left: 0, top: 0, right: 100, bottom: 100 },
        [{ x: 10, y: 10, width: 20, height: 20 }],
        0
      )
    ).toEqual([]);
  });
});
