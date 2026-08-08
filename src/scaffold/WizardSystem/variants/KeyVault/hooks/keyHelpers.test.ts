import { describe, expect, it } from "vitest";

import type { OAuthModelCatalog } from "@src/api/services/keyValidation";
import type { DetectedKey } from "@src/api/types/keys";

import type { WizardData } from "../types";
import { applyKey } from "./keyHelpers";

describe("keyHelpers", () => {
  it("applies Cursor token-only detections as OAuth accounts without requiring an API key", () => {
    const updates: Partial<WizardData>[] = [];
    let tokenDetected = false;
    let cursorSessionToken = "";
    let tokenError: string | null = "previous error";
    let showKeySelection = true;

    const detectedKey: DetectedKey = {
      id: "cursor-token-only",
      name: "Cursor Token Only",
      auth_method: "oauth",
      session_token: "cursor-native-token",
      available_models: ["composer-2", "claude-sonnet-4-6"],
      validated: true,
    };

    applyKey(detectedKey, {
      onChange: (update) => updates.push(update),
      setTokenDetected: (value) => {
        tokenDetected = value;
      },
      setCursorSessionToken: (value) => {
        cursorSessionToken = value;
      },
      setTokenError: (value) => {
        tokenError = value;
      },
      setShowKeySelection: (value) => {
        showKeySelection = value;
      },
      isCursor: true,
      isOAuthAgent: false,
      noValidTokenMsg: "No valid token",
      validationFailedMsg: "Validation failed",
    });

    expect(tokenDetected).toBe(true);
    expect(cursorSessionToken).toBe("cursor-native-token");
    expect(tokenError).toBeNull();
    expect(showKeySelection).toBe(false);
    expect(updates).toEqual([
      {
        auth_method: "oauth",
        cursor_session_token: "cursor-native-token",
        raw_key_input: "",
        quota_info: undefined,
        available_models: ["composer-2", "claude-sonnet-4-6"],
        model_context_lengths: {},
        enabled_models: ["claude-sonnet-4-6", "composer-2"],
        validated: true,
      },
    ]);
  });

  it("clears stale extracted api key and base URL when applying an OAuth detection", () => {
    const updates: Partial<WizardData>[] = [];

    const detectedKey: DetectedKey = {
      id: "claude_code_oauth_local",
      name: "Anthropic",
      auth_method: "oauth",
      session_token: "sk-ant-oat01-abc",
      available_models: ["claude-fable-5"],
      validated: true,
    };

    applyKey(detectedKey, {
      onChange: (update) => updates.push(update),
      setTokenDetected: () => {},
      setCursorSessionToken: () => {},
      setTokenError: () => {},
      setShowKeySelection: () => {},
      isCursor: false,
      isOAuthAgent: true,
      noValidTokenMsg: "No valid token",
      validationFailedMsg: "Validation failed",
    });

    expect(updates).toHaveLength(1);
    // Wizard state merges via spread ({ ...prev, ...update }), so the OAuth
    // update must explicitly overwrite leftovers from an earlier api_key
    // detection — otherwise submit() persists the relay base_url onto the
    // OAuth account and the OAuth token gets sent to the relay (issue #276).
    const previousDetection: Partial<WizardData> = {
      extracted_api_key: "sk-old-relay-key",
      extracted_base_url: "https://relay.example.com/v1",
    };
    const merged = { ...previousDetection, ...updates[0] };
    expect(merged.extracted_api_key).toBeUndefined();
    expect(merged.extracted_base_url).toBeUndefined();
    expect(merged.oauth_session_token).toBe("sk-ant-oat01-abc");
    expect(merged.auth_method).toBe("oauth");
  });

  it("uses the resolved OAuth catalog instead of a separate detected model list", () => {
    const updates: Partial<WizardData>[] = [];
    const catalog: OAuthModelCatalog = {
      models: ["gpt-5.6-sol"],
      defaultEnabledModels: ["gpt-5.6-sol"],
      modelContextLengths: { "gpt-5.6-sol": 1_050_000 },
      modelVariants: [
        {
          model: "gpt-5.6-sol-high",
          base_model: "gpt-5.6-sol",
          reasoning: "high",
          fast: false,
          context_window: 1_050_000,
        },
      ],
      defaultVariants: [
        { base_model: "gpt-5.6-sol", model: "gpt-5.6-sol-high" },
      ],
      source: "live",
    };

    applyKey(
      {
        id: "codex-oauth",
        name: "OpenAI",
        auth_method: "oauth",
        session_token: "oauth-token",
        available_models: ["gpt-5.4"],
        validated: true,
      },
      {
        onChange: (update) => updates.push(update),
        setTokenDetected: () => {},
        setCursorSessionToken: () => {},
        setTokenError: () => {},
        setShowKeySelection: () => {},
        isCursor: false,
        isOAuthAgent: true,
        oauthCatalog: catalog,
        noValidTokenMsg: "No valid token",
        validationFailedMsg: "Validation failed",
      }
    );

    expect(updates[0]?.available_models).toEqual(["gpt-5.6-sol"]);
    expect(updates[0]?.enabled_models).toEqual(["gpt-5.6-sol"]);
    expect(updates[0]?.model_context_lengths).toEqual({
      "gpt-5.6-sol": 1_050_000,
    });
    expect(updates[0]?.model_variants).toEqual([
      {
        model: "gpt-5.6-sol-high",
        baseModel: "gpt-5.6-sol",
        reasoning: "high",
        fast: false,
        contextWindow: 1_050_000,
      },
    ]);
    expect(updates[0]?.default_variants).toEqual(catalog.defaultVariants);
  });
});
