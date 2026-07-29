import { rpc } from "@src/api/tauri/rpc";
import {
  CLI_AGENT,
  type KeyInfo,
  type ModelType,
} from "@src/api/tauri/rpc/schemas/validation";
import { createLogger } from "@src/hooks/logger";
import {
  syncSharedLocalKeys,
  upsertSharedLocalKey,
} from "@src/hooks/keyVault/useLocalKeys";

import { asError } from "../result";
import type {
  AddAccountOptions,
  AddClaudeCodeAccountOptions,
  AddCodexAccountOptions,
  AddCursorNativeAccountOptions,
  CloneCursorNativeAccountWithoutApiKeyOptions,
  Err,
  Result,
} from "../types";

const logger = createLogger("E2EBootstrap");

const DEFAULT_ACCOUNT_NAME = "E2E OpenAI";

export async function addAccount(
  opts: AddAccountOptions
): Promise<Result<{ account: KeyInfo }>> {
  try {
    if (!opts.openaiApiKey) {
      return { ok: false, error: "addAccount: `openaiApiKey` is required" };
    }
    if (!opts.model) {
      return { ok: false, error: "addAccount: `model` is required" };
    }
    const accountName = opts.accountName ?? DEFAULT_ACCOUNT_NAME;
    const existing = await rpc.validation.listKeys();
    const prior = existing.find(
      (k) => k.agent_type === "openai_api" && (k.name ?? "") === accountName
    );
    const account = await rpc.validation.saveKey({
      request: {
        id: prior?.id,
        agent_type: "openai_api" as ModelType,
        api_key: opts.openaiApiKey,
        base_url: opts.baseUrl,
        name: accountName,
        auth_method: "api_key",
        enabled: true,
        available_models: [opts.model],
        enabled_models: [opts.model],
      },
    });
    upsertSharedLocalKey(account);
    logger.info(`addAccount ok: ${account.id}`);
    return { ok: true, account };
  } catch (err) {
    return asError(err);
  }
}

export async function addCursorNativeAccount(
  opts: AddCursorNativeAccountOptions
): Promise<Result<{ account: KeyInfo }>> {
  try {
    if (!opts.sessionToken) {
      return {
        ok: false,
        error: "addCursorNativeAccount: `sessionToken` is required",
      };
    }
    const accountName = opts.accountName ?? "E2E Cursor Native";
    const existing = await rpc.validation.listKeys();
    const prior = existing.find(
      (key) =>
        key.agent_type === CLI_AGENT.CURSOR && (key.name ?? "") === accountName
    );
    const account = await rpc.validation.saveKey({
      request: {
        id: prior?.id,
        agent_type: CLI_AGENT.CURSOR,
        api_key: opts.apiKey,
        session_token: opts.sessionToken,
        name: accountName,
        auth_method: "oauth",
        enabled: true,
        available_models: opts.availableModels ?? [],
        enabled_models: opts.enabledModels ?? [],
      },
    });
    upsertSharedLocalKey(account);
    return { ok: true, account };
  } catch (err) {
    return asError(err);
  }
}

export async function addClaudeCodeAccount(
  opts: AddClaudeCodeAccountOptions
): Promise<Result<{ account: KeyInfo }>> {
  try {
    if (!opts.sessionToken) {
      return {
        ok: false,
        error: "addClaudeCodeAccount: `sessionToken` is required",
      };
    }
    const accountName = opts.accountName ?? "E2E Claude Code";
    const existing = await rpc.validation.listKeys();
    const prior = existing.find(
      (key) =>
        key.agent_type === CLI_AGENT.CLAUDE_CODE &&
        (key.name ?? "") === accountName
    );
    const account = await rpc.validation.saveKey({
      request: {
        id: prior?.id,
        agent_type: CLI_AGENT.CLAUDE_CODE,
        api_key: "",
        session_token: opts.sessionToken,
        name: accountName,
        auth_method: "oauth",
        enabled: true,
        available_models: opts.availableModels ?? [],
        enabled_models: opts.enabledModels ?? [],
        env_vars: opts.refreshToken
          ? { CLAUDE_CODE_REFRESH_TOKEN: opts.refreshToken }
          : undefined,
      },
    });
    upsertSharedLocalKey(account);
    return { ok: true, account };
  } catch (err) {
    return asError(err);
  }
}

