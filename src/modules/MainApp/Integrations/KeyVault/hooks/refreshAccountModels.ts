/**
 * Refresh the available-models list for a single Key Vault account.
 *
 * Dispatches per provider:
 *   • Cursor (with session token) → cursor_list_models_native
 *   • Claude Code OAuth           → claude_code_oauth_list_models
 *   • Codex OAuth                 → codex_oauth_list_models
 *   • Anything else (API key)     → validate_key (validator already returns
 *                                   models_available alongside the auth check)
 *
 * For OAuth providers we apply a "narrow-path 401 retry": if the list-models
 * call rejects with HTTP 401, force a token refresh via the existing per-key
 * locked refresh helpers (refresh_oauth_token Tauri command) and retry the
 * list call exactly once. This piggybacks on the same refresh function that
 * the agent runtime uses on 401 — it does not introduce a new refresh entry
 * point or any user-triggered token churn beyond what the runtime already
 * performs reactively.
 *
 * On success, writes the discovered model list back to the key store via
 * updateKeyHealth (preserving the existing healthStatus and enabledModels —
 * new models default to "addable", never auto-enabled). On hard failure
 * (refresh also rejected, list call still failing), flips healthStatus to
 * "invalid" so the row reflects that the user needs to re-add the account.
 */
import {
  type ModelContextLengths,
  getClaudeCodeOAuthModels,
  getCodexOAuthModels,
  getCursorNativeModels,
  getFullKey,
  getOAuthModelCatalog,
  refreshOauthToken,
  updateKeyHealth,
  validateKey,
} from "@src/api/services/keyValidation";
import { CLI_AGENT } from "@src/api/tauri/rpc/schemas/validation";
import type { KeyVaultAccount } from "@src/hooks/keyVault";

/**
 * Sentinel: caller can branch on this if it wants to show "please re-add this
 * account" instead of a generic toast. Currently we just surface the error
 * message and mark the key invalid; the UI uses the message string.
 */
export class RefreshModelsError extends Error {
  constructor(
    message: string,
    public readonly kind: "auth_expired" | "transient" | "unsupported"
  ) {
    super(message);
    this.name = "RefreshModelsError";
  }
}

function isUnauthorizedError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  // Backend list-models commands stringify HTTP status into the error message
  // (e.g. "Claude Code OAuth model discovery failed: HTTP 401: ..."). Match
  // 401 anywhere in the message — providers vary in their exact phrasing but
  // all include the numeric status.
  return /\b401\b|unauthorized|invalid_grant|token.*expired/i.test(message);
}

function isOAuthAccount(account: KeyVaultAccount): boolean {
  return account.authMethod === "oauth";
}

interface FetchedAccountModels {
  models: string[];
  modelContextLengths: ModelContextLengths;
}

async function fetchModelsForAccount(
  account: KeyVaultAccount
): Promise<FetchedAccountModels> {
  const fullKey = await getFullKey(account.modelType, account.id);
  if (!fullKey) {
    throw new RefreshModelsError(
      `Key not found for account ${account.id}`,
      "transient"
    );
  }

  switch (account.modelType) {
    case CLI_AGENT.CURSOR: {
      const token = fullKey.session_token;
      if (!token) {
        throw new RefreshModelsError(
          "Cursor account has no session token",
          "unsupported"
        );
      }
      return {
        models: await getCursorNativeModels(token),
        modelContextLengths: {},
      };
    }
    case CLI_AGENT.CLAUDE_CODE: {
      if (!isOAuthAccount(account)) {
        // Claude API key path falls through to validateKey below.
        break;
      }
      const token = fullKey.session_token;
      if (!token) {
        throw new RefreshModelsError(
          "Claude Code OAuth account has no access token",
          "auth_expired"
        );
      }
      return {
        models: await getClaudeCodeOAuthModels(token),
        modelContextLengths: {},
      };
    }
    case CLI_AGENT.CODEX: {
      if (!isOAuthAccount(account)) {
        break;
      }
      const token = fullKey.session_token;
      if (!token) {
        throw new RefreshModelsError(
          "Codex OAuth account has no access token",
          "auth_expired"
        );
      }
      const idToken = fullKey.env_vars?.CODEX_ID_TOKEN;
      return {
        models: await getCodexOAuthModels(token, idToken),
        modelContextLengths: {},
      };
    }
  }

  // Default path: API key providers (OpenAI, Anthropic, Gemini BYOK, Groq,
  // xAI, DeepSeek, custom base_url, …). The validator's /v1/models call
  // returns the model catalog alongside the auth check.
  const apiKey = fullKey.api_key;
  if (!apiKey) {
    throw new RefreshModelsError(
      `Account ${account.modelType} has no API key`,
      "unsupported"
    );
  }
  const result = await validateKey(
    account.modelType,
    apiKey,
    fullKey.base_url ?? undefined
  );
  if (!result.valid) {
    throw new RefreshModelsError(
      result.message || "Key validation failed",
      "auth_expired"
    );
  }
  return {
    models: result.models_available ?? [],
    modelContextLengths: result.model_context_lengths,
  };
}

export interface RefreshAccountModelsResult {
  /** Available models after the refresh. */
  models: string[];
  /** Available models before the refresh (for computing added/removed). */
  previousModels: string[];
}

