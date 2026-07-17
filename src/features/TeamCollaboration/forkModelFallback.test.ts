import { describe, expect, it } from "vitest";

import type { KeyInfo } from "@src/api/types/keys";

import { isModelRunnableLocally, resolveForkModel } from "./forkModelFallback";

function makeKey(overrides: Partial<KeyInfo> = {}): KeyInfo {
  return {
    id: "key-1",
    agent_type: "deepseek",
    has_local_key: true,
    has_api_key: true,
    has_session_token: false,
    enabled: true,
    health_status: "unknown",
    available_models: ["deepseek-v4-pro", "deepseek-v4-flash"],
    enabled_models: ["deepseek-v4-pro", "deepseek-v4-flash"],
    ...overrides,
  } as KeyInfo;
}

describe("isModelRunnableLocally", () => {
  it("accepts a model enabled on a usable local key", () => {
    expect(isModelRunnableLocally("deepseek-v4-pro", [makeKey()])).toBe(true);
  });

  it("rejects a model no local key serves (the live fork failure)", () => {
    expect(isModelRunnableLocally("gpt-5.6-sol", [makeKey()])).toBe(false);
  });

  it("rejects when the only matching key is disabled", () => {
    expect(
      isModelRunnableLocally("deepseek-v4-pro", [makeKey({ enabled: false })])
    ).toBe(false);
  });

  it("rejects when the matching key has invalid health", () => {
    expect(
      isModelRunnableLocally("deepseek-v4-pro", [
        makeKey({ health_status: "invalid" }),
      ])
    ).toBe(false);
  });

  it("rejects when the matching key has neither api key nor session token", () => {
    expect(
      isModelRunnableLocally("deepseek-v4-pro", [
        makeKey({ has_api_key: false, has_session_token: false }),
      ])
    ).toBe(false);
  });

  it("accepts a variant whose base model is enabled", () => {
    const key = makeKey({
      enabled_models: ["deepseek-v4-pro"],
      model_variants: [
        { model: "deepseek-v4-pro-high", base_model: "deepseek-v4-pro" },
      ] as KeyInfo["model_variants"],
    });
    expect(isModelRunnableLocally("deepseek-v4-pro-high", [key])).toBe(true);
  });

  it("accepts ORGII pool tier ids regardless of local keys", () => {
    expect(isModelRunnableLocally("orgii:pro", [])).toBe(true);
  });

  it("rejects everything with no keys at all", () => {
    expect(isModelRunnableLocally("deepseek-v4-pro", [])).toBe(false);
  });
});

describe("resolveForkModel", () => {
  const keys = [makeKey()];

  it("keeps an inherited model that is runnable locally", () => {
    expect(
      resolveForkModel("deepseek-v4-pro", keys, "deepseek-v4-flash")
    ).toEqual({
      model: "deepseek-v4-pro",
      fellBack: false,
    });
  });

  it("falls back to the default when the inherited model is unrunnable", () => {
    expect(resolveForkModel("gpt-5.6-sol", keys, "deepseek-v4-flash")).toEqual({
      model: "deepseek-v4-flash",
      fellBack: true,
    });
  });

  it("drops to undefined when the default itself is unrunnable", () => {
    expect(resolveForkModel("gpt-5.6-sol", keys, "gpt-5.6-luna")).toEqual({
      model: undefined,
      fellBack: true,
    });
  });

  it("drops to undefined when there is no default", () => {
    expect(resolveForkModel("gpt-5.6-sol", keys, undefined)).toEqual({
      model: undefined,
      fellBack: true,
    });
  });

  it("falls back with empty credentials", () => {
    expect(resolveForkModel("gpt-5.6-sol", [], "deepseek-v4-pro")).toEqual({
      model: undefined,
      fellBack: true,
    });
  });

  it("uses the default when the key list could not be loaded", () => {
    expect(resolveForkModel("gpt-5.6-sol", null, "deepseek-v4-pro")).toEqual({
      model: "deepseek-v4-pro",
      fellBack: true,
    });
  });

  it("keeps no-model forks untouched", () => {
    expect(resolveForkModel(undefined, keys, "deepseek-v4-pro")).toEqual({
      model: undefined,
      fellBack: false,
    });
  });
});
