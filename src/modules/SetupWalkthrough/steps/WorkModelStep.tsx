import { Boxes, FolderGit2, ListChecks, MessageSquare } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import InlineAlert from "@src/components/InlineAlert";
import { TYPOGRAPHY } from "@src/config/workstation/tokens";
import {
  SectionContainer,
  SectionDescription,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { WizardStepContent } from "@src/scaffold/WizardSystem/primitives";

import { WorkModelStepIcon } from "../components/SetupStepIcons";
import type { StepProps } from "./types";

const MODEL_ITEMS = [
  { key: "project", icon: Boxes },
  { key: "workItem", icon: ListChecks },
  { key: "session", icon: MessageSquare },
  { key: "workspace", icon: FolderGit2 },
] as const;

export const WorkModelStep: React.FC<StepProps> = () => {
  const { t } = useTranslation("onboarding");
  return (
    <WizardStepContent
      title={t("readiness.model.title")}
      description={t("readiness.model.description")}
      icon={WorkModelStepIcon}
    >
      <SectionContainer>
        {MODEL_ITEMS.map(({ key, icon: Icon }) => (
          <SectionRow key={key} showHeader={false}>
            <div className="flex w-full min-w-0 items-start gap-3">
              <span className="flex size-7 flex-shrink-0 items-center justify-center rounded-lg bg-fill-2 text-text-2">
                <Icon size={15} />
              </span>
              <div className="min-w-0">
                <div className={`${TYPOGRAPHY.contentTitle} text-text-1`}>
                  {t(`readiness.model.${key}.title`)}
                </div>
                <SectionDescription>
                  {t(`readiness.model.${key}.description`)}
                </SectionDescription>
              </div>
            </div>
          </SectionRow>
        ))}
      </SectionContainer>
      <InlineAlert
        type="info"
        icon={<FolderGit2 size={14} className="flex-shrink-0" />}
      >
        {t("readiness.model.relationship")}
      </InlineAlert>
    </WizardStepContent>
  );
};
