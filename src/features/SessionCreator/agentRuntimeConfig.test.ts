import { describe, expect, it } from "vitest";

import type { KeyVaultAccount } from "@src/hooks/keyVault";
import type { AgentRegistry } from "@src/store/session/agentRegistryAtom";

import { resolveAgentRuntimeSelection } from "./agentRuntimeConfig";

function account(
  id: string,
  modelType: "claude_code" | "codex",
  model: string
): KeyVaultAccount {
  return {
    id,
    hasLocalKey: true,
    isListed: false,
    modelType,
    name: id,
    status: "ready",
    hasKey: true,
    hasApiKey: false,
    hasSessionToken: true,
    canLaunchCli: true,
    enabled: true,
    availableModels: [model],
    enabledModels: [model],
  };
}

const registry = {
  agents: [
    {
      name: "claude_code",
      compatibleApiProviders: ["anthropic_api"],
      supportsRustAgents: false,
    },
    {
      name: "codex",
      compatibleApiProviders: ["openai_compatible"],
      supportsRustAgents: true,
    },
  ],
  apiProviders: [],
} as unknown as AgentRegistry;

describe("agent runtime selection coordinator", () => {
  it("requires an explicit Codex pair instead of choosing the first account", () => {
    const resolution = resolveAgentRuntimeSelection({
      selection: { category: "cli_agent", cliAgentType: "codex" },
      candidates: [
        {
          keySource: "own_key",
          cliAgentType: "claude_code",
          selectedAccountId: "anthropic-1",
          model: "opus",
        },
      ],
      accounts: [
        account("anthropic-1", "claude_code", "opus"),
        account("openai-1", "codex", "gpt-5.6-sol"),
      ],
      registry,
      allowedCliAgentTypes: ["claude_code", "codex"],
      allowHosted: false,
      allowAmbientClaude: true,
    });

    expect(resolution).toEqual({ status: "needs_model_picker" });
  });

  it("keeps Claude accountless auto-detect only when the caller allows it", () => {
    const input = {
      selection: {
        category: "cli_agent" as const,
        cliAgentType: "claude_code" as const,
      },
      candidates: [],
      accounts: [] as KeyVaultAccount[],
      registry,
      allowedCliAgentTypes: ["claude_code", "codex"],
      allowHosted: false,
    };

    expect(
      resolveAgentRuntimeSelection({ ...input, allowAmbientClaude: true })
    ).toEqual({
      status: "ready",
      config: {
        keySource: "own_key",
        cliAgentType: "claude_code",
        model: undefined,
        selectedSourceModelType: "claude_code",
      },
    });
    expect(
      resolveAgentRuntimeSelection({ ...input, allowAmbientClaude: false })
    ).toEqual({ status: "needs_model_picker" });
  });

  it("reuses one explicit pair across Codex and a Rust Agent", () => {
    const candidate = {
      keySource: "own_key" as const,
      selectedAccountId: "openai-1",
      model: "gpt-5.6-sol",
    };
    const accounts = [account("openai-1", "codex", "gpt-5.6-sol")];

    const agent = resolveAgentRuntimeSelection({
      selection: { category: "rust_agent" },
      candidates: [candidate],
      accounts,
      registry,
      allowHosted: false,
      allowAmbientClaude: true,
    });
    expect(agent).toMatchObject({
      status: "ready",
      config: {
        cliAgentType: undefined,
        selectedAccountId: "openai-1",
        model: "gpt-5.6-sol",
      },
    });

    const codex = resolveAgentRuntimeSelection({
      selection: { category: "cli_agent", cliAgentType: "codex" },
      candidates: [
        agent.status === "ready" ? agent.config : { keySource: "own_key" },
      ],
      accounts,
      registry,
      allowedCliAgentTypes: ["claude_code", "codex"],
      allowHosted: false,
      allowAmbientClaude: true,
    });
    expect(codex).toMatchObject({
      status: "ready",
      config: {
        cliAgentType: "codex",
        selectedAccountId: "openai-1",
        model: "gpt-5.6-sol",
      },
    });
  });

  it("uses the same compatibility decision for New Session without inventing a pair", () => {
    expect(
      resolveAgentRuntimeSelection({
        selection: { category: "cli_agent", cliAgentType: "codex" },
        candidates: [
          {
            keySource: "own_key",
            selectedAccountId: "openai-1",
            model: "gpt-5.6-sol",
            selectedSourceModelType: "codex",
          },
        ],
        registry,
        allowHosted: true,
        allowAmbientClaude: false,
      })
    ).toMatchObject({ status: "ready" });

    expect(
      resolveAgentRuntimeSelection({
        selection: { category: "cli_agent", cliAgentType: "codex" },
        candidates: [{ keySource: "own_key" }],
        registry,
        allowHosted: true,
        allowAmbientClaude: false,
      })
    ).toEqual({ status: "needs_model_picker" });
  });
});