export async function addCodexAccount(
  opts: AddCodexAccountOptions
): Promise<Result<{ account: KeyInfo }>> {
  try {
    if (!opts.sessionToken) {
      return {
        ok: false,
        error: "addCodexAccount: `sessionToken` is required",
      };
    }
    const accountName = opts.accountName ?? "E2E Codex";
    const existing = await rpc.validation.listKeys();
    const prior = existing.find(
      (key) =>
        key.agent_type === CLI_AGENT.CODEX && (key.name ?? "") === accountName
    );
    const envVars: Record<string, string> = {};
    if (opts.refreshToken) envVars.OPENAI_REFRESH_TOKEN = opts.refreshToken;
    if (opts.idToken) envVars.OPENAI_ID_TOKEN = opts.idToken;
    const account = await rpc.validation.saveKey({
      request: {
        id: prior?.id,
        agent_type: CLI_AGENT.CODEX,
        api_key: "",
        session_token: opts.sessionToken,
        name: accountName,
        auth_method: "oauth",
        enabled: true,
        available_models: opts.availableModels ?? [],
        enabled_models: opts.enabledModels ?? [],
        env_vars: Object.keys(envVars).length > 0 ? envVars : undefined,
      },
    });
    upsertSharedLocalKey(account);
    return { ok: true, account };
  } catch (err) {
    return asError(err);
  }
}

export async function cloneCursorNativeAccountWithoutApiKey(
  opts: CloneCursorNativeAccountWithoutApiKeyOptions
): Promise<Result<{ account: KeyInfo }>> {
  try {
    const existing = await rpc.validation.listKeys();
    const source = existing.find(
      (key) =>
        key.agent_type === CLI_AGENT.CURSOR &&
        (key.name ?? "") === opts.sourceAccountName
    );
    if (!source) {
      return {
        ok: false,
        error: `cloneCursorNativeAccountWithoutApiKey: source ${opts.sourceAccountName} not found`,
      };
    }
    const fullSource = await rpc.validation.getFullKey({
      agentType: CLI_AGENT.CURSOR,
      keyId: source.id,
    });
    if (!fullSource?.session_token) {
      return {
        ok: false,
        error: `cloneCursorNativeAccountWithoutApiKey: source ${opts.sourceAccountName} has no session token`,
      };
    }
    const prior = existing.find(
      (key) =>
        key.agent_type === CLI_AGENT.CURSOR &&
        (key.name ?? "") === opts.targetAccountName
    );
    const account = await rpc.validation.saveKey({
      request: {
        id: prior?.id,
        agent_type: CLI_AGENT.CURSOR,
        api_key: "",
        session_token: fullSource.session_token,
        name: opts.targetAccountName,
        auth_method: "oauth",
        enabled: true,
        available_models: fullSource.available_models,
        enabled_models: source.enabled_models,
      },
    });
    upsertSharedLocalKey(account);
    return { ok: true, account };
  } catch (err) {
    return asError(err);
  }
}

export async function listAccounts(): Promise<Result<{ accounts: KeyInfo[] }>> {
  try {
    const accounts = await rpc.validation.listKeys();
    syncSharedLocalKeys(accounts);
    return { ok: true, accounts };
  } catch (err) {
    return asError(err);
  }
}

export async function inspectProviderMatrix(): Promise<
  Result<{
    agents: unknown[];
    apiProviders: unknown[];
    providerConfigs: Record<string, unknown>;
  }>
> {
  try {
    const [agents, apiProviders, providerConfigs] = await Promise.all([
      rpc.validation.getAvailableAgents(),
      rpc.validation.getAvailableApiProviders(),
      rpc.validation.getAllProviderConfigs(),
    ]);
    return { ok: true, agents, apiProviders, providerConfigs };
  } catch (err) {
    return asError(err);
  }
}

export async function autoDetectKeyForE2E(
  agentType: ModelType
): Promise<Result<{ result: unknown }>> {
  try {
    const result = await rpc.validation.autoDetectKey({ agentType });
    return { ok: true, result };
  } catch (err) {
    return asError(err);
  }
}

export async function removeAccount(id: string): Promise<{ ok: true } | Err> {
  try {
    await rpc.validation.deleteKeyById({ keyId: id });
    return { ok: true };
  } catch (err) {
    return asError(err);
  }
}
