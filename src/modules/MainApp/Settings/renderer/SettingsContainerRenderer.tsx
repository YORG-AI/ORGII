import {
  SectionContainer,
  SectionRow,
} from "@/src/modules/shared/layouts/SectionLayout";
import React from "react";
import { useTranslation } from "react-i18next";

import type { SettingsContainerDefinition } from "@src/config/settingsUiManifest/types";
import { createLogger } from "@src/hooks/logger";
import { useAllSettings } from "@src/store/settings";

import SettingsFieldRenderer from "./SettingsFieldRenderer";
import { settingsRowSlotRegistry } from "./slotRegistry";

const log = createLogger("SettingsRenderer");

interface SettingsContainerRendererProps {
  sectionId: string;
  container: SettingsContainerDefinition;
}

const SettingsContainerRenderer: React.FC<SettingsContainerRendererProps> = ({
  sectionId,
  container,
}) => {
  const { t } = useTranslation("settings");
  const settings = useAllSettings();

  const renderRows = () => (
    <>
      {container.rows.map((row) => {
        const visible = row.visibleWhen
          ? settings[row.visibleWhen.key] === row.visibleWhen.equals
          : true;
        if (!visible) {
          return null;
        }

        if (row.kind === "custom") {
          const SlotComponent = settingsRowSlotRegistry[row.customSlotId];
          if (!SlotComponent) {
            log.error(
              "[SettingsRenderer] Missing row slot for id:",
              row.customSlotId
            );
            return null;
          }

          if (row.raw) {
            return (
              <SlotComponent
                key={row.id}
                sectionId={sectionId}
                rowId={row.id}
              />
            );
          }

          return (
            <SectionRow
              key={row.id}
              label={t(row.labelKey)}
              description={
                row.descriptionKey ? t(row.descriptionKey) : undefined
              }
              indent={row.indent}
              light={row.light}
            >
              <SlotComponent sectionId={sectionId} rowId={row.id} />
            </SectionRow>
          );
        }

        return (
          <SectionRow
            key={row.id}
            settingsSearchKeys={row.key}
            label={t(row.labelKey)}
            description={row.descriptionKey ? t(row.descriptionKey) : undefined}
            indent={row.indent}
            light={row.light}
          >
            <SettingsFieldRenderer row={row} />
          </SectionRow>
        );
      })}
    </>
  );

  if (container.raw) {
    return renderRows();
  }

  return (
    <SectionContainer
      title={container.titleKey ? t(container.titleKey) : undefined}
    >
      {renderRows()}
    </SectionContainer>
  );
};

export default SettingsContainerRenderer;
