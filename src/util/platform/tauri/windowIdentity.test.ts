import { afterEach, describe, expect, it } from "vitest";

import {
  getCurrentWindowLabel,
  isMainAppWindow,
  resetWindowIdentityForTests,
} from "./windowIdentity";

describe("windowIdentity", () => {
  afterEach(() => {
    resetWindowIdentityForTests();
  });

  it("treats a non-Tauri environment as the main app window", () => {
    // vitest has no __TAURI_INTERNALS__, so isTauriDesktop() is false.
    expect(getCurrentWindowLabel()).toBeNull();
    expect(isMainAppWindow()).toBe(true);
  });

  it("caches the resolved label", () => {
    expect(getCurrentWindowLabel()).toBeNull();
    expect(getCurrentWindowLabel()).toBeNull();
  });
});
