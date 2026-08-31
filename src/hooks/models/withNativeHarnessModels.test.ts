/**
 * Unit tests for withNativeHarnessModels, withCodexOAuthModels and related helpers.
 *
 * The withNativeHarnessModels function is not covered by existing tests;
 * it only processes accounts when dispatchCategory === "rust_agent".
 *
 * Also covers withCodexOAuthModels which is uncovered (unlike withClaudeCodeOAuthModels).
 */
import { describe, expect, it } from "vitest";

import { NATIVE_HARNESS_TYPE } from "@src/api/tauri/rpc/schemas/validation";
import { CLI_AGENT } from "@src/api/types/keys";
import type { KeyVaultAccount } from "@src/hooks/keyVault/types";

import {
  isClaudeCodeOAuthAccount,
  isCodexOAuthAccount,
  isCursorNativeAccount,
  withCodexOAuthModels,
  withNativeHarnessModels,
} from "./nativeHarnessAccountModels";

function baseAccount(
  overrides: Partial<KeyVaultAccount> = {}
): KeyVaultAccount {
  return {
    id: "test-id",
    hasLocalKey: false,
    isListed: false,
    modelType: CLI_AGENT.CODEX,
    name: "test",
    status: "ready",
    hasKey: true,
    hasApiKey: false,
    hasSessionToken: true,
    authMethod: "oauth",
    enabled: true,
    availableModels: [],
    enabledModels: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// withCodexOAuthModels
// ---------------------------------------------------------------------------

describe("withCodexOAuthModels — model list population", () => {
  it("does not inject hardcoded TS-side fallback models", () => {
    const account = baseAccount({ modelType: CLI_AGENT.CODEX });
    const enriched = withCodexOAuthModels(account);
    expect(enriched.availableModels).toEqual([]);
    expect(enriched.enabledModels).toEqual([]);
  });

  it("preserves existing enabledModels when non-empty", () => {
    const account = baseAccount({
      modelType: CLI_AGENT.CODEX,
      enabledModels: ["gpt-5.4"],
    });
    const enriched = withCodexOAuthModels(account);
    expect(enriched.enabledModels).toEqual(["gpt-5.4"]);
  });

  it("unions discovered models with catalog — no duplicates", () => {
    const account = baseAccount({
      modelType: CLI_AGENT.CODEX,
      availableModels: ["gpt-5.5", "custom-codex-model"],
      enabledModels: ["gpt-5.5"],
    });
    const enriched = withCodexOAuthModels(account);
    const gpt55Count = (enriched.availableModels ?? []).filter(
      (m) => m === "gpt-5.5"
    ).length;
    expect(gpt55Count).toBe(1);
    expect(enriched.availableModels ?? []).toContain("custom-codex-model");
  });

  it("sets status to ready", () => {
    const account = baseAccount({
      status: "loading" as KeyVaultAccount["status"],
    });
    const enriched = withCodexOAuthModels(account);
    expect(enriched.status).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// withNativeHarnessModels
// ---------------------------------------------------------------------------

describe("withNativeHarnessModels — dispatch category guard", () => {
  it("returns accounts unchanged when dispatchCategory is not rust_agent", () => {
    const accounts = [baseAccount()];
    const result = withNativeHarnessModels(accounts, "cli_agent");
    expect(result).toStrictEqual(accounts);
  });

  it("returns accounts unchanged when dispatchCategory is null", () => {
    const accounts = [baseAccount()];
    const result = withNativeHarnessModels(accounts, null);
    expect(result).toStrictEqual(accounts);
  });

  it("does not inject TS-side Codex OAuth catalog when dispatchCategory is rust_agent", () => {
    const account = baseAccount({
      modelType: CLI_AGENT.CODEX,
      hasSessionToken: true,
      authMethod: "oauth",
      enabled: true,
      availableModels: [],
      enabledModels: [],
    });
    const result = withNativeHarnessModels([account], "rust_agent");
    expect(result[0]?.availableModels).toEqual([]);
  });

  it("does not inject TS-side Claude Code OAuth catalog when dispatchCategory is rust_agent", () => {
    const account = baseAccount({
      modelType: CLI_AGENT.CLAUDE_CODE,
      hasSessionToken: true,
      authMethod: "oauth",
      enabled: true,
      availableModels: [],
      enabledModels: [],
    });
    const result = withNativeHarnessModels([account], "rust_agent");
    expect(result[0].availableModels).toEqual([]);
  });

  it("enriches Cursor native accounts when dispatchCategory is rust_agent", () => {
    const account = baseAccount({
      modelType: CLI_AGENT.CURSOR,
      hasSessionToken: true,
      enabled: true,
      canUseNativeHarness: true,
      nativeHarnessType: NATIVE_HARNESS_TYPE.CURSOR,
      availableModels: [],
      enabledModels: [],
    });
    const result = withNativeHarnessModels([account], "rust_agent");
    expect(result[0].status).toBe("ready");
    expect(result[0].canUseNativeHarness).toBe(true);
  });

  it("passes through non-native accounts unchanged when dispatchCategory is rust_agent", () => {
    // An account that doesn't match any of the native account predicates
    const account = baseAccount({
      modelType: CLI_AGENT.CODEX,
      authMethod: "api_key",
      hasSessionToken: false,
    });
    const result = withNativeHarnessModels([account], "rust_agent");
    expect(result[0]).toStrictEqual(account);
  });
});

// ---------------------------------------------------------------------------
// Account type predicates
// ---------------------------------------------------------------------------

describe("isCursorNativeAccount", () => {
  it("returns true for a qualifying Cursor OAuth account", () => {
    const account = baseAccount({
      modelType: CLI_AGENT.CURSOR,
      hasSessionToken: true,
      enabled: true,
      canUseNativeHarness: true,
    });
    expect(isCursorNativeAccount(account)).toBe(true);
  });

  it("returns false when hasSessionToken is false", () => {
    const account = baseAccount({
      modelType: CLI_AGENT.CURSOR,
      hasSessionToken: false,
      enabled: true,
      canUseNativeHarness: true,
    });
    expect(isCursorNativeAccount(account)).toBe(false);
  });

  it("returns false for a non-Cursor modelType", () => {
    const account = baseAccount({
      modelType: CLI_AGENT.CODEX,
      hasSessionToken: true,
      enabled: true,
      canUseNativeHarness: true,
    });
    expect(isCursorNativeAccount(account)).toBe(false);
  });
});

describe("isClaudeCodeOAuthAccount", () => {
  it("returns true for a qualifying Claude Code OAuth account", () => {
    const account = baseAccount({
      modelType: CLI_AGENT.CLAUDE_CODE,
      hasSessionToken: true,
      enabled: true,
      authMethod: "oauth",
    });
    expect(isClaudeCodeOAuthAccount(account)).toBe(true);
  });

  it("returns false when authMethod is not oauth", () => {
    const account = baseAccount({
      modelType: CLI_AGENT.CLAUDE_CODE,
      hasSessionToken: true,
      enabled: true,
      authMethod: "api_key",
    });
    expect(isClaudeCodeOAuthAccount(account)).toBe(false);
  });
});

describe("isCodexOAuthAccount", () => {
  it("returns true for a qualifying Codex OAuth account", () => {
    const account = baseAccount({
      modelType: CLI_AGENT.CODEX,
      hasSessionToken: true,
      enabled: true,
      authMethod: "oauth",
    });
    expect(isCodexOAuthAccount(account)).toBe(true);
  });

  it("returns false when enabled is false", () => {
    const account = baseAccount({
      modelType: CLI_AGENT.CODEX,
      hasSessionToken: true,
      enabled: false,
      authMethod: "oauth",
    });
    expect(isCodexOAuthAccount(account)).toBe(false);
  });
});
