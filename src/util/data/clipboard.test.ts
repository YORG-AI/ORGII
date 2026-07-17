import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText } from "./clipboard";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("copyText", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("falls back to the native command when WKWebView leaves the browser write pending", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => new Promise<void>(() => undefined));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.mocked(invoke).mockResolvedValue(undefined);

    const copying = copyText("orgii://cloud/session?share=once");
    await vi.advanceTimersByTimeAsync(1_000);
    await copying;

    expect(writeText).toHaveBeenCalledWith("orgii://cloud/session?share=once");
    expect(invoke).toHaveBeenCalledWith("clipboard_write_text", {
      text: "orgii://cloud/session?share=once",
    });
  });
});
