import { z } from "zod";

export const SETUP_GOALS = [
  "personal",
  "team_activity",
  "work_management",
] as const;

export const SETUP_SHARING_LEVELS = [
  "off",
  "metadata_only",
  "full_replay",
] as const;

export const SetupToolSummarySchema = z.object({
  agentType: z.enum(["codex", "claude_code", "cursor_cli"]),
  found: z.boolean(),
  keyCount: z.number().int().nonnegative(),
  validatedCount: z.number().int().nonnegative(),
});

export const SetupWalkthroughProgressSchema = z.object({
  version: z.literal(1),
  goal: z.enum(SETUP_GOALS).nullable(),
  currentStepId: z.string(),
  completedStepIds: z.array(z.string()),
  tools: z.array(SetupToolSummarySchema),
  historySessionCount: z.number().int().nonnegative().nullable(),
  selectedOrgId: z.string().nullable(),
  selectedOrgName: z.string().nullable(),
  selectedOrgRole: z.string().nullable(),
  repoScopes: z.array(z.string()),
  sharingFloor: z.enum(SETUP_SHARING_LEVELS),
  inviteLink: z.string().nullable(),
  tutorialId: z.enum(["general-layout", "code-editor"]).nullable(),
  verifiedAt: z.number().nonnegative().nullable(),
});

export type SetupWalkthroughProgress = z.infer<
  typeof SetupWalkthroughProgressSchema
>;

export function createDefaultSetupWalkthroughProgress(): SetupWalkthroughProgress {
  return {
    version: 1,
    goal: null,
    currentStepId: "goal",
    completedStepIds: [],
    tools: [],
    historySessionCount: null,
    selectedOrgId: null,
    selectedOrgName: null,
    selectedOrgRole: null,
    repoScopes: [],
    sharingFloor: "metadata_only",
    inviteLink: null,
    tutorialId: null,
    verifiedAt: null,
  };
}

export const DEFAULT_SETUP_WALKTHROUGH_PROGRESS =
  createDefaultSetupWalkthroughProgress();

export function normalizeSetupWalkthroughProgress(
  value: unknown
): SetupWalkthroughProgress {
  const parsed = SetupWalkthroughProgressSchema.safeParse(value);
  return parsed.success ? parsed.data : createDefaultSetupWalkthroughProgress();
}
