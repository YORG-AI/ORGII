// @vitest-environment jsdom
import type { TFunction } from "i18next";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CLI_AGENT } from "@src/api/tauri/rpc/schemas/validation";

import type { WizardData } from "../types";
import { useApiSetupTokenDetection } from "./useApiSetupTokenDetection";

const serviceMocks = vi.hoisted(() => ({
  autoDetectKey: vi.fn(),
  getOAuthModelCatalog: vi.fn(),
  validateKey: vi.fn(),
}));

vi.mock("@src/api/services/keyValidation", () => serviceMocks);
vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ error: vi.fn() }),
}));
vi.mock("./useProviderConfig", () => ({
  useProviderConfig: () => ({ config: undefined }),
}));

type HookOptions = Parameters<typeof useApiSetupTokenDetection>[0];
type HookResult = ReturnType<typeof useApiSetupTokenDetection>;

function HookHarness({
  options,
  onResult,
}: {
  options: HookOptions;
  onResult: (result: HookResult) => void;
}) {
  const result = useApiSetupTokenDetection(options);
  useEffect(() => onResult(result), [onResult, result]);
  return null;
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("useApiSetupTokenDetection", () => {
  it("awaits catalog discovery, catches failure, and keeps detection single-flight", async () => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    let rejectCatalog: ((reason: Error) => void) | undefined;
    const pendingCatalog = new Promise<never>((_resolve, reject) => {
      rejectCatalog = reject;
    });
    serviceMocks.autoDetectKey.mockResolvedValue({
      success: true,
      message: "Found 1 key(s)",
      keys: [
        {
          auth_method: "oauth",
          validated: true,
          session_token: "test-access-token",
          env_vars: {
            OPENAI_REFRESH_TOKEN: "test-refresh-token",
            OPENAI_ID_TOKEN: "test-id-token",
          },
        },
      ],
    });
    serviceMocks.getOAuthModelCatalog.mockReturnValue(pendingCatalog);

    const setDetectingToken = vi.fn();
    const setTokenError = vi.fn();
    const options: HookOptions = {
      data: { agent_type: CLI_AGENT.CODEX } as WizardData,
      onChange: vi.fn(),
      t: ((key: string) => key) as TFunction<"integrations">,
      isCursor: false,
      isOAuthAgent: true,
      isClaudeCode: false,
      isCodex: true,
      detectedKeys: [],
      selectedCredentialIndex: 0,
      setDetectingToken,
      setTokenDetected: vi.fn(),
      setTokenError,
      setCursorSessionToken: vi.fn(),
      setShowKeySelection: vi.fn(),
      setDetectedKeys: vi.fn(),
      setSelectedCredentialIndex: vi.fn(),
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let hookResult: HookResult | undefined;
    const onResult = (result: HookResult) => {
      hookResult = result;
    };
    await act(async () => {
      root.render(createElement(HookHarness, { options, onResult }));
    });

    let firstDetection: Promise<void> | undefined;
    let duplicateDetection: Promise<void> | undefined;
    await act(async () => {
      firstDetection = hookResult?.handleAutoDetectToken();
      duplicateDetection = hookResult?.handleAutoDetectToken();
      await Promise.resolve();
    });

    expect(serviceMocks.autoDetectKey).toHaveBeenCalledTimes(1);
    expect(serviceMocks.getOAuthModelCatalog).toHaveBeenCalledTimes(1);
    expect(setDetectingToken).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectCatalog?.(new Error("catalog unavailable"));
      await Promise.all([firstDetection, duplicateDetection]);
    });

    expect(setTokenError).toHaveBeenLastCalledWith(
      "keyVault.failedToDetectKeys"
    );
    expect(setDetectingToken.mock.calls.map(([value]) => value)).toEqual([
      true,
      false,
    ]);

    await act(async () => root.unmount());
  });
});
