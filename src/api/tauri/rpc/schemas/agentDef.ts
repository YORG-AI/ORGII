/**
 * Agent Definition RPC Schemas.
 *
 * Zod schemas for the four typed commands that replaced the legacy
 * `agent_get_config` / `agent_update_config` blob commands:
 *
 *   - agent_def_get(agent_id)          -> AgentDefinition
 *   - agent_def_update_patch(agent_id, patch) -> AgentDefinition
 *
 * Rust sources:
 *   - src-tauri/src/agent_core/core/definitions/schema.rs  (AgentDefinition)
 *   - src-tauri/src/agent_core/core/definitions/patch.rs   (AgentDefinitionPatch)
 *   - src-tauri/src/agent_core/core/definitions/commands.rs (the two RPCs)
 *
 * # Patch shape
 *
 * The patch is a partial object with `Option<T>` semantics per field:
 *
 *   - field absent → leave unchanged
 *   - field present (non-null) → replace the whole sub-struct
 *
 * We intentionally keep the wire schema as `z.record(z.string(), z.unknown())`
 * rather than mirroring every `AgentDefinition` sub-struct in Zod. Rust is
 * the source of truth for the shape; adding Zod mirrors of 25+ fields and
 * all their nested sub-configs would be a two-day task and would have to
 * be kept in lockstep with every Rust schema change. Runtime correctness
 * is already guaranteed by the Rust serde layer — a malformed patch errors
 * out with a clean Rust-side message, which the frontend surfaces.
 *
 * Callers that want TypeScript type-level guidance should import the
 * `AgentDefinitionSchema` / `AgentDefinitionPatchInput` types below for
 * field hints, even though the Zod schema itself is a passthrough record.
 */
import { z } from "zod/v4";

import type { AgentDefinition } from "@src/modules/MainApp/AgentOrgs/types";

// ── Passthrough shapes ──
//
// The full `AgentDefinition` return type and `AgentDefinitionPatch` input
// type are both free-form JSON on the wire (Rust serde handles validation).
// We model them as record<string, unknown> so the Zod layer does not reject
// fields it does not know about.

/** Full AgentDefinition as returned by `agent_def_get`. */
export const AgentDefinitionSchema = z
  .record(z.string(), z.unknown())
  .describe("AgentDefinition (shape owned by Rust schema.rs)");

export const CommandRiskRulesSchema = z.object({
  medium: z.array(z.string()),
  high: z.array(z.string()),
});

export type CommandRiskRules = z.output<typeof CommandRiskRulesSchema>;

const AgentDefinitionListRuntimeSchema = z.array(
  z
    .object({
      id: z.string(),
      name: z.string(),
      builtIn: z.boolean(),
    })
    .catchall(z.unknown())
);

export const AgentDefinitionsListSchema =
  AgentDefinitionListRuntimeSchema as unknown as z.ZodType<
    AgentDefinition[],
    AgentDefinition[]
  >;

/** Input to `agent_def_get`. */
export const AgentDefGetInput = z.object({
  agentId: z.string().min(1),
});

export type AgentDefGetInput = z.input<typeof AgentDefGetInput>;

/**
 * One row of `agent_def_tool_states` — the backend-resolved availability
 * state for a single builtin tool. The Settings tool editor renders this
 * verbatim; capability satisfaction and excluded/user-allowed precedence
 * are computed ONLY in Rust.
 */
export const AgentToolStateRowSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  systemPinned: z.boolean(),
  userAllowed: z.boolean(),
  userExcluded: z.boolean(),
  capabilityBlocked: z.boolean(),
});

export type AgentToolStateRow = z.output<typeof AgentToolStateRowSchema>;

export const AgentToolStatesSchema = z.array(AgentToolStateRowSchema);

/**
 * Partial patch for `AgentDefinition`. Every field is optional; present
 * keys replace the corresponding field on the definition wholesale.
 * See Rust `AgentDefinitionPatch` for the canonical field list.
 */
export const AgentDefinitionPatchSchema = z
  .record(z.string(), z.unknown())
  .describe("AgentDefinitionPatch (partial fields, wholesale replace)");

export type AgentDefinitionPatch = z.output<typeof AgentDefinitionPatchSchema>;

/** Input to `agent_def_update_patch`. */
export const AgentDefUpdatePatchInput = z.object({
  agentId: z.string().min(1),
  patch: AgentDefinitionPatchSchema,
});

export type AgentDefUpdatePatchInput = z.input<typeof AgentDefUpdatePatchInput>;

// ── CRUD commands (legacy agent_definitions_* commands, now typed) ──

/**
 * Input to `agent_definitions_add` — the full `AgentDefinition` serialised
 * as a JSON string (Rust deserialises with serde_json).
 */
export const AgentDefAddInput = z.object({
  agentJson: z.string().min(1),
});

export type AgentDefAddInput = z.input<typeof AgentDefAddInput>;

/** Output of `agent_definitions_add` — the newly-assigned agent id. */
export const AgentDefAddOutput = z.string();

/** Input to `agent_definitions_remove`. */
export const AgentDefRemoveInput = z.object({
  agentId: z.string().min(1),
});

export type AgentDefRemoveInput = z.input<typeof AgentDefRemoveInput>;

/** Output of `agent_definitions_remove` — true if the agent was found and deleted. */
export const AgentDefRemoveOutput = z.boolean();
