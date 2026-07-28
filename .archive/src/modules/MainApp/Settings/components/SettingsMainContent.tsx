import TabPill from "@src/components/TabPill";
import type { TabPillItem } from "@src/components/TabPill/types";
import { ResponsiveContainer } from "@src/modules/shared/layouts/NarrowPlaceholder";
import {
  DETAIL_PANEL_TOKENS,
  InternalHeader,
  ScrollFadeContainer,
} from "@src/modules/shared/layouts/blocks";

import SettingsSectionRenderer from "../renderer/SettingsSectionRenderer";

interface SettingsMainContentProps {
  activeSection: string;
  activeSectionTab: string;
  tabs: TabPillItem[];
  onTabChange: (tab: string) => void;
}

export function SettingsMainContent({
  activeSection,
  activeSectionTab,
  tabs,
  onTabChange,
}: SettingsMainContentProps) {
  return (
    <ResponsiveContainer className="h-full">
      <div className="flex h-full flex-col overflow-hidden">
        <InternalHeader
          noPanelHeader
          contentPadding
          className={DETAIL_PANEL_TOKENS.headerWidth}
          tabs={
            <TabPill
              tabs={tabs}
              activeTab={activeSectionTab}
              onChange={onTabChange}
              variant="simple"
              fillWidth={false}
              size="large"
            />
          }
        />
        <ScrollFadeContainer
          className={`scroll-fade-at-top ${DETAIL_PANEL_TOKENS.scrollContentNoTop}`}
        >
          <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
            <SettingsSectionRenderer
              sectionId={activeSection}
              activeTab={activeSectionTab}
            />
          </div>
        </ScrollFadeContainer>
      </div>
    </ResponsiveContainer>
  );
}
