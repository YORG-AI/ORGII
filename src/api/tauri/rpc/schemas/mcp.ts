/**
 * Zod schemas for MCP Tauri commands (local manager + Official Registry hub).
 *
 * Rust: `agent_core/intelligence/mcp/commands.rs`, `mcp/registries/hub.rs`
 * Core types use `#[serde(rename_all = "camelCase")]`.
 */
import { z } from "zod/v4";

// ── Transport & config ─────────────────────────────────────────────────────

/** Stable write-only placeholder returned for MCP command/args/cwd/url and
 * every env/header value. Sending it back preserves only the same field (and
 * map key) on the same server in the exact owning scope. Non-empty `args` use
 * `[sentinel]` as one whole-field placeholder; mixed args are rejected. */
export const MCP_SECRET_REDACTED_SENTINEL =
  "__ORGII_MCP_SECRET_REDACTED__" as const;

export const McpTransportTypeSchema = z.enum([
  "stdio",
  "sse",
  "streamableHttp",
]);

export const McpServerConfigSchema = z
  .object({
    type: McpTransportTypeSchema,
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    autoApprove: z.array(z.string()).optional(),
    disabled: z.boolean(),
    timeout: z.number().int().nonnegative(),
  })
  .passthrough();

export const McpConfigFileSchema = z
  .object({
    mcpServers: z.record(z.string(), McpServerConfigSchema).default({}),
  })
  .passthrough();

// ── Scope ────────────────────────────────────────────────────────────────────

/** Mirrors Rust `McpConfigScope` (config.rs).
 * `"global"` → `~/.orgii/mcp-servers.json`,
 * `"workspace"` → `<workspace>/.orgii/mcp-servers.json`. */
export const McpConfigScopeSchema = z.enum(["global", "workspace"]);
export type McpConfigScope = z.infer<typeof McpConfigScopeSchema>;

// ── Status & tools ──────────────────────────────────────────────────────────

export const McpConnectionStatusSchema = z.enum([
  "connected",
  "connecting",
  "disconnected",
  "error",
  "needsAuth",
  "disabled",
]);

export const McpServerStatusSchema = z.object({
  name: z.string(),
  status: McpConnectionStatusSchema,
  toolCount: z.number().int().nonnegative(),
  error: z.string().optional(),
  transportType: z.string(),
  /** Mirror of the on-disk `disabled` flag. Independent of `status` so a
   * row that was just re-enabled can still show the toggle as on while
   * `status` is `connecting`. */
  disabled: z.boolean().default(false),
  /** Unix milliseconds when the current MCP session completed its
   * `initialize` handshake. `null`/absent for non-connected rows. */
  connectedAt: z.number().int().nullable().optional(),
  /** Which config file this server comes from.
   * `"global"` → `~/.orgii/mcp-servers.json`;
   * `"workspace"` → `<workspace>/.orgii/mcp-servers.json`. */
  scope: McpConfigScopeSchema.default("global"),
});

export const McpToolDefSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});

export const McpTestResultSchema = z.object({
  success: z.boolean(),
  toolCount: z.number().int().nonnegative(),
  tools: z.array(McpToolDefSchema),
  error: z.string().optional(),
  serverName: z.string().optional(),
});

// ── Resources ────────────────────────────────────────────────────────────────

export const McpResourceSchema = z.object({
  uri: z.string(),
  name: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
});

export const McpResourceTemplateSchema = z.object({
  uriTemplate: z.string(),
  name: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});

export const McpResourceContentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    uri: z.string(),
    mimeType: z.string().optional(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("blob"),
    uri: z.string(),
    mimeType: z.string().optional(),
    blob: z.string(),
  }),
]);

// ── Prompts ────────────────────────────────────────────────────────────────

export const McpPromptArgumentSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean(),
});

export const McpPromptSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  arguments: z.array(McpPromptArgumentSchema),
});

export const McpPromptEntrySchema = z.object({
  name: z.string(),
  serverName: z.string(),
  prompt: McpPromptSchema,
});

export const McpPromptMessageRoleSchema = z.enum(["user", "assistant"]);

export const McpPromptMessageSchema = z.object({
  role: McpPromptMessageRoleSchema,
  text: z.string(),
});

export const McpPromptRenderedSchema = z.object({
  description: z.string().optional(),
  messages: z.array(McpPromptMessageSchema),
});

// ── Inputs ─────────────────────────────────────────────────────────────────

export const McpListServersInput = z
  .object({
    workspacePath: z.string().optional(),
  })
  .default({});

export const McpUpdateServersInput = z.object({
  workspacePath: z.string().optional(),
  /** Full file shape from the UI; validated loosely to accept editor payloads. */
  config: z.unknown(),
  scope: McpConfigScopeSchema.optional(),
});

export const McpTestServerInput = z.object({
  serverName: z.string(),
  /** Single server block from settings; may include extra keys from JSON editor. */
  config: z.unknown(),
  /** Required to resolve redacted connection values in a workspace owner. */
  workspacePath: z.string().optional(),
  scope: McpConfigScopeSchema.optional(),
});

export const McpServerNameInput = z.object({
  serverName: z.string(),
});

export const McpSetServerDisabledInput = z.object({
  serverName: z.string(),
  disabled: z.boolean(),
  workspacePath: z.string().optional(),
});

export const McpBulkSetDisabledInput = z.object({
  serverNames: z.array(z.string()),
  disabled: z.boolean(),
  workspacePath: z.string().optional(),
});

export const McpBulkServerNamesInput = z.object({
  serverNames: z.array(z.string()),
});

/**
 * Backend returns `{ server_name: error_message | null }`.
 * `null` means that server's operation succeeded. Non-null is a
 * human-readable error string.
 */
export const McpBulkResultSchema = z.record(z.string(), z.string().nullable());

export const McpReadResourceInput = z.object({
  serverName: z.string(),
  uri: z.string(),
});

export const McpGetPromptInput = z.object({
  serverName: z.string(),
  promptName: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

export const McpRenderPromptInput = McpGetPromptInput;

export const McpGetConfigInput = z.object({
  workspacePath: z.string().optional(),
  scope: McpConfigScopeSchema.optional(),
});
