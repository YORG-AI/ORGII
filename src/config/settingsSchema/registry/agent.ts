import { z } from "zod";

import type { SettingDefinition } from "@src/config/settingsSchema/types";

/**
 * Agent settings registry.
 *
 * Per-agent backend knobs (model, temperature, compaction, security,
 * runtime, etc.) live on the backend `AgentDefinition`
 * (S3 — `~/.orgii/agent_definitions/<id>.json`) as the single source of
 * truth. They are edited via the AgentOrgs section (which is also
 * embedded into the Settings → Agent tab via slot rendering) and
 * persisted directly through `agent_def_update_patch` / the legacy
 * `update_agent_config` Tauri commands.
 *
 * The settings.jsonc file (S1) intentionally does NOT mirror those
 * backend knobs. If the user opens the JSONC editor they will not see
 * `agent.os.<backend-knob>` or `agent.sde.<backend-knob>` keys — that's
 * by design. Adding them back here would re-introduce the S1 ⇄ S3
 * dual-write split-brain documented as P0-10.
 *
 * The key below is different: it is a pure frontend UX preference
 * consumed by `AskQuestionCard`, not a backend `AgentDefinition` field.
 * The Rust `AgentDefinition` struct has no `question_auto_skip_timeout`
 * field. Storing it in S1 is correct.
 */

const questionAutoSkipTimeoutByPresenceSchema = z.object({
  online: z.number().int().min(0).max(300),
  invisible: z.number().int().min(0).max(300),
  away: z.number().int().min(0).max(300),
});

const planAutoApproveTimeoutByPresenceSchema = z.object({
  online: z.number().int().min(0).max(3600),
  invisible: z.number().int().min(0).max(3600),
  away: z.number().int().min(0).max(3600),
});

const goalMaxTurnsByPresenceSchema = z.object({
  online: z.number().int().min(0).max(100),
  invisible: z.number().int().min(0).max(100),
  away: z.number().int().min(0).max(100),
});

const modeSwitchAutoPlanByPresenceSchema = z.object({
  online: z.boolean(),
  invisible: z.boolean(),
  away: z.boolean(),
});

export const AGENT_SETTINGS_REGISTRY = {
  "agent.sde.questionAutoSkipTimeoutByPresence": {
    schema: questionAutoSkipTimeoutByPresenceSchema,
    default: {
      online: 0,
      invisible: 30,
      away: 180,
    },
    description:
      "Auto-skip agent questions after N seconds per user status (0 = disabled). Backend-enforced: pending questions resolve even when the UI is closed.",
    category: "agent",
  },
  "agent.sde.planAutoApproveTimeoutByPresence": {
    schema: planAutoApproveTimeoutByPresenceSchema,
    default: {
      online: 0,
      invisible: 120,
      away: 0,
    },
    description:
      "Auto-approve pending plan approvals after N seconds per user status (0 = disabled). Backend-enforced; the approval card is marked as auto-approved.",
    category: "agent",
  },
  "agent.sde.goalMaxTurnsByPresence": {
    schema: goalMaxTurnsByPresenceSchema,
    default: {
      online: 0,
      invisible: 20,
      away: 0,
    },
    description:
      "Goal continuation loop budget per user status (0 = disabled). When > 0, the agent judges its own turn-end output against the original request and keeps working until done or the budget runs out.",
    category: "agent",
  },
  "agent.sde.modeSwitchAutoPlanByPresence": {
    schema: modeSwitchAutoPlanByPresenceSchema,
    default: {
      online: false,
      invisible: false,
      away: false,
    },
    description:
      "Auto-switch pending mode-switch suggestions to Plan mode on timeout per user status. Disabled by default to preserve timeout-as-skip behavior.",
    category: "agent",
  },
} as const satisfies Record<string, SettingDefinition>;
