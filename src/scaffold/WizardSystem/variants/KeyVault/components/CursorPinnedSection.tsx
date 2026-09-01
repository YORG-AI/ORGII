import React from "react";
import { useTranslation } from "react-i18next";

import Input from "@src/components/Input";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { DETAIL_PANEL_TOKENS } from "@src/modules/shared/layouts/blocks";

import type { WizardData } from "../types";

interface CursorPinnedSectionProps {
  data: WizardData;
  onChange: (updates: Partial<WizardData>) => void;
}

const CursorPinnedSection: React.FC<CursorPinnedSectionProps> = ({
  data,
  onChange,
}) => {
  const { t } = useTranslation("integrations");

  return (
    <div className="relative z-10 scrollbar-hide min-h-0 overflow-y-auto border-t border-solid border-border-2 px-4 pt-2">
      <div className={DETAIL_PANEL_TOKENS.contentWidth}>
        <SectionContainer>
          <SectionRow
            label={t("keyVault.apiKeyLabel")}
            description={t("keyVault.cursorApiKeyBrowserHint")}
          >
            <Input
              value={data.raw_key_input}
              onChange={(value) =>
                onChange({ raw_key_input: value, extracted_api_key: undefined })
              }
              placeholder={t("keyVault.cursorKeyFormatPlaceholder")}
              size="default"
              type="password"
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
        </SectionContainer>
      </div>
    </div>
  );
};

export default CursorPinnedSection;
