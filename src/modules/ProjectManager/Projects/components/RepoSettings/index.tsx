/**
 * RepoSettings Component
 *
 * Repo-level settings with split layout: sidebar sections + content.
 * Mirrors the WorkItemsSettings pattern (SplitViewLayout + ListPanel tokens).
 *
 * Sections:
 * - Members: manage repo-wide active/inactive team members
 * - Labels: add/edit/remove repo-wide labels
 */
import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import type { MemberEntry } from "@src/api/http/project";
import {
  getListIconClasses,
  getListItemClasses,
} from "@src/components/ListPanel/tokens";
import {
  HugeiconsIcon,
  type IconSvgElement,
  TagsIcon,
  UserIcon,
  UserMultipleIcon,
} from "@src/icons";
import SplitViewLayout from "@src/modules/shared/layouts/SplitViewLayout";
import { SUBPAGE_CONTENT_WRAPPER_CLASSES } from "@src/modules/shared/layouts/SubpageLayout/tokens";
import type { Label } from "@src/types/core/shared";

import {
  LabelsSection,
  MyProfileSection,
} from "../../../WorkItems/components/WorkItemsSettings/subpages";
import { RepoMembersSection } from "./sections";

// ============================================
// Types
// ============================================

interface RepoSettingsProps {
  repoPath: string | null;
  members: MemberEntry[];
  onUpdateMembers: (members: MemberEntry[]) => Promise<void>;
  onSyncMembers?: () => Promise<void>;
  labels: Label[];
  onUpdateLabels: (labels: Label[]) => Promise<void>;
  /** If provided, auto-selects this sidebar section on mount */
  initialSection?: "profile" | "members" | "labels";
}

// ============================================
// Section Config
// ============================================

const SETTINGS_SECTION_IDS = {
  PROFILE: "profile",
  MEMBERS: "members",
  LABELS: "labels",
} as const;

type SettingsSectionId =
  (typeof SETTINGS_SECTION_IDS)[keyof typeof SETTINGS_SECTION_IDS];

interface SettingsSectionConfig {
  id: SettingsSectionId;
  labelKey: string;
  icon: IconSvgElement;
  render: (props: RepoSettingsProps) => React.ReactNode;
}

const SECTIONS: SettingsSectionConfig[] = [
  {
    id: SETTINGS_SECTION_IDS.PROFILE,
    labelKey: "settings.sidebarMyProfile",
    icon: UserIcon,
    render: (props) => (
      <MyProfileSection
        members={props.members}
        onUpdateMembers={props.onUpdateMembers}
      />
    ),
  },
  {
    id: SETTINGS_SECTION_IDS.MEMBERS,
    labelKey: "settings.sidebarMembers",
    icon: UserMultipleIcon,
    render: (props) => (
      <RepoMembersSection
        members={props.members}
        onUpdateMembers={props.onUpdateMembers}
        onSyncMembers={props.onSyncMembers}
      />
    ),
  },
  {
    id: SETTINGS_SECTION_IDS.LABELS,
    labelKey: "settings.sidebarLabels",
    icon: TagsIcon,
    render: (props) => (
      <LabelsSection
        labels={props.labels}
        onUpdateLabels={props.onUpdateLabels}
      />
    ),
  },
];

// ============================================
// Sidebar
// ============================================

const SettingsSidebar: React.FC<{
  activeSection: SettingsSectionId;
  onSectionClick: (sectionId: SettingsSectionId) => void;
}> = ({ activeSection, onSectionClick }) => {
  const { t } = useTranslation("projects");

  return (
    <div className="scrollbar-hide min-h-0 flex-1 overflow-y-auto px-2 py-2">
      <div className="flex flex-col gap-0.5 pb-2">
        {SECTIONS.map((section) => {
          const isActive = activeSection === section.id;
          return (
            <button
              key={section.id}
              className={`w-full text-left ${getListItemClasses(isActive, "wideGap")}`}
              onClick={() => onSectionClick(section.id)}
            >
              <HugeiconsIcon
                icon={section.icon}
                size={16}
                strokeWidth={1.75}
                className={getListIconClasses(isActive)}
              />
              <span>{t(section.labelKey)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

// ============================================
// Main Component
// ============================================

const RepoSettings: React.FC<RepoSettingsProps> = ({
  repoPath,
  members,
  onUpdateMembers,
  onSyncMembers,
  labels,
  onUpdateLabels,
  initialSection,
}) => {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(
    (initialSection as SettingsSectionId) ?? SETTINGS_SECTION_IDS.PROFILE
  );

  const activeSectionConfig = SECTIONS.find(
    (section) => section.id === activeSection
  );
  const content = activeSectionConfig?.render({
    repoPath,
    members,
    onUpdateMembers,
    onSyncMembers,
    labels,
    onUpdateLabels,
    initialSection,
  });

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <SplitViewLayout
        className="min-h-0 flex-1 overflow-hidden"
        hideBreadcrumbWhenSidebarCollapsed={true}
        mainContentClassName=""
        listPanelBackgroundClassName=""
        listWidth={180}
        minListWidth={140}
        maxListWidth={240}
        listContent={
          <SettingsSidebar
            activeSection={activeSection}
            onSectionClick={setActiveSection}
          />
        }
        mainContent={
          <div className="scrollbar-hide h-full min-h-0 overflow-y-auto px-4">
            <div className={SUBPAGE_CONTENT_WRAPPER_CLASSES}>{content}</div>
          </div>
        }
      />
    </div>
  );
};

export default RepoSettings;
