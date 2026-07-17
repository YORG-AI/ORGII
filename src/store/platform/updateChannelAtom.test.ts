import { resolveUpdateChannel } from "./updateChannelAtom";

describe("resolveUpdateChannel", () => {
  it("follows the installed build when preference is auto", () => {
    expect(resolveUpdateChannel("auto", "1.1.24")).toBe("stable");
    expect(resolveUpdateChannel("auto", "1.2.0-beta.1")).toBe("beta");
    expect(resolveUpdateChannel("auto", "1.2.0-rc.2")).toBe("beta");
  });

  it("falls back to stable when the version is unknown", () => {
    expect(resolveUpdateChannel("auto", undefined)).toBe("stable");
  });

  it("respects an explicit channel regardless of the build", () => {
    expect(resolveUpdateChannel("stable", "1.2.0-beta.1")).toBe("stable");
    expect(resolveUpdateChannel("beta", "1.1.24")).toBe("beta");
  });
});
