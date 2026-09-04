import { getRelativeLuminance } from "../luminance";

describe("getRelativeLuminance", () => {
  it("returns 0 for black", () => {
    expect(getRelativeLuminance(0, 0, 0)).toBe(0);
  });

  it("returns 1 for white", () => {
    expect(getRelativeLuminance(255, 255, 255)).toBeCloseTo(1, 5);
  });

  it("uses the linear segment when normalized channel is at most 0.03928", () => {
    const channel = Math.floor(0.03928 * 255);
    const expected = (0.2126 + 0.7152 + 0.0722) * (channel / 255 / 12.92);
    expect(getRelativeLuminance(channel, channel, channel)).toBeCloseTo(
      expected,
      10
    );
  });

  it("uses the gamma segment when normalized channel is above 0.03928", () => {
    const luminance = getRelativeLuminance(128, 128, 128);
    expect(luminance).toBeGreaterThan(0);
    expect(luminance).toBeLessThan(1);
  });

  it("weights red channel per WCAG coefficients for pure red", () => {
    const redLinear = Math.pow((1 + 0.055) / 1.055, 2.4);
    expect(getRelativeLuminance(255, 0, 0)).toBeCloseTo(0.2126 * redLinear, 10);
  });
});
