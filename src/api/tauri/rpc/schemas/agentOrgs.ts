import { z } from "zod/v4";

import {
  AvailableAgentSchema,
  ModelTypeSchema,
  NativeHarnessTypeSchema,
} from "./validation";

const JsonRecordSchema = z.record(z.string(), z.unknown());

export const ConfigRecordSchema = JsonRecordSchema;

export const ConfigPartialInput = z.object({
  partial: JsonRecordSchema,
});

export const RawConfigWriteInput = z.object({
  content: z.string(),
});

export const SessionProvenanceHookPlatformSchema = z.enum([
  "claude_code",
  "codex",
  "cursor",
]);

export const SessionProvenanceHookStatusSchema = z.object({
  platform: SessionProvenanceHookPlatformSchema,
  enabled: z.boolean(),
  desiredEnabled: z.boolean(),
  configPath: z.string(),
  error: z.string().nullable().optional(),
});

export const SessionProvenanceHookSetEnabledInput = z.object({
  platform: SessionProvenanceHookPlatformSchema,
  enabled: z.boolean(),
});

export type SessionProvenanceHookPlatform = z.output<
  typeof SessionProvenanceHookPlatformSchema
>;
export type SessionProvenanceHookStatus = z.output<
  typeof SessionProvenanceHookStatusSchema
>;

export const CliConfigFileInput = z.object({
  agentName: z.string(),
  fileId: z.string(),
});

export const CliConfigFileWriteInput = CliConfigFileInput.extend({
  content: z.string(),
});

export const HierarchyModeSchema = z.enum(["flat", "soft", "strict"]);
export const PlanApprovalPolicySchema = z.enum([
  "coordinator",
  "user",
  "automatic",
]);
export const OrgMemberRuntimeConfigSchema = z.object({
  keySource: z.enum(["own_key", "hosted_key"]).optional(),
  accountId: z.string().optional(),
  model: z.string().optional(),
  nativeHarnessType: NativeHarnessTypeSchema.optional(),
  tier: z.string().optional(),
  listingModel: z.string().optional(),
  listingModelDisplay: z.string().optional(),
  listingModelType: ModelTypeSchema.optional(),
  selectedSourceLabel: z.string().optional(),
  selectedSourceModelType: ModelTypeSchema.optional(),
});

export type OrgMemberRuntimeConfig = z.infer<
  typeof OrgMemberRuntimeConfigSchema
>;

export type OrgMember = {
  id: string;
  name: string;
  role: string;
  agentId: string;
  runtimeConfig?: OrgMemberRuntimeConfig;
  description?: string;
  hierarchyMode?: z.output<typeof HierarchyModeSchema>;
  planApprovalPolicy?: z.output<typeof PlanApprovalPolicySchema>;
  children: OrgMember[];
};

export const OrgMemberSchema: z.ZodType<OrgMember> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    role: z.string(),
    agentId: z.string(),
    runtimeConfig: OrgMemberRuntimeConfigSchema.optional(),
    description: z.string().optional(),
    hierarchyMode: HierarchyModeSchema.optional(),
    planApprovalPolicy: PlanApprovalPolicySchema.optional(),
    children: z.array(OrgMemberSchema),
  })
);

export const OrgJsonInput = z.object({
  orgJson: z.string(),
});

export const OrgIdInput = z.object({
  orgId: z.string(),
});

export const AvailableCliAgentsSchema = z.array(AvailableAgentSchema);

export const CliPermissionModeSchema = z.enum([
  "plan",
  "full_permission",
  "auto_edit",
  "manual",
]);

export const CliLaunchProfileModeDefaultsSchema = z.object({
  mode: CliPermissionModeSchema,
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
});

export const CliLaunchProfileInput = z.object({
  agentName: z.string(),
});

export const CliLaunchProfileUpdateInput = z.object({
  agentName: z.string(),
  permissionMode: CliPermissionModeSchema,
  commandOverride: z.string().optional(),
  argsOverride: z.array(z.string()).optional(),
  envOverride: z.record(z.string(), z.string()).optional(),
});

export const CliLaunchProfileViewSchema = z.object({
  agentName: z.string(),
  permissionMode: CliPermissionModeSchema,
  defaultCommand: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  manualArgs: z.array(z.string()),
  fullPermissionArgs: z.array(z.string()),
  manualEnv: z.record(z.string(), z.string()),
  fullPermissionEnv: z.record(z.string(), z.string()),
  supportedPermissionModes: z.array(CliPermissionModeSchema),
  modeDefaults: z.array(CliLaunchProfileModeDefaultsSchema),
  commandOverridden: z.boolean(),
  argsOverridden: z.boolean(),
  envOverridden: z.boolean(),
  effectiveCommand: z.array(z.string()),
  requiredArgs: z.array(z.string()),
});

