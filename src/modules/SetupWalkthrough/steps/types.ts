/**
 * Shared shape for every readiness step in the setup walkthrough.
 */
import type { SetupWalkthroughController } from "../useSetupWalkthroughController";

export type StepProps = { controller: SetupWalkthroughController };

export const CONTROL_STYLE = { width: "100%", maxWidth: "100%" } as const;
