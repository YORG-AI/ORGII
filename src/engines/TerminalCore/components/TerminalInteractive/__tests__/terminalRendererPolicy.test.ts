import { describe, expect, it } from "vitest";

import { shouldLoadTerminalWebgl } from "../terminalRendererPolicy";

describe("terminal renderer policy", () => {
  it("disables WebGL on Linux WebKit to avoid llvmpipe CPU storms", () => {
    expect(
      shouldLoadTerminalWebgl({
        processPlatform: "linux",
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 Safari/605.1.15",
      })
    ).toBe(false);
  });

  it("allows WebGL on macOS and Windows by default", () => {
    expect(
      shouldLoadTerminalWebgl({
        processPlatform: "darwin",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15",
      })
    ).toBe(true);
    expect(
      shouldLoadTerminalWebgl({
        processPlatform: "win32",
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      })
    ).toBe(true);
  });
});