export type CliPermissionMode = z.infer<typeof CliPermissionModeSchema>;
export type CliLaunchProfileView = z.infer<typeof CliLaunchProfileViewSchema>;

export const CliConfigModeSchema = z.enum(["default", "orgii_managed"]);

export const CliConfigManagedStatusInput = z.object({
  agentName: z.string(),
});

export const CliConfigEnableOrgiiManagedInput = z.object({
  agentName: z.string(),
  keyId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  force: z.boolean(),
});

export const CliConfigRestoreDefaultInput = z.object({
  agentName: z.string(),
  force: z.boolean(),
});

export const CliManagedProxyStatusInput = z.object({
  agentName: z.string(),
});

export const CliConfigTargetFileStatusSchema = z.object({
  id: z.string(),
  targetPath: z.string(),
  defaultBackupPath: z.string(),
  managedProfilePath: z.string(),
  targetExists: z.boolean(),
  hasDefaultBackup: z.boolean(),
  defaultWasMissing: z.boolean(),
  originalHash: z.string().nullable().optional(),
  lastAppliedHash: z.string().nullable().optional(),
  currentHash: z.string().nullable().optional(),
  conflict: z.boolean(),
});

export const CliConfigManagedStatusSchema = z.object({
  agentName: z.string(),
  supported: z.boolean(),
  mode: CliConfigModeSchema,
  hasDefaultBackup: z.boolean(),
  conflict: z.boolean(),
  selectedKeyId: z.string().nullable().optional(),
  selectedProvider: z.string().nullable().optional(),
  selectedModel: z.string().nullable().optional(),
  proxyUrl: z.string().nullable().optional(),
  targetFiles: z.array(CliConfigTargetFileStatusSchema),
  message: z.string().nullable().optional(),
});

export const CliManagedProxyStatusSchema = z.object({
  agentName: z.string(),
  supported: z.boolean(),
  running: z.boolean(),
  ready: z.boolean(),
  url: z.string(),
  selectedKeyId: z.string().nullable().optional(),
  selectedProvider: z.string().nullable().optional(),
  selectedModel: z.string().nullable().optional(),
  upstreamBaseUrl: z.string().nullable().optional(),
  compatibleKeyIds: z.array(z.string()),
  message: z.string().nullable().optional(),
});

export type CliConfigMode = z.infer<typeof CliConfigModeSchema>;
export type CliConfigManagedStatus = z.infer<
  typeof CliConfigManagedStatusSchema
>;
export type CliManagedProxyStatus = z.infer<typeof CliManagedProxyStatusSchema>;

export const SkillsListInput = z.object({
  workspacePath: z.string().optional(),
  agentId: z.string().optional(),
});

export const SkillReadInput = z.object({
  workspacePath: z.string().optional(),
  name: z.string(),
});

export const SkillToggleInput = z.object({
  workspacePath: z.string().optional(),
  agentId: z.string().optional(),
  name: z.string(),
  enabled: z.boolean(),
});

export const DescriptionQualitySchema = z.enum(["good", "short", "missing"]);

export const SkillInfoSchema = z.object({
  name: z.string(),
  path: z.string(),
  description: z.string(),
  source: z.string(),
  available: z.boolean(),
  always: z.boolean(),
  enabled: z.boolean(),
  requiredBins: z.array(z.string()),
  requiredEnv: z.array(z.string()),
  estimatedTokens: z.number(),
  fullContentTokens: z.number(),
  descriptionQuality: DescriptionQualitySchema,
  version: z.string(),
});

export const SkillsListSchema = z.array(SkillInfoSchema);

export const CursorPluginSkillSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  skillPath: z.string(),
});

export type CursorPluginSkill = z.infer<typeof CursorPluginSkillSchema>;

export const CursorPluginHookSchema = z.object({
  eventType: z.string(),
  label: z.string(),
  hookPath: z.string(),
});

export type CursorPluginHook = z.infer<typeof CursorPluginHookSchema>;

export const CursorPluginInfoSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string().nullable(),
  mcpConfig: z.record(z.string(), z.unknown()).nullable(),
  skills: z.array(CursorPluginSkillSchema),
  hooks: z.array(CursorPluginHookSchema),
  logoPath: z.string().nullable(),
});

export type CursorPluginInfo = z.infer<typeof CursorPluginInfoSchema>;
