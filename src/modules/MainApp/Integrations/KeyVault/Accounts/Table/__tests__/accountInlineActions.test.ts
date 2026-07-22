import { describe, expect, it } from "vitest";

import type { KeyVaultAccount } from "@src/hooks/keyVault";

import { shouldShowCodexReconnect } from "../accountInlineActions";

function createAccount(
  overrides: Partial<KeyVaultAccount> = {}
): KeyVaultAccount {
  return {
    id: "codex-account",
    hasLocalKey: true,
    isListed: false,
    modelType: "codex",
    name: "Codex",
    status: "error",
    hasKey: true,
    hasApiKey: false,
    hasSessionToken: true,
    authMethod: "oauth",
    enabled: false,
    healthStatus: "invalid",
    ...overrides,
  };
}

describe("shouldShowCodexReconnect", () => {
  it("shows reconnect for a failed local Codex OAuth account", () => {
    expect(shouldShowCodexReconnect(createAccount())).toBe(true);
  });

  it("accepts invalid health even before the mapped status becomes error", () => {
    expect(
      shouldShowCodexReconnect(
        createAccount({ status: "ready", healthStatus: "invalid" })
      )
    ).toBe(true);
  });

  it("hides reconnect for a healthy Codex OAuth account", () => {
    expect(
      shouldShowCodexReconnect(
        createAccount({ status: "ready", healthStatus: "valid", enabled: true })
      )
    ).toBe(false);
  });

  it("hides browser reauthentication for a Codex API-key account", () => {
    expect(
      shouldShowCodexReconnect(
        createAccount({ authMethod: "api_key", hasApiKey: true })
      )
    ).toBe(false);
  });

  it("hides reconnect for other invalid providers", () => {
    expect(
      shouldShowCodexReconnect(createAccount({ modelType: "claude_code" }))
    ).toBe(false);
  });

  it("hides reconnect when the credential is not stored locally", () => {
    expect(
      shouldShowCodexReconnect(createAccount({ hasLocalKey: false }))
    ).toBe(false);
  });
});
