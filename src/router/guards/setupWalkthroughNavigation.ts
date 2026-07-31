import { ROUTES } from "@src/config/routes";
import type { SetupWalkthroughOutcome } from "@src/store/settings/setupWalkthrough";

export type SetupWalkthroughNavigation =
  | "continue"
  | "redirect-to-setup"
  | "redirect-to-workstation"
  | "wait";

function bypassesSetupWalkthrough(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === ROUTES.auth.login.path ||
    pathname.startsWith("/orgii/windows/") ||
    pathname.includes("/marketplace/callback")
  );
}

export function resolveSetupWalkthroughNavigation(args: {
  loaded: boolean;
  outcome: SetupWalkthroughOutcome;
  pathname: string;
}): SetupWalkthroughNavigation {
  if (bypassesSetupWalkthrough(args.pathname)) return "continue";
  if (!args.loaded) return "wait";

  if (args.pathname === ROUTES.auth.setup.path) {
    // The same goal-driven checklist is also the explicit resume/reconfigure
    // destination after a user dismisses or completes first-run setup.
    return "continue";
  }

  return args.outcome === "open" ? "redirect-to-setup" : "continue";
}
