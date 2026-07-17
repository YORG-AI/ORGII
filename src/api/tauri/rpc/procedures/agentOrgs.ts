import { z } from "zod/v4";

import { defineProcedure } from "../invoke";
import * as schemas from "../schemas";

export type {
  CursorPluginHook,
  CursorPluginInfo,
  CursorPluginSkill,
} from "../schemas/agentOrgs";

const cursor = {
  readConfig: defineProcedure("cursor_cli_config_read")
    .output(schemas.agentOrgs.ConfigRecordSchema)
    .build(),
  writeConfigPartial: defineProcedure("cursor_cli_config_write_partial")
    .input(schemas.agentOrgs.ConfigPartialInput)
    .build(),
  readSandbox: defineProcedure("cursor_sandbox_config_read")
    .output(schemas.agentOrgs.ConfigRecordSchema)
    .build(),
  writeSandboxPartial: defineProcedure("cursor_sandbox_config_write_partial")
    .input(schemas.agentOrgs.ConfigPartialInput)
    .build(),
  getPath: defineProcedure("cursor_cli_config_get_path")
    .output(z.string())
    .build(),
  readRaw: defineProcedure("cursor_cli_config_read_raw")
    .output(z.string())
    .build(),
  writeRaw: defineProcedure("cursor_cli_config_write_raw")
    .input(schemas.agentOrgs.RawConfigWriteInput)
    .build(),
  listPlugins: defineProcedure("cursor_plugins_list")
    .output(z.array(schemas.agentOrgs.CursorPluginInfoSchema))
    .build(),
} as const;

const codex = {
  readConfig: defineProcedure("codex_config_read")
    .output(schemas.agentOrgs.ConfigRecordSchema)
    .build(),
  writeConfigPartial: defineProcedure("codex_config_write_partial")
    .input(schemas.agentOrgs.ConfigPartialInput)
    .build(),
  getPath: defineProcedure("codex_config_get_path").output(z.string()).build(),
  readRaw: defineProcedure("codex_config_read_raw").output(z.string()).build(),
  writeRaw: defineProcedure("codex_config_write_raw")
    .input(schemas.agentOrgs.RawConfigWriteInput)
    .build(),
} as const;

const claudeCode = {
  readConfig: defineProcedure("claude_code_config_read")
    .output(schemas.agentOrgs.ConfigRecordSchema)
    .build(),
  writeConfigPartial: defineProcedure("claude_code_config_write_partial")
    .input(schemas.agentOrgs.ConfigPartialInput)
    .build(),
  getPath: defineProcedure("claude_code_config_get_path")
    .output(z.string())
    .build(),
  readRaw: defineProcedure("claude_code_config_read_raw")
    .output(z.string())
    .build(),
  writeRaw: defineProcedure("claude_code_config_write_raw")
    .input(schemas.agentOrgs.RawConfigWriteInput)
    .build(),
} as const;

const cliConfigFiles = {
  getPath: defineProcedure("cli_config_file_get_path")
    .input(schemas.agentOrgs.CliConfigFileInput)
    .output(z.string())
    .build(),
  readRaw: defineProcedure("cli_config_file_read_raw")
    .input(schemas.agentOrgs.CliConfigFileInput)
    .output(z.string())
    .build(),
  reveal: defineProcedure("cli_config_file_reveal")
    .input(schemas.agentOrgs.CliConfigFileInput)
    .build(),
  writeRaw: defineProcedure("cli_config_file_write_raw")
    .input(schemas.agentOrgs.CliConfigFileWriteInput)
    .build(),
} as const;

const launchProfiles = {
  get: defineProcedure("cli_launch_profile_get")
    .input(schemas.agentOrgs.CliLaunchProfileInput)
    .output(schemas.agentOrgs.CliLaunchProfileViewSchema)
    .build(),
  update: defineProcedure("cli_launch_profile_update")
    .input(schemas.agentOrgs.CliLaunchProfileUpdateInput)
    .output(schemas.agentOrgs.CliLaunchProfileViewSchema)
    .build(),
  reset: defineProcedure("cli_launch_profile_reset")
    .input(schemas.agentOrgs.CliLaunchProfileInput)
    .output(schemas.agentOrgs.CliLaunchProfileViewSchema)
    .build(),
} as const;

