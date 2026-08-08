import { ListChecks, type LucideIcon } from "lucide-react";
import type { FC } from "react";

import OnboardingTestModule from "./modules/OnboardingTestModule";

export interface DeveloperTestModuleDefinition {
  id: string;
  titleKey: string;
  icon: LucideIcon;
  Component: FC;
  defaultExpanded?: boolean;
}

/**
 * Central registration point for development-only test surfaces.
 *
 * Modules own their runtime state and safety gates. Registering a module here
 * only gives it a discoverable section inside the shared test panel.
 */
export const DEVELOPER_TEST_MODULES: readonly DeveloperTestModuleDefinition[] =
  [
    {
      id: "onboarding",
      titleKey: "sidebar.guide.devPanelTitle",
      icon: ListChecks,
      Component: OnboardingTestModule,
      defaultExpanded: true,
    },
  ];
