import { useAtom } from "jotai";
import React from "react";
import { useTranslation } from "react-i18next";

import Select, { type SelectOption } from "@src/components/Select";
import {
  APPLICATION_PREVIEW_STYLE,
  normalizeApplicationPreviewStyle,
} from "@src/config/appearance/applicationPreviewStyle";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import Modal from "@src/scaffold/ModalSystem";
import {
  applicationPreviewStyleAtom,
  globalPreferencesPanelOpenAtom,
} from "@src/store/ui/globalPreferencesPanelAtom";

interface GlobalPreferencesSectionDefinition {
  id: string;
  Component: React.ComponentType;
}

const PreviewStyleSection: React.FC = () => {
  const { t } = useTranslation("onboarding");
  const [previewStyle, setPreviewStyle] = useAtom(applicationPreviewStyleAtom);
  const label = t("readiness.presentation.label");
  const options: SelectOption[] = [
    {
      value: APPLICATION_PREVIEW_STYLE.COMPACT,
      label: t("readiness.presentation.compact"),
    },
    {
      value: APPLICATION_PREVIEW_STYLE.MASCOT,
      label: t("readiness.presentation.mascot"),
    },
  ];

  return (
    <SectionContainer dataTestId="global-preferences-preview-section">
      <SectionRow label={label}>
        <Select
          value={previewStyle}
          options={options}
          onChange={(value) =>
            setPreviewStyle(normalizeApplicationPreviewStyle(value))
          }
          style={SECTION_CONTROL_STYLE}
          ariaLabel={label}
          dataTestId="global-preview-style"
        />
      </SectionRow>
    </SectionContainer>
  );
};

/** Add a component here to extend the global panel without changing its shell. */
const GLOBAL_PREFERENCES_SECTIONS: GlobalPreferencesSectionDefinition[] = [
  { id: "preview-style", Component: PreviewStyleSection },
];

/** Window-global, route-independent home for lightweight user preferences. */
const GlobalPreferencesPanel: React.FC = () => {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useAtom(globalPreferencesPanelOpenAtom);

  return (
    <Modal
      visible={open}
      onCancel={() => setOpen(false)}
      title={t("general.preferences")}
      footer={null}
      width={480}
      bodyClassName="p-4"
      zIndex={10030}
    >
      <div className="flex flex-col gap-4" data-testid="global-preferences">
        {GLOBAL_PREFERENCES_SECTIONS.map(({ id, Component }) => (
          <Component key={id} />
        ))}
      </div>
    </Modal>
  );
};

export {
  closeGlobalPreferencesPanel,
  openGlobalPreferencesPanel,
  toggleGlobalPreferencesPanel,
} from "./openGlobalPreferencesPanel";
export default GlobalPreferencesPanel;
