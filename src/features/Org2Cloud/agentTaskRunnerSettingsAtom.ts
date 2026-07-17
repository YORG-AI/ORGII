/**
 * Per-org agent-task runner settings (agent-pickup design §4 UI item 7).
 *
 * What the CloudAgentRunnerCard persists, per cloud org: which local key-vault
 * account, model, and exec mode the "Run here" flow passes to the ONE
 * `sendMessage` drive turn (`RunCommentTaskInput.agentOptions`). Every field
 * is optional — an absent account/model means "whatever the forked session
 * would use by default"; an absent mode resolves to `'build'` at the READ
 * helper level (`resolveAgentRunnerSettings`), never in storage, so a later
 * default change applies retroactively to orgs that never picked one.
 *
 * Same zod-validated localStorage idiom as `org2CloudAccessSettings` /
 * `org2CloudSyncAtoms`: garbage or schema-mismatched storage degrades to the
 * empty record, and absent org keys resolve to defaults.
 *
 * `autoRunEnabled` is the per-org owner opt-in for the headless auto-claim
 * plane (`kickCommentTaskRunner`). It DEFAULTS TO OFF: until the owner turns
 * it on, a teammate's @agent mention never claims/runs on the owner's
 * session — the human "Run here"/slash Address-comments click stays the only
 * consent.
 */
import { atomWithStorage } from "jotai/utils";
import { z } from "zod/v4";

import { DEFAULT_AGENT_EXEC_MODE } from "@src/config/sessionCreatorConfig";
import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

const CloudOrgAgentRunnerSettingsSchema = z.object({
  /** Key-vault account id the run's tokens come from (absent = default). */
  accountId: z.string().optional(),
  /** Model id for the drive turn (absent = the session/account default). */
  model: z.string().optional(),
  /**
   * Agent exec mode wire value. Stored loosely as a string (same
   * forward-compat stance as the Rust `AgentExecMode::parse` — an unknown
   * future mode must not nuke the whole settings record on parse).
   */
  mode: z.string().optional(),
  /**
   * Owner opt-in for headless auto-claim of open @agent tasks on this org's
   * owned sessions. Absent ⇒ OFF (never stored as `false`).
   */
  autoRunEnabled: z.boolean().optional(),
});

export type CloudOrgAgentRunnerSettings = z.output<
  typeof CloudOrgAgentRunnerSettingsSchema
>;

const AgentRunnerSettingsByOrgSchema = z.record(
  z.string(),
  CloudOrgAgentRunnerSettingsSchema
);

export type AgentRunnerSettingsByOrg = z.output<
  typeof AgentRunnerSettingsByOrgSchema
>;

export const AGENT_TASK_RUNNER_SETTINGS_STORAGE_KEY =
  "orgii:org2-cloud-v1:agentTaskRunnerSettings";

/**
 * Test hook (`__COMMENT_TASK_RUNNER_INTERNALS` idiom): the EXACT zod storage
 * the atom persists through, so the roundtrip/degradation tests exercise the
 * real schema. `getOnInit` hydrates once at atom creation, so a fresh jotai
 * store cannot observe rehydration mid-process — tests go through this seam.
 */
export const __AGENT_RUNNER_SETTINGS_STORAGE =
  createZodJsonStorage<AgentRunnerSettingsByOrg>(
    AgentRunnerSettingsByOrgSchema
  );

/** Cloud orgId → runner settings (absent org ⇒ defaults, mode 'build'). */
export const agentTaskRunnerSettingsAtom =
  atomWithStorage<AgentRunnerSettingsByOrg>(
    AGENT_TASK_RUNNER_SETTINGS_STORAGE_KEY,
    {},
    __AGENT_RUNNER_SETTINGS_STORAGE,
    { getOnInit: true }
  );
agentTaskRunnerSettingsAtom.debugLabel = "agentTaskRunnerSettingsAtom";

/**
 * Concrete per-run settings, spreadable into
 * `RunCommentTaskInput.agentOptions` verbatim. `mode` is always present;
 * `accountId`/`model` keys exist only when explicitly chosen (key-presence
 * semantics — `sendMessage` treats an absent key as "use the default").
 */
export interface ResolvedAgentRunnerSettings {
  accountId?: string;
  model?: string;
  /** Always concrete; defaults to `'build'` (DEFAULT_AGENT_EXEC_MODE). */
  mode: string;
  /** Owner auto-claim opt-in; defaults to `false` (absent org ⇒ OFF). */
  autoRunEnabled: boolean;
}

/**
 * The READ-side defaults resolution: absent org / absent mode ⇒ 'build';
 * absent `autoRunEnabled` ⇒ `false` (auto-claim stays off until opted in).
 */
export function resolveAgentRunnerSettings(
  byOrg: AgentRunnerSettingsByOrg,
  orgId: string
): ResolvedAgentRunnerSettings {
  const stored = byOrg[orgId];
  const resolved: ResolvedAgentRunnerSettings = {
    mode:
      stored?.mode !== undefined && stored.mode.length > 0
        ? stored.mode
        : DEFAULT_AGENT_EXEC_MODE,
    autoRunEnabled: stored?.autoRunEnabled === true,
  };
  if (stored?.accountId !== undefined && stored.accountId.length > 0) {
    resolved.accountId = stored.accountId;
  }
  if (stored?.model !== undefined && stored.model.length > 0) {
    resolved.model = stored.model;
  }
  return resolved;
}

/**
 * Immutable single-field update (`with*` idiom of org2CloudAccessSettings).
 * `undefined` or `""` clears the field back to its default; a record with no
 * remaining fields is dropped entirely so storage never accumulates `{}`
 * husks. No-op updates return the SAME reference (atom write elision).
 */
export function withAgentRunnerSetting(
  byOrg: AgentRunnerSettingsByOrg,
  orgId: string,
  field: "accountId" | "model" | "mode",
  value: string | undefined
): AgentRunnerSettingsByOrg {
  const current = byOrg[orgId] ?? {};
  const normalized =
    value !== undefined && value.length > 0 ? value : undefined;
  if (current[field] === normalized) return byOrg;
  const next: CloudOrgAgentRunnerSettings = { ...current };
  if (normalized === undefined) {
    delete next[field];
  } else {
    next[field] = normalized;
  }
  if (Object.keys(next).length === 0) {
    const { [orgId]: _dropped, ...rest } = byOrg;
    return rest;
  }
  return { ...byOrg, [orgId]: next };
}

/**
 * Set the per-org auto-claim opt-in. `false` clears the field (never stored),
 * so the default-OFF invariant holds and storage never accumulates `{}`
 * husks. No-op updates return the SAME reference (atom write elision).
 */
export function withAgentRunnerAutoRun(
  byOrg: AgentRunnerSettingsByOrg,
  orgId: string,
  enabled: boolean
): AgentRunnerSettingsByOrg {
  const current = byOrg[orgId] ?? {};
  const normalized = enabled ? true : undefined;
  if (current.autoRunEnabled === normalized) return byOrg;
  const next: CloudOrgAgentRunnerSettings = { ...current };
  if (normalized === undefined) {
    delete next.autoRunEnabled;
  } else {
    next.autoRunEnabled = true;
  }
  if (Object.keys(next).length === 0) {
    const { [orgId]: _dropped, ...rest } = byOrg;
    return rest;
  }
  return { ...byOrg, [orgId]: next };
}
