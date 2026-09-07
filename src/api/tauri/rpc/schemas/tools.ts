/**
 * Zod schemas for tool registry and channel commands.
 *
 * ToolInfo — mixed serde defaults/hand-renames; empty/default fields may be omitted
 * ToolRegistryData — no rename_all, plain fields: tools, cli_aliases
 */
import { z } from "zod/v4";

import { CHANNEL_TYPE_VALUES } from "@src/modules/MainApp/Integrations/Connections/Channels/types";

/**
 * Zod enum mirroring the Rust `channel_type::*` constants. Tightening the
 * `channelType` parameter on toggle / probe RPCs keeps the gateway from
 * silently accepting a typo'd kind that would never connect.
 */
export const ChannelTypeSchema = z.enum(
  CHANNEL_TYPE_VALUES as unknown as [string, ...string[]]
);

// ── Tool registry types ─────────────────────────────────────────────────────

export const ToolActionSchema = z.object({
  name: z.string(),
  summary: z.string(),
  appSubtool: z.string().nullish(),
  chatBlock: z.string().nullish(),
  labelRunning: z.string().optional(),
  labelDone: z.string().optional(),
  labelFailed: z.string().optional(),
  statusLabels: z.record(z.string(), z.string()).optional(),
});

export const ToolInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  description_detail: z.string().nullish(),
  category: z.string(),
  source: z.string().optional(),
  supported_agents: z.array(z.enum(["os", "sde", "custom"])).optional(),
  icon_id: z.string().optional(),
  actionIcons: z.record(z.string(), z.string()).optional(),
  statusIcons: z.record(z.string(), z.string()).optional(),
  simulatorApp: z.string().optional(),
  appSubtool: z.string().optional(),
  chatBlock: z.string().optional(),
  humanToolKey: z.string().nullish(),
  hidden: z.boolean().optional(),
  labelRunning: z.string().optional(),
  labelDone: z.string().optional(),
  labelFailed: z.string().optional(),
  statusLabels: z.record(z.string(), z.string()).optional(),
  actions: z.array(ToolActionSchema).optional(),
  requiredCapability: z.string().optional(),
});

export const ToolRegistryDataSchema = z.object({
  tools: z.array(ToolInfoSchema),
  cli_aliases: z.record(
    z.string(),
    z.tuple([z.string(), z.string(), z.string(), z.string(), z.string()])
  ),
});

export const EffectiveToolsRequestSchema = z.object({
  request: z.object({
    sessionId: z.string(),
    agentExecMode: z.string().nullish(),
  }),
});

export const EffectiveToolsResponseSchema = z.object({
  sessionId: z.string(),
  agentExecMode: z.string(),
  registeredToolNames: z.array(z.string()),
  promptToolNames: z.array(z.string()),
  deferredToolNames: z.array(z.string()),
  promptTools: z.array(ToolInfoSchema),
});

export const CheckKeysResultSchema = z.object({
  found: z.boolean(),
  provider: z.string().nullish(),
  providerName: z.string().nullish(),
  error: z.string().optional(),
});

export type ToolAction = z.output<typeof ToolActionSchema>;
export type ToolInfo = z.output<typeof ToolInfoSchema>;
export type ToolRegistryData = z.output<typeof ToolRegistryDataSchema>;

// ── Input schemas ───────────────────────────────────────────────────────────

// Tauri 2 default: Rust `snake_case` params map to `camelCase` JS keys
// (unless the command uses `#[tauri::command(rename_all = "snake_case")]`).
// These schemas mirror what the IPC layer actually expects on the wire.

export const AgentToggleChannelInput = z.object({
  channelType: ChannelTypeSchema,
  accountId: z.string(),
  enabled: z.boolean(),
});

export const AgentCheckKeysInput = z.object({
  model: z.string(),
});

export const AgentProbeChannelInput = z.object({
  channelType: ChannelTypeSchema,
  credentials: z.record(z.string(), z.unknown()),
});

// Gateway singleton's dedicated model + account binding. Either field may be
// null/omitted to clear that half of the pair; see `GatewayChannelConfig` in
// Rust for why this is independent from any foreground session's model.
// Tauri 2 auto-camelCases top-level command args, so Rust's `account_id`
// parameter is sent as `accountId` from the frontend.
export const AgentSetGatewayModelInput = z.object({
  accountId: z.string().nullish(),
  model: z.string().nullish(),
});