const managedConfig = {
  getStatus: defineProcedure("cli_config_get_status")
    .input(schemas.agentOrgs.CliConfigManagedStatusInput)
    .output(schemas.agentOrgs.CliConfigManagedStatusSchema)
    .build(),
  enableOrgiiManaged: defineProcedure("cli_config_enable_orgii_managed")
    .input(schemas.agentOrgs.CliConfigEnableOrgiiManagedInput)
    .output(schemas.agentOrgs.CliConfigManagedStatusSchema)
    .build(),
  restoreDefault: defineProcedure("cli_config_restore_default")
    .input(schemas.agentOrgs.CliConfigRestoreDefaultInput)
    .output(schemas.agentOrgs.CliConfigManagedStatusSchema)
    .build(),
  proxyStatus: defineProcedure("cli_managed_proxy_status")
    .input(schemas.agentOrgs.CliManagedProxyStatusInput)
    .output(schemas.agentOrgs.CliManagedProxyStatusSchema)
    .build(),
} as const;

const sessionProvenance = {
  status: defineProcedure("session_provenance_hooks_status")
    .output(z.array(schemas.agentOrgs.SessionProvenanceHookStatusSchema))
    .build(),
  setEnabled: defineProcedure("session_provenance_hooks_set_enabled")
    .input(schemas.agentOrgs.SessionProvenanceHookSetEnabledInput)
    .output(schemas.agentOrgs.SessionProvenanceHookStatusSchema)
    .build(),
  masterEnabled: defineProcedure("session_provenance_hooks_master_enabled")
    .output(z.boolean())
    .build(),
  setMasterEnabled: defineProcedure(
    "session_provenance_hooks_set_master_enabled"
  )
    .input(z.object({ enabled: z.boolean() }))
    .output(z.array(schemas.agentOrgs.SessionProvenanceHookStatusSchema))
    .build(),
  recentSignals: defineProcedure("session_provenance_recent_signals")
    .input(schemas.agentOrgs.SessionProvenanceRecentSignalsInput)
    .output(z.array(schemas.agentOrgs.SessionProvenanceRecentSignalSchema))
    .build(),
  liveStatusEnabled: defineProcedure("session_provenance_live_status_enabled")
    .output(z.boolean())
    .build(),
  setLiveStatusEnabled: defineProcedure(
    "session_provenance_set_live_status_enabled"
  )
    .input(z.object({ enabled: z.boolean() }))
    .output(z.array(schemas.agentOrgs.SessionProvenanceHookStatusSchema))
    .build(),
  liveStatusList: defineProcedure("agent_live_status_list")
    .output(z.array(schemas.agentOrgs.AgentLiveStatusSchema))
    .build(),
} as const;

const skills = {
  list: defineProcedure("skills_list")
    .input(schemas.agentOrgs.SkillsListInput)
    .output(schemas.agentOrgs.SkillsListSchema)
    .build(),
  read: defineProcedure("skills_read")
    .input(schemas.agentOrgs.SkillReadInput)
    .output(z.string())
    .build(),
  toggle: defineProcedure("skills_toggle")
    .input(schemas.agentOrgs.SkillToggleInput)
    .build(),
} as const;

const memory = {
  personalWorkspace: defineProcedure("project_personal_workspace")
    .output(z.string())
    .build(),
} as const;

const orgs = {
  list: defineProcedure("agent_orgs_list")
    .output(z.array(schemas.agentOrgs.OrgMemberSchema))
    .build(),
  add: defineProcedure("agent_orgs_add")
    .input(schemas.agentOrgs.OrgJsonInput)
    .build(),
  update: defineProcedure("agent_orgs_update")
    .input(schemas.agentOrgs.OrgJsonInput)
    .build(),
  remove: defineProcedure("agent_orgs_remove")
    .input(schemas.agentOrgs.OrgIdInput)
    .build(),
} as const;

export const agentOrgs = {
  availableCliAgents: defineProcedure("get_available_agents")
    .output(schemas.agentOrgs.AvailableCliAgentsSchema)
    .build(),
  cursor,
  codex,
  claudeCode,
  cliConfigFiles,
  launchProfiles,
  managedConfig,
  sessionProvenance,
  memory,
  orgs,
  skills,
} as const;
