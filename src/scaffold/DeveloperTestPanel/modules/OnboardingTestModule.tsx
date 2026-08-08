import { useAtom, useAtomValue } from "jotai";
import React, { type FC } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { org2CloudOrgsAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import {
  SETUP_GUIDE_DEV_SCENARIO,
  type SetupGuideDevScenario,
  isSetupGuideRoleScenario,
  setupGuideDevScenarioAtom,
} from "@src/store/ui/setupGuideDevScenarioAtom";

const SCENARIOS: readonly {
  value: SetupGuideDevScenario;
  labelKey: string;
}[] = [
  {
    value: SETUP_GUIDE_DEV_SCENARIO.LIVE,
    labelKey: "sidebar.guide.devScenarioLive",
  },
  {
    value: SETUP_GUIDE_DEV_SCENARIO.NO_ORGANIZATION,
    labelKey: "sidebar.guide.devScenarioNoOrganization",
  },
  {
    value: SETUP_GUIDE_DEV_SCENARIO.MEMBER,
    labelKey: "sidebar.guide.devScenarioMember",
  },
  {
    value: SETUP_GUIDE_DEV_SCENARIO.ADMIN,
    labelKey: "sidebar.guide.devScenarioAdmin",
  },
  {
    value: SETUP_GUIDE_DEV_SCENARIO.OWNER,
    labelKey: "sidebar.guide.devScenarioOwner",
  },
];

const OnboardingTestModule: FC = () => {
  const { t } = useTranslation("navigation");
  const [scenario, setScenario] = useAtom(setupGuideDevScenarioAtom);
  const cloudOrganizations = useAtomValue(org2CloudOrgsAtom);
  const roleScenariosAvailable = cloudOrganizations.length > 0;

  return (
    <div
      className="px-3 pb-3"
      role="group"
      aria-label={t("sidebar.guide.devPanelTitle")}
      data-testid="developer-test-onboarding-module"
    >
      <p className="mb-2 text-xs leading-5 text-text-3">
        {t("sidebar.guide.devPanelHint")}
      </p>
      <div className="flex flex-col gap-1.5">
        {SCENARIOS.map((option) => {
          const selected = scenario === option.value;
          const disabled =
            isSetupGuideRoleScenario(option.value) && !roleScenariosAvailable;
          return (
            <Button
              key={option.value}
              size="small"
              long
              variant={selected ? "primary" : "secondary"}
              appearance={selected ? "solid" : "outline"}
              disabled={disabled}
              aria-pressed={selected}
              data-testid={`developer-test-onboarding-${option.value}`}
              onClick={() => setScenario(option.value)}
            >
              {t(option.labelKey)}
            </Button>
          );
        })}
      </div>
      {!roleScenariosAvailable ? (
        <p className="mt-2 text-xs leading-5 text-warning-6">
          {t("sidebar.guide.devScenarioRequiresOrganization")}
        </p>
      ) : null}
    </div>
  );
};

export default OnboardingTestModule;
