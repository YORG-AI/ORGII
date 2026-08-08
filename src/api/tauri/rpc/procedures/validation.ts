import { z } from "zod/v4";

import { defineProcedure } from "../invoke";
import * as schemas from "../schemas";

export const validation = {
  validateKey: defineProcedure("validate_key")
    .input(schemas.validation.ValidateKeyInput)
    .output(schemas.validation.ValidationResultSchema)
    .build(),

  testModelAvailability: defineProcedure("test_model_availability")
    .input(schemas.validation.TestModelAvailabilityInput)
    .output(schemas.validation.TestModelResultSchema)
    .build(),

  fetchKeyQuota: defineProcedure("fetch_key_quota")
    .input(schemas.validation.FetchKeyQuotaInput)
    .output(schemas.validation.QuotaInfoSchema)
    .build(),

  refreshKeyQuota: defineProcedure("refresh_key_quota")
    .input(schemas.validation.RefreshKeyQuotaInput)
    .output(schemas.validation.KeyInfoSchema.nullable())
    .build(),

  getKeyQuotaRefreshStatus: defineProcedure("get_key_quota_refresh_status")
    .input(schemas.validation.GetKeyQuotaRefreshStatusInput)
    .output(schemas.validation.KeyQuotaRefreshStatusInfoSchema.nullable())
    .build(),

  cursorSyncBillingUsage: defineProcedure("cursor_sync_billing_usage")
    .input(schemas.validation.CursorBillingUsageInput)
    .output(schemas.validation.CursorBillingUsageSnapshotSchema)
    .build(),

  cursorReadBillingUsagePage: defineProcedure("cursor_read_billing_usage_page")
    .input(schemas.validation.CursorBillingUsagePageInput)
    .output(schemas.validation.CursorBillingUsagePageSchema)
    .build(),

  cursorArchiveBillingUsageCache: defineProcedure(
    "cursor_archive_billing_usage_cache"
  )
    .input(schemas.validation.CursorArchiveBillingUsageCacheInput)
    .output(schemas.validation.ArchivedCursorBillingUsageCacheSchema)
    .build(),

  listKeys: defineProcedure("list_keys")
    .output(z.array(schemas.validation.KeyInfoSchema))
    .build(),

  getKey: defineProcedure("get_key")
    .input(schemas.validation.GetKeyInput)
    .output(schemas.validation.KeyInfoSchema.nullable())
    .build(),

  getKeyById: defineProcedure("get_key_by_id")
    .input(schemas.validation.GetKeyByIdInput)
    .output(schemas.validation.KeyInfoSchema.nullable())
    .build(),

  getFullKey: defineProcedure("get_full_key")
    .input(schemas.validation.GetKeyInput)
    .output(schemas.validation.FullKeyResponseSchema.nullable())
    .build(),

  saveKey: defineProcedure("save_key")
    .input(schemas.validation.SaveKeyInput)
    .output(schemas.validation.KeyInfoSchema)
    .build(),

  deleteKey: defineProcedure("delete_key")
    .input(schemas.validation.DeleteKeyInput)
    .output(z.boolean())
    .build(),

  deleteKeyById: defineProcedure("delete_key_by_id")
    .input(schemas.validation.DeleteKeyByIdInput)
    .output(z.boolean())
    .build(),

  updateKeyHealth: defineProcedure("update_key_health")
    .input(schemas.validation.UpdateKeyHealthInput)
    .output(schemas.validation.KeyInfoSchema.nullable())
    .build(),

  promptPolish: defineProcedure("prompt_polish")
    .input(schemas.validation.PromptPolishInput)
    .output(schemas.validation.PromptPolishResponseSchema)
    .build(),

  sessionStepExplain: defineProcedure("session_step_explain")
    .input(schemas.validation.SessionStepExplainInput)
    .output(schemas.validation.SessionStepExplainResponseSchema)
    .build(),

  housekeeperHealthCheck: defineProcedure("housekeeper_health_check")
    .input(schemas.validation.HousekeeperHealthCheckInput)
    .output(schemas.validation.HousekeeperHealthCheckResponseSchema)
    .build(),

  housekeeperTokenBenchmark: defineProcedure("housekeeper_token_benchmark")
    .input(schemas.validation.HousekeeperTokenBenchmarkInput)
    .output(schemas.validation.HousekeeperTokenBenchmarkResponseSchema)
    .build(),

  housekeeperUiIntent: defineProcedure("housekeeper_ui_intent")
    .input(schemas.validation.HousekeeperUiIntentInput)
    .output(schemas.validation.HousekeeperUiIntentResponseSchema)
    .build(),

  getEnvForAgent: defineProcedure("get_env_for_agent")
    .input(schemas.validation.GetEnvForAgentInput)
    .output(z.record(z.string(), z.string()))
    .build(),

  getAllKeysForAgent: defineProcedure("get_all_keys_for_agent")
    .input(schemas.validation.GetAllKeysForAgentInput)
    .output(z.array(schemas.validation.KeyInfoSchema))
    .build(),

  autoDetectKey: defineProcedure("auto_detect_key")
    .input(schemas.validation.AutoDetectKeyInput)
    .output(schemas.validation.AutoDetectResultSchema)
    .build(),

  scanCliVersion: defineProcedure("scan_cli_version")
    .input(schemas.validation.ScanCliVersionInput)
    .output(schemas.validation.CliVersionSnapshotSchema)
    .build(),

  getAvailableAgents: defineProcedure("get_available_agents")
    .output(z.array(schemas.validation.AvailableAgentSchema))
    .build(),

  getAvailableApiProviders: defineProcedure("get_available_api_providers")
    .output(z.array(schemas.validation.AvailableApiProviderSchema))
    .build(),

  autoInstallCli: defineProcedure("auto_install_cli")
    .input(schemas.validation.AutoInstallCliInput)
    .build(),

  getCursorCliModels: defineProcedure("get_cursor_cli_models")
    .input(schemas.validation.GetCursorCliModelsInput)
    .output(z.array(z.string()))
    .build(),

  cursorListModelsNative: defineProcedure("cursor_list_models_native")
    .input(schemas.validation.CursorListModelsNativeInput)
    .output(z.array(schemas.validation.CursorNativeModelSchema))
    .build(),

  oauthModelCatalog: defineProcedure("oauth_model_catalog")
    .input(schemas.validation.OAuthModelCatalogInput)
    .output(schemas.validation.OAuthModelCatalogResponseSchema)
    .build(),

  refreshOauthToken: defineProcedure("refresh_oauth_token")
    .input(schemas.validation.RefreshOauthTokenInput)
    .build(),

  startCursorNativeOauthLogin: defineProcedure(
    "start_cursor_native_oauth_login"
  )
    .output(schemas.validation.CursorNativeOauthStartResponseSchema)
    .build(),

  pollCursorNativeOauthToken: defineProcedure("poll_cursor_native_oauth_token")
    .input(schemas.validation.CursorNativeOauthPollInput)
    .output(schemas.validation.CursorNativeOauthPollResponseSchema)
    .build(),

  startClaudeCodeOauthLogin: defineProcedure("start_claude_code_oauth_login")
    .output(schemas.validation.ClaudeCodeOauthStartResponseSchema)
    .build(),

  exchangeClaudeCodeOauthCode: defineProcedure(
    "exchange_claude_code_oauth_code"
  )
    .input(schemas.validation.ClaudeCodeOauthExchangeInput)
    .output(schemas.validation.ClaudeCodeOauthExchangeResponseSchema)
    .build(),

  startCodexOauthLogin: defineProcedure("start_codex_oauth_login")
    .output(schemas.validation.CodexOauthStartResponseSchema)
    .build(),

  exchangeCodexOauthCode: defineProcedure("exchange_codex_oauth_code")
    .input(schemas.validation.CodexOauthExchangeInput)
    .output(schemas.validation.CodexOauthExchangeResponseSchema)
    .build(),

  getProviderConfig: defineProcedure("get_provider_config")
    .input(schemas.validation.GetProviderConfigInput)
    .output(schemas.validation.ProviderConfigSchema)
    .build(),

  getAllProviderConfigs: defineProcedure("get_all_provider_configs")
    .output(z.record(z.string(), schemas.validation.ProviderConfigSchema))
    .build(),
} as const;
