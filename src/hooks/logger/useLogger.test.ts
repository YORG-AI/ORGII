import { describe, expect, it } from "vitest";

import { isTauriRuntimeHost } from "./useLogger";

describe("isTauriRuntimeHost", () => {
  it("recognizes the Tauri v2 runtime marker", () => {
    expect(isTauriRuntimeHost({ __TAURI_INTERNALS__: {} })).toBe(true);
  });

  it("does not depend on the removed Tauri v1 global", () => {
    expect(isTauriRuntimeHost({ __TAURI__: {} })).toBe(false);
    expect(isTauriRuntimeHost(undefined)).toBe(false);
  });
});
