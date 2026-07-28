import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getCallbackUrl,
  isTauriProduction,
  isTauriRuntime,
} from "./serviceAuth";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("service auth runtime routing", () => {
  it("uses the desktop callback during Tauri development", () => {
    vi.stubGlobal("isTauri", true);
    vi.stubGlobal("window", {
      location: { origin: "http://localhost:1998" },
    });

    expect(isTauriRuntime()).toBe(true);
    expect(isTauriProduction()).toBe(false);
    expect(getCallbackUrl()).toBe("yorgai://marketplace/callback");
  });

  it("keeps the HTTP callback outside Tauri", () => {
    vi.stubGlobal("isTauri", false);
    vi.stubGlobal("window", {
      location: { origin: "http://localhost:1998" },
    });

    expect(isTauriRuntime()).toBe(false);
    expect(getCallbackUrl()).toBe(
      "http://localhost:1998/orgii/marketplace/callback"
    );
  });
});
