/* global browser, describe, before, it, expect */
import {
  invokeE2E,
  unwrap,
  waitForApp,
} from "../../support/core/agentOrgUiDriver.mjs";

const ROUTE = "/orgii/app/settings/integrations/models";
const WAIT_TIMEOUT_MS = 30_000;

const EXPECTED_CLI_AGENTS = [
  "cursor_cli",
  "claude_code",
  "codex",
  "kiro",
  "copilot",
  "kimi_cli",
  "opencode",
];

const EXPECTED_API_PROVIDERS = [
  "openai_api",
  "anthropic_api",
  "gemini_api",
  "deepseek_api",
  "groq_api",
  "xai_api",
  "zhipu_api",
  "dashscope_api",
  "moonshot_api",
  "openrouter_api",
  "minimax_api",
  "vllm_api",
  "azure_openai_api",
  "azure_anthropic_api",
  "orgii_orchestrator",
];

const EXPECTED_API_CONFIGS = {
  openai_api: { env: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1" },
  anthropic_api: {
    env: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1",
  },
  gemini_api: {
    env: "GEMINI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
  deepseek_api: {
    env: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com",
  },
  groq_api: {
    env: "GROQ_API_KEY",
    baseUrl: "https://api.groq.com/openai/v1",
  },
  xai_api: { env: "XAI_API_KEY", baseUrl: "https://api.x.ai/v1" },
  zhipu_api: {
    env: "ZHIPU_API_KEY",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  dashscope_api: {
    env: "DASHSCOPE_API_KEY",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  moonshot_api: {
    env: "MOONSHOT_API_KEY",
    baseUrl: "https://api.moonshot.cn/v1",
  },
  openrouter_api: {
    env: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  minimax_api: {
    env: "MINIMAX_API_KEY",
    baseUrl: "https://api.minimax.io/v1",
  },
  vllm_api: { env: "VLLM_API_KEY", baseUrl: "http://localhost:8000/v1" },
  orgii_orchestrator: {
    env: "ORGII_API_KEY",
    baseUrl: "https://api.orgii.ai/v1",
  },
};

const API_PROVIDERS_REQUIRING_CUSTOM_BASE_URL = new Set([
  "azure_openai_api",
  "azure_anthropic_api",
]);

const AUTO_DETECT_DISPATCH_CLI_AGENTS = [
  "cursor_cli",
  "claude_code",
  "codex",
  "copilot",
  "kiro",
];

const AUTO_DETECT_NOOP_AGENT_TYPES = [
  "kimi_cli",
  "opencode",
  ...EXPECTED_API_PROVIDERS,
];

async function execJS(script) {
  return browser.executeScript(script, []);
}

async function waitForScript(
  predicateScript,
  label,
  timeout = WAIT_TIMEOUT_MS
) {
  await browser.waitUntil(async () => execJS(predicateScript), {
    timeout,
    interval: 250,
    timeoutMsg: label,
  });
}

async function jsClick(selector, label) {
  let result = null;
  await browser.waitUntil(
    async () => {
      result = await browser.executeScript(
        `
          const selector = arguments[0];
          const element = document.querySelector(selector);
          if (!element) return { ok: false, reason: "missing", selector, bodyText: document.body.innerText.slice(0, 1600) };
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") {
            return { ok: false, reason: "hidden", selector, rect: { width: rect.width, height: rect.height }, bodyText: document.body.innerText.slice(0, 1600) };
          }
          element.scrollIntoView({ block: "center", inline: "center" });
          element.click();
          return { ok: true, selector, text: (element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 200) };
        `,
        [selector]
      );
      return result.ok;
    },
    {
      timeout: WAIT_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${label} not clickable: ${JSON.stringify(result, null, 2)}`,
    }
  );
  return result;
}

describe("Provider/model matrix registry and auto-detect UI", () => {
  before(async () => {
    await waitForApp();
  });

  it("keeps CLI/API provider registry, configs, and small-model brands wired", async () => {
    const matrix = unwrap(
      await invokeE2E("inspectProviderMatrix"),
      "inspectProviderMatrix"
    );

    const agentNames = new Set(matrix.agents.map((agent) => agent.name));
    const providerNames = new Set(
      matrix.apiProviders.map((provider) => provider.name)
    );

    for (const name of EXPECTED_CLI_AGENTS) {
      expect(agentNames.has(name)).toBe(true);
      expect(matrix.providerConfigs[name]).toBeTruthy();
    }
    for (const name of EXPECTED_API_PROVIDERS) {
      expect(providerNames.has(name)).toBe(true);
      expect(matrix.providerConfigs[name]).toBeTruthy();
    }

    for (const provider of matrix.apiProviders) {
      const config = matrix.providerConfigs[provider.name];
      expect(config).toBeTruthy();
      expect(typeof provider.supportsRustAgents).toBe("boolean");
      expect(config.api_key_env_var).toBe(provider.apiKeyEnvVar);
      expect(config.supports_base_url).toBe(provider.supportsBaseUrl);
      expect(config.default_base_url ?? undefined).toBe(
        provider.defaultBaseUrl ?? undefined
      );
    }

    for (const [name, expected] of Object.entries(EXPECTED_API_CONFIGS)) {
      const provider = matrix.apiProviders.find((row) => row.name === name);
      const config = matrix.providerConfigs[name];
      expect(provider).toBeTruthy();
      expect(typeof provider.supportsRustAgents).toBe("boolean");
      expect(provider.apiKeyEnvVar).toBe(expected.env);
      expect(config.api_key_env_var).toBe(expected.env);
      expect(config.supports_base_url).toBe(true);
      expect(config.default_base_url).toBe(expected.baseUrl);
    }

    for (const name of API_PROVIDERS_REQUIRING_CUSTOM_BASE_URL) {
      const provider = matrix.apiProviders.find((row) => row.name === name);
      const config = matrix.providerConfigs[name];
      expect(provider).toBeTruthy();
      expect(provider.supportsBaseUrl).toBe(true);
      expect(config.supports_base_url).toBe(true);
      expect(provider.defaultBaseUrl ?? null).toBe(null);
      expect(config.default_base_url ?? null).toBe(null);
    }

    const xai = matrix.apiProviders.find((row) => row.name === "xai_api");
    expect(xai.displayName).toContain("Grok");
    expect(xai.iconProvider).toBe("grok");

    const cursorCli = matrix.agents.find((row) => row.name === "cursor_cli");
    const kimiCli = matrix.agents.find((row) => row.name === "kimi_cli");
    const openCode = matrix.agents.find((row) => row.name === "opencode");
    expect(cursorCli.supportsRustAgents).toBe(false);
    expect(kimiCli.envConfig.apiKeyEnvVar).toBe("MOONSHOT_API_KEY");
    expect(openCode.envConfig.apiKeyEnvVar).toBe("OPENCODE_API_KEY");
  });

  it("renders every registered provider brand in the Add Account grid", async () => {
    unwrap(await invokeE2E("navigateTo", ROUTE), "navigate to Models & Keys");
    await waitForScript(
      `return location.pathname === ${JSON.stringify(ROUTE)};`,
      "Models & Keys route did not open"
    );
    await waitForScript(
      `return !!document.querySelector('button[data-tab-key="my-accounts"]');`,
      "My Keys tab did not render"
    );
    await jsClick('button[data-tab-key="my-accounts"]', "My Keys tab");
    await waitForScript(
      `return !!document.querySelector('[data-testid="key-vault-add-account-button"]');`,
      "Add Account button did not render"
    );
    await jsClick(
      '[data-testid="key-vault-add-account-button"]',
      "Add Account button"
    );
    await waitForScript(
      `return !!document.querySelector('[data-testid="key-vault-wizard"]');`,
      "Key Vault wizard did not open"
    );

    const expectedProviderGridKeys = [
      "cursor_cli",
      "openai",
      "anthropic",
      "gemini",
      "kiro",
      "copilot",
      "opencode",
      "deepseek_api",
      "groq_api",
      "xai_api",
      "zhipu_api",
      "dashscope_api",
      "moonshot",
      "openrouter_api",
      "minimax_api",
      "vllm_api",
      "azure_openai_api",
      "azure_anthropic_api",
      "orgii_orchestrator",
    ];
    for (const key of expectedProviderGridKeys) {
      const testId = `selection-grid-option-${key}`;
      await waitForScript(
        `return !!document.querySelector('[data-testid="${testId}"]');`,
        `${testId} did not render in provider grid`
      );
    }

    const gridText = await execJS(
      `return (document.querySelector('[data-testid="key-vault-wizard"]')?.textContent || "").replace(/\\s+/g, " ");`
    );
    for (const label of [
      "Cursor",
      "OpenAI",
      "Anthropic",
      "Gemini",
      "Kiro",
      "Copilot",
      "OpenCode",
      "DeepSeek",
      "Groq",
      "Grok",
      "Zhipu",
      "DashScope",
      "Moonshot",
      "OpenRouter",
      "MiniMax",
      "vLLM",
      "Azure OpenAI",
      "Azure Anthropic",
      "ORGII Token Market",
    ]) {
      expect(gridText).toContain(label);
    }
  });

  it("routes auto-detect dispatch for supported CLI agents and explicitly no-ops the rest", async () => {
    for (const agentType of AUTO_DETECT_DISPATCH_CLI_AGENTS) {
      const result = unwrap(
        await invokeE2E("autoDetectKeyForE2E", agentType),
        `autoDetectKeyForE2E(${agentType})`
      ).result;
      expect(result.agent_type).toBe(agentType);
      expect(Array.isArray(result.keys)).toBe(true);
      expect(typeof result.success).toBe("boolean");
      expect(typeof result.message).toBe("string");
    }

    for (const agentType of AUTO_DETECT_NOOP_AGENT_TYPES) {
      const result = unwrap(
        await invokeE2E("autoDetectKeyForE2E", agentType),
        `autoDetectKeyForE2E(${agentType})`
      ).result;
      expect(result.agent_type).toBe(agentType);
      expect(result.success).toBe(false);
      expect(result.keys).toEqual([]);
      expect(result.message).toContain("No keys found");
    }
  });
});
