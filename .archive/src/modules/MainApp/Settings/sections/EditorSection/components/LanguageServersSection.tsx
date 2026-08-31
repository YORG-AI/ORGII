/**
 * Language Servers & Lint Tools Section
 *
 * Entry points to the Language Servers and Lint Tools pages in Integrations.
 */
import Button from "@/src/components/Button";
import {
  SectionContainer,
  SectionRow,
} from "@/src/modules/shared/layouts/SectionLayout";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { useAppNavigation } from "@src/hooks/navigation/useAppNavigation";
import { NAV_BUTTON_PROPS } from "@src/modules/MainApp/Settings/config";

const LanguageServersSection: React.FC = memo(() => {
  const { t } = useTranslation("settings");
  const { goToIntegrations } = useAppNavigation();

  const goToLsp = useCallback(
    () =>
      goToIntegrations({
        category: "devtools",
        devToolsTab: "lsp",
      }),
    [goToIntegrations]
  );

  const goToLint = useCallback(
    () => goToIntegrations({ category: "devtools", devToolsTab: "lint-tools" }),
    [goToIntegrations]
  );

  return (
    <SectionContainer title={t("dependencies.lintLsp")}>
      <SectionRow
        label={t("common:terminology.languageServers")}
        description={t("languageServers.languageServersDesc")}
      >
        <Button {...NAV_BUTTON_PROPS} onClick={goToLsp}>
          {t("common:actions.configure")}
        </Button>
      </SectionRow>
      <SectionRow
        label={t("languageServersPage.lintToolsTitle")}
        description={t("languageServers.lintToolsDesc")}
      >
        <Button {...NAV_BUTTON_PROPS} onClick={goToLint}>
          {t("common:actions.configure")}
        </Button>
      </SectionRow>
    </SectionContainer>
  );
});

LanguageServersSection.displayName = "LanguageServersSection";

export default LanguageServersSection;
