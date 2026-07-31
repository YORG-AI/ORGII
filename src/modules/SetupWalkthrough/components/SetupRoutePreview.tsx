import React from "react";
import { useTranslation } from "react-i18next";

import type { SetupWalkthroughProgress } from "@src/config/settingsSchema/setupWalkthroughProgress";

import type { SetupStepId } from "../flow";

const STEP_I18N_KEYS: Record<SetupStepId, string> = {
  goal: "goal",
  tools: "tools",
  organization: "organization",
  sharing: "sharing",
  basics: "basics",
  tutorial: "tutorial",
  "work-model": "workModel",
  ready: "ready",
};

const GOAL_TITLE_KEYS: Record<
  NonNullable<SetupWalkthroughProgress["goal"]>,
  string
> = {
  personal: "readiness.goal.personal.title",
  team_activity: "readiness.goal.team.title",
  work_management: "readiness.goal.work.title",
};

const GOAL_DESTINATION_KEYS: Record<
  NonNullable<SetupWalkthroughProgress["goal"]>,
  string
> = {
  personal: "readiness.ready.personalDestination",
  team_activity: "readiness.ready.teamDestination",
  work_management: "readiness.ready.workDestination",
};

interface SetupRoutePreviewProps {
  goal: SetupWalkthroughProgress["goal"];
  stepIds: SetupStepId[];
}

/**
 * Derived preview of the setup journey.
 *
 * The goal remains owned by setup progress. This component only visualizes the
 * canonical step list produced by flow.ts, so changing the presentation cannot
 * create a second routing policy.
 */
const SetupRoutePreview: React.FC<SetupRoutePreviewProps> = ({
  goal,
  stepIds,
}) => {
  const { t } = useTranslation("onboarding");
  const routeSteps = stepIds.filter((stepId) => stepId !== "goal");
  const title = goal ? t(GOAL_TITLE_KEYS[goal]) : t("steps.goal.description");
  const destination = goal
    ? t(GOAL_DESTINATION_KEYS[goal])
    : t("readiness.goal.hint");

  return (
    <aside
      className="walkthrough-route-preview"
      aria-label={t("readiness.sidebar.ariaLabel")}
      aria-live="polite"
      data-route-goal={goal ?? "unselected"}
      data-testid="setup-goal-route"
    >
      <div className="walkthrough-route-header">
        <span className="walkthrough-route-eyebrow">
          {t("readiness.sidebar.ariaLabel")}
        </span>
        <h2>{title}</h2>
      </div>

      <ol className="walkthrough-route-track">
        {routeSteps.map((stepId, index) => {
          const i18nKey = STEP_I18N_KEYS[stepId];
          return (
            <li key={stepId} data-route-step={stepId}>
              <span className="walkthrough-route-index" aria-hidden>
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="walkthrough-route-copy">
                <strong>{t(`steps.${i18nKey}.title`)}</strong>
                <span>{t(`steps.${i18nKey}.description`)}</span>
              </span>
            </li>
          );
        })}
      </ol>

      <div
        className="walkthrough-route-destination"
        data-route-destination={goal ?? "unselected"}
      >
        <span>{goal ? t("readiness.ready.openDestination") : destination}</span>
        {goal && <strong>{destination}</strong>}
      </div>
    </aside>
  );
};

export default SetupRoutePreview;
