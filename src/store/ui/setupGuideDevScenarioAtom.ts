import { atom } from "jotai";

export const SETUP_GUIDE_DEV_SCENARIO = {
  LIVE: "live",
  NO_ORGANIZATION: "no_organization",
  MEMBER: "member",
  ADMIN: "admin",
  OWNER: "owner",
} as const;

export type SetupGuideDevScenario =
  (typeof SETUP_GUIDE_DEV_SCENARIO)[keyof typeof SETUP_GUIDE_DEV_SCENARIO];
export type SetupGuideRoleScenario =
  | typeof SETUP_GUIDE_DEV_SCENARIO.MEMBER
  | typeof SETUP_GUIDE_DEV_SCENARIO.ADMIN
  | typeof SETUP_GUIDE_DEV_SCENARIO.OWNER;

/**
 * Development-only presentation override for the onboarding invite journey.
 * Runtime-only by design: it never changes the cloud roster or persists.
 */
export const setupGuideDevScenarioAtom = atom<SetupGuideDevScenario>(
  SETUP_GUIDE_DEV_SCENARIO.LIVE
);
setupGuideDevScenarioAtom.debugLabel = "setupGuideDevScenarioAtom";

export function isSetupGuideRoleScenario(
  scenario: SetupGuideDevScenario
): scenario is SetupGuideRoleScenario {
  return (
    scenario === SETUP_GUIDE_DEV_SCENARIO.MEMBER ||
    scenario === SETUP_GUIDE_DEV_SCENARIO.ADMIN ||
    scenario === SETUP_GUIDE_DEV_SCENARIO.OWNER
  );
}

export function resolveSetupGuideDevCloudOrg<T extends { role: string }>(
  realOrg: T | null,
  scenario: SetupGuideDevScenario
): T | null {
  if (scenario === SETUP_GUIDE_DEV_SCENARIO.NO_ORGANIZATION) return null;
  if (scenario === SETUP_GUIDE_DEV_SCENARIO.LIVE || !realOrg) return realOrg;
  return { ...realOrg, role: scenario };
}

export function resolveSetupGuideDevRole<T extends string>(
  realRole: T | null | undefined,
  scenario: SetupGuideDevScenario
): T | SetupGuideRoleScenario | null {
  if (scenario === SETUP_GUIDE_DEV_SCENARIO.NO_ORGANIZATION) return null;
  if (isSetupGuideRoleScenario(scenario)) return scenario;
  return realRole ?? null;
}
