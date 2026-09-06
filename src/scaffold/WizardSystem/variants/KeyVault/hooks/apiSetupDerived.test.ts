import { describe, expect, it } from "vitest";

import { DEFAULT_WIZARD_DATA } from "../config";
import { getApiSetupProceedState } from "./apiSetupDerived";

function canProceed(overrides = {}) {
  return getApiSetupProceedState({
    data: {
      ...DEFAULT_WIZARD_DATA,
      agent_type: "custom_api",
      raw_key_input: "fixture-key",
      extracted_base_url: "https://example.invalid/v1",
      enabled_models: ["new-provider/model-2026-09-01"],
      ...overrides,
    },
    isCursor: false,
    isCodex: false,
    isKiro: false,
    isClaudeCode: false,
    keyValidated: false,
    tokenDetected: false,
    sessionTokenMode: "auto",
    manualSessionToken: "",
  }).canProceed;
}

describe("manual Custom API setup", () => {
  it("can save literal IDs without successful discovery", () =>
    expect(canProceed()).toBe(true));
  it.each([
    { raw_key_input: "" },
    { extracted_base_url: "" },
    { extracted_base_url: "ftp://example.invalid" },
    { extracted_base_url: "https://user:pass@example.invalid" },
    { enabled_models: [] },
    { enabled_models: ["bad id"] },
    { enabled_models: ["x".repeat(257)] },
    { auth_method: "oauth" },
    {
      enabled_models: ["new-row"],
      model_aliases: [{ alias: "new-row", displayName: "", isDraft: true }],
    },
  ])("requires complete manual configuration: %j", (overrides) =>
    expect(canProceed(overrides)).toBe(false)
  );
  it("does not bypass another provider's authentication flow", () =>
    expect(canProceed({ agent_type: "codex" })).toBe(false));
});