export async function refreshAccountModels(
  account: KeyVaultAccount
): Promise<RefreshAccountModelsResult> {
  const previousHealth = account.healthStatus ?? "valid";
  const previousModels = account.availableModels ?? [];
  let fetched: FetchedAccountModels;

  try {
    fetched = await fetchModelsForAccount(account);
  } catch (firstErr) {
    // Narrow-path 401 retry: only for OAuth accounts, only once. Uses the
    // same per-provider refresh helpers that the agent runtime calls on 401
    // — backend takes a per-key lock so repeated user clicks don't cascade.
    if (isOAuthAccount(account) && isUnauthorizedError(firstErr)) {
      try {
        await refreshOauthToken(account.id);
      } catch (refreshErr) {
        // Refresh itself rejected — refresh_token is dead or revoked. Mark
        // the account invalid so the row visibly degrades; user needs to
        // re-add the account.
        await updateKeyHealth(
          account.id,
          "invalid",
          refreshErr instanceof Error ? refreshErr.message : String(refreshErr)
        );
        throw new RefreshModelsError(
          refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
          "auth_expired"
        );
      }
      try {
        fetched = await fetchModelsForAccount(account);
      } catch (retryErr) {
        await updateKeyHealth(
          account.id,
          "invalid",
          retryErr instanceof Error ? retryErr.message : String(retryErr)
        );
        throw retryErr instanceof RefreshModelsError
          ? retryErr
          : new RefreshModelsError(
              retryErr instanceof Error ? retryErr.message : String(retryErr),
              "auth_expired"
            );
      }
    } else {
      throw firstErr instanceof RefreshModelsError
        ? firstErr
        : new RefreshModelsError(
            firstErr instanceof Error ? firstErr.message : String(firstErr),
            "transient"
          );
    }
  }

  if (fetched.models.length === 0) {
    throw new RefreshModelsError(
      "Provider returned an empty model list",
      "transient"
    );
  }

  const refreshedEnabledModels = await (async () => {
    if (!isOAuthAccount(account)) {
      return undefined;
    }
    if (
      account.modelType !== CLI_AGENT.CLAUDE_CODE &&
      account.modelType !== CLI_AGENT.CODEX
    ) {
      return undefined;
    }
    const catalog = await getOAuthModelCatalog(account.modelType);
    const enabled = new Set(account.enabledModels ?? []);
    for (const modelId of catalog.defaultEnabledModels) {
      if (fetched.models.includes(modelId)) enabled.add(modelId);
    }
    return [...enabled];
  })();

  await updateKeyHealth(
    account.id,
    previousHealth,
    undefined,
    fetched.models,
    refreshedEnabledModels,
    undefined,
    fetched.modelContextLengths
  );

  return { models: fetched.models, previousModels };
}

export interface RefreshAllAccountModelsSummary {
  /** Number of accounts attempted. */
  total: number;
  /** Number of accounts whose refresh rejected. */
  failed: number;
  /** Distinct model ids that appeared after refresh (across all accounts). */
  added: number;
  /** Distinct model ids that disappeared after refresh (across all accounts). */
  removed: number;
}

/**
 * Refresh models for every provided account in parallel and tally the net
 * added/removed models across all of them. Single shared pipeline used by both
 * the Key Vault models table and the model spotlight refresh buttons — do not
 * re-implement the loop at call sites.
 */
export async function refreshAllAccountModels(
  accounts: KeyVaultAccount[]
): Promise<RefreshAllAccountModelsSummary> {
  const results = await Promise.allSettled(
    accounts.map((account) => refreshAccountModels(account))
  );

  let failed = 0;
  let added = 0;
  let removed = 0;

  for (const result of results) {
    if (result.status === "rejected") {
      failed += 1;
      continue;
    }
    const before = new Set(result.value.previousModels);
    const after = new Set(result.value.models);
    for (const model of after) {
      if (!before.has(model)) added += 1;
    }
    for (const model of before) {
      if (!after.has(model)) removed += 1;
    }
  }

  return { total: accounts.length, failed, added, removed };
}

type RefreshSummaryTranslate = (
  key: string,
  options?: Record<string, unknown>
) => string;

/**
 * Which Message tone to use for a refresh summary: `warning` when any account
 * failed, otherwise `success`. Shared so every refresh entry point renders the
 * same toast semantics.
 */
export function refreshSummaryTone(
  summary: RefreshAllAccountModelsSummary
): "success" | "warning" {
  return summary.failed > 0 ? "warning" : "success";
}

/**
 * Human-readable toast text for a refresh summary, reporting how many models
 * were added / removed (and how many accounts failed, if any). Single source of
 * truth for both the Key Vault table and the model spotlight.
 */
export function formatRefreshSummary(
  summary: RefreshAllAccountModelsSummary,
  t: RefreshSummaryTranslate
): string {
  const { added, removed, failed, total } = summary;
  if (failed > 0) {
    return t("keyVault.toasts.refreshPartial", {
      failed,
      total,
      added,
      removed,
    });
  }
  if (added === 0 && removed === 0) {
    return t("keyVault.toasts.refreshedNoChange");
  }
  return t("keyVault.toasts.refreshedDelta", { added, removed });
}
