import type { CredentialSuggestion } from "@src/api/services/keyValidation";

import {
  credentialImportRowKey,
  importableSuggestions,
  sortSuggestions,
} from "../credentialImportUtils";

function suggestion(
  overrides: Partial<CredentialSuggestion> & Pick<CredentialSuggestion, "id">
): CredentialSuggestion {
  return {
    agentType: "anthropic_api",
    authMethod: "api_key",
    sourceKind: "env",
    sourceLabel: "ANTHROPIC_API_KEY",
    sourcePath: null,
    fingerprint: "abc",
    alreadyImported: false,
    ...overrides,
  };
}

describe("credentialImportRowKey", () => {
  it("uses the probe-assigned id verbatim", () => {
    expect(
      credentialImportRowKey({ id: "codex:oauth_store:~/.codex/auth.json" })
    ).toBe("codex:oauth_store:~/.codex/auth.json");
  });
});

describe("importableSuggestions", () => {
  it("drops rows the vault already holds", () => {
    const rows = [
      suggestion({ id: "a", alreadyImported: true }),
      suggestion({ id: "b" }),
    ];
    expect(importableSuggestions(rows).map((r) => r.id)).toEqual(["b"]);
  });
});

describe("sortSuggestions", () => {
  it("groups by agent, login stores before env, then by label", () => {
    const rows = [
      suggestion({
        id: "1",
        agentType: "codex",
        sourceKind: "env",
        sourceLabel: "OPENAI_API_KEY",
      }),
      suggestion({
        id: "2",
        agentType: "anthropic_api",
        sourceKind: "shell_profile",
      }),
      suggestion({
        id: "3",
        agentType: "codex",
        sourceKind: "oauth_store",
        sourceLabel: "~/.codex/auth.json",
      }),
      suggestion({ id: "4", agentType: "anthropic_api", sourceKind: "env" }),
    ];
    expect(sortSuggestions(rows).map((r) => r.id)).toEqual([
      "4",
      "2",
      "3",
      "1",
    ]);
  });

  it("does not mutate its input", () => {
    const rows = [
      suggestion({ id: "b", agentType: "z" }),
      suggestion({ id: "a", agentType: "a" }),
    ];
    const copy = [...rows];
    sortSuggestions(rows);
    expect(rows).toEqual(copy);
  });
});
