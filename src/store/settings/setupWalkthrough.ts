export const SETUP_WALKTHROUGH_OUTCOME_KEY =
  "general.setupWalkthroughOutcome" as const;

const LEGACY_SETUP_WALKTHROUGH_COMPLETED_KEY =
  "general.setupWalkthroughCompleted" as const;

export type SetupWalkthroughOutcome = "open" | "completed" | "dismissed";

function isSetupWalkthroughOutcome(
  value: unknown
): value is SetupWalkthroughOutcome {
  return value === "open" || value === "completed" || value === "dismissed";
}

/**
 * New installs read an empty settings object and must enter onboarding.
 * Existing installs that predate onboarding state are migrated to completed so
 * an app update never interrupts an established user with first-run UI.
 *
 * The temporary boolean key is accepted only as an upgrade bridge; all current
 * readers and writers use the outcome key as the single source of truth.
 */
export function shouldSignalGitHubStarAfterSetup(
  outcome: Exclude<SetupWalkthroughOutcome, "open">
): boolean {
  return outcome === "completed";
}

export function resolveSetupWalkthroughOutcome(
  rawSettings: Record<string, unknown>
): SetupWalkthroughOutcome {
  const explicit = rawSettings[SETUP_WALKTHROUGH_OUTCOME_KEY];
  if (isSetupWalkthroughOutcome(explicit)) return explicit;

  const legacyCompleted = rawSettings[LEGACY_SETUP_WALKTHROUGH_COMPLETED_KEY];
  if (typeof legacyCompleted === "boolean") {
    return legacyCompleted ? "completed" : "open";
  }

  const isNewInstall = !Object.keys(rawSettings).some(
    (key) => key !== "$schema"
  );
  return isNewInstall ? "open" : "completed";
}
