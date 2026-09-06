// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import en from "@src/i18n/locales/en/integrations.json";

import { DEFAULT_WIZARD_DATA } from "../config";
import { getApiSetupProceedState } from "../hooks/apiSetupDerived";
import type { WizardData } from "../types";
import ApiSetup from "./ApiSetup";

const fixture = vi.hoisted(() => ({ dark: false, validationError: "" }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => {
      let value: unknown = en;
      for (const part of key.split("."))
        value = (value as Record<string, unknown>)?.[part];
      const text =
        typeof value === "string"
          ? value
          : typeof fallback === "string"
            ? fallback
            : key;
      return text.replace(/{{(\w+)}}/g, (_match, name: string) =>
        String((fallback as Record<string, unknown>)?.[name] ?? "")
      );
    },
    i18n: { language: "en" },
  }),
}));
vi.mock("@src/util/ui/theme/themeUtils", () => ({
  useCurrentTheme: () => ({
    theme: fixture.dark ? "dark" : "light",
    isDark: fixture.dark,
  }),
}));
vi.mock("../hooks/useApiSetup", () => ({
  useApiSetup: ({ data }: { data: WizardData }) => ({
    ...getApiSetupProceedState({
      data,
      isCursor: false,
      isCodex: false,
      isKiro: false,
      isClaudeCode: false,
      keyValidated: false,
      tokenDetected: false,
      sessionTokenMode: "auto",
      manualSessionToken: "",
    }),
    agentCategory: "api",
    isApiProvider: true,
    fetchedModels: [],
    detectedKeys: [],
    validationError: fixture.validationError,
  }),
}));
vi.mock("../hooks/useProviderSelection", () => ({
  useProviderSelection: () => ({
    selectedProviderKey: "custom_api",
    selectedProvider: { label: "Custom API" },
    providerSelectOptions: [{ label: "Custom API", value: "custom_api" }],
  }),
}));
// Credential setup has its own tests. Keep this rendering contract focused
// on the model section and save gate, without detection or network effects.
vi.mock("./AgentSetupRouter", () => ({ AgentSetupRouter: () => null }));

function renderCustomSetup(data: Partial<WizardData>, loading = false): string {
  return renderToStaticMarkup(
    createElement(ApiSetup, {
      data: {
        ...DEFAULT_WIZARD_DATA,
        agent_type: "custom_api",
        name: "My endpoint",
        ...data,
      },
      onChange: vi.fn(),
      onNext: vi.fn(),
      onCancel: vi.fn(),
      loading,
      submitLabel: "Save connection",
    })
  );
}

describe("Custom API model setup", () => {
  it("shows manual model entry before discovery succeeds", () => {
    const html = renderCustomSetup({});
    expect(html).toContain(en.keyVault.customModels.manualSetupHint);
    expect(html).toContain(en.keyVault.customModels.addModel);
    expect(html).toContain("disabled");
  });
  it("shows an enabled named custom row without requiring discovery", () => {
    const html = renderCustomSetup({
      raw_key_input: "fixture-key",
      extracted_base_url: "https://example.invalid/v1",
      custom_models: ["deployment-high"],
      enabled_models: ["deployment-high"],
      model_aliases: [{ alias: "deployment-high", displayName: "Team model" }],
    });
    expect(html).toContain('value="deployment-high"');
    expect(html).toContain('value="Team model"');
    expect(html).toContain("Save connection");
  });
});
