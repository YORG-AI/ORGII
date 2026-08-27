/**
 * WorkItemsSettings Component
 *
 * Project-level settings with split layout: sidebar sections + content.
 * Mirrors the app Settings route pattern (SplitViewLayout + ListPanel tokens).
 *
 * Sections:
 * - Members: toggle active/inactive team members
 * - Labels: add/edit/remove work item labels
 * (more sections can be added here)
 */
import {
  Cable,
  type LucideIcon,
  Settings,
  Tags,
  User,
  Users,
} from "lucide-react";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import type { MemberEntry } from "@src/api/http/project";
import {
  getListIconClasses,
  getListItemClasses,
} from "@src/components/ListPanel/tokens";
import SplitViewLayout from "@src/modules/shared/layouts/SplitViewLayout";
import { SUBPAGE_CONTENT_WRAPPER_CLASSES } from "@src/modules/shared/layouts/SubpageLayout/tokens";
import type { Label, Person } from "@src/types/core/shared";

import {
  GeneralSection,
  LabelsSection,
  MembersSection,
  MyProfileSection,
  SyncSection,
} from "./subpages";

// ============================================
// Section IDs
// ============================================

const SETTINGS_SECTION_IDS = {
  GENERAL: "general",
  PROFILE: "profile",
  MEMBERS: "members",
  LABELS: "labels",
  SYNC: "sync",
} as const;

export type SettingsSectionId =
  (typeof SETTINGS_SECTION_IDS)[keyof typeof SETTINGS_SECTION_IDS];

// ============================================
// Types
// ============================================

export interface WorkItemsSettingsProps {
  members: MemberEntry[];
  onUpdateMembers: (members: MemberEntry[]) => Promise<void>;
  labels: Label[];
  onUpdateLabels: (labels: Label[]) => Promise<void>;
  /** Project slug — used by the sync section for projectSyncApi calls */
  slug: string;
  /** Project name (used for delete confirmation) */
  projectName: string;
  /** 3-char prefix used for work item IDs */
  workItemPrefix: string;
  /** True when prefix is manually configured */
  workItemPrefixCustom: boolean;
  /** Update workItem prefix and custom-mode flag */
  onUpdateWorkItemPrefix: (prefix: string, custom: boolean) => void;
  /** Callback to delete the current project */
  onDeleteProject?: () => Promise<void>;
  /** Project-level member assignments */
  projectMembers: Person[];
  /** Update project member assignments */
  onUpdateProjectMembers: (members: Person[]) => void;
  /** Navigate to repo-level settings for full member management */
  onOpenRepoSettings?: () => void;
  /**
   * Deep-link request to apply. The monotonic stamp lets repeat requests for
   * the same section remain distinct without resetting ordinary navigation.
   */
  sectionRequest?: { section: SettingsSectionId; stamp: number };
}

interface SettingsSectionState {
  activeSection: SettingsSectionId;
  appliedRequestStamp: number | null;
}

export function advanceSettingsSectionState(
  previous: SettingsSectionState,
  request: WorkItemsSettingsProps["sectionRequest"]
): SettingsSectionState {
  if (!request || request.stamp === previous.appliedRequestStamp) {
    return previous;
  }
  return {
    activeSection: request.section,
    appliedRequestStamp: request.stamp,
  };
}

// ============================================
// Section Config
// ============================================

interface SettingsSectionConfig {
  id: SettingsSectionId;
  labelKey: string;
  icon: LucideIcon;
  render: (props: WorkItemsSettingsProps) => React.ReactNode;
}

const SECTIONS: SettingsSectionConfig[] = [
  {
    id: SETTINGS_SECTION_IDS.GENERAL,
    labelKey: "settings.sidebarGeneral",
    icon: Settings,
    render: (props) => (
      <GeneralSection
        projectName={props.projectName}
        workItemPrefix={props.workItemPrefix}
        workItemPrefixCustom={props.workItemPrefixCustom}
        onUpdateWorkItemPrefix={props.onUpdateWorkItemPrefix}
        onDeleteProject={props.onDeleteProject}
      />
    ),
  },
  {
    id: SETTINGS_SECTION_IDS.PROFILE,
    labelKey: "settings.sidebarMyProfile",
    icon: User,
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
    icon: Users,
    render: (props) => (
      <MembersSection
        members={props.members}
        projectMembers={props.projectMembers}
        onUpdateProjectMembers={props.onUpdateProjectMembers}
        onOpenRepoSettings={props.onOpenRepoSettings}
      />
    ),
  },
  {
    id: SETTINGS_SECTION_IDS.LABELS,
    labelKey: "settings.sidebarLabels",
    icon: Tags,
    render: (props) => (
      <LabelsSection
        labels={props.labels}
        onUpdateLabels={props.onUpdateLabels}
      />
    ),
  },
  {
    id: SETTINGS_SECTION_IDS.SYNC,
    labelKey: "settings.sidebarSync",
    icon: Cable,
    render: (props) => <SyncSection slug={props.slug} />,
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
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 scrollbar-hide">
      <div className="flex flex-col gap-0.5 pb-2">
        {SECTIONS.map((section) => {
          const isActive = activeSection === section.id;
          const Icon = section.icon;
          return (
            <button
              key={section.id}
              className={`w-full text-left ${getListItemClasses(isActive, "wideGap")}`}
              onClick={() => onSectionClick(section.id)}
            >
              <Icon
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

const WorkItemsSettings: React.FC<WorkItemsSettingsProps> = ({
  members,
  onUpdateMembers,
  labels,
  onUpdateLabels,
  slug,
  projectName,
  workItemPrefix,
  workItemPrefixCustom,
  onUpdateWorkItemPrefix,
  onDeleteProject,
  projectMembers,
  onUpdateProjectMembers,
  onOpenRepoSettings,
  sectionRequest,
}) => {
  const [sectionState, setSectionState] = useState<SettingsSectionState>(
    () => ({
      activeSection: sectionRequest?.section ?? SETTINGS_SECTION_IDS.GENERAL,
      appliedRequestStamp: sectionRequest?.stamp ?? null,
    })
  );
  const nextSectionState = advanceSettingsSectionState(
    sectionState,
    sectionRequest
  );
  if (nextSectionState !== sectionState) {
    setSectionState(nextSectionState);
  }
  const activeSection = nextSectionState.activeSection;
  const handleSectionClick = (section: SettingsSectionId) => {
    setSectionState((current) => ({ ...current, activeSection: section }));
  };

  const activeSectionConfig = SECTIONS.find(
    (section) => section.id === activeSection
  );
  const content = activeSectionConfig?.render({
    members,
    onUpdateMembers,
    labels,
    onUpdateLabels,
    slug,
    projectName,
    workItemPrefix,
    workItemPrefixCustom,
    onUpdateWorkItemPrefix,
    onDeleteProject,
    projectMembers,
    onUpdateProjectMembers,
    onOpenRepoSettings,
  });

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <SplitViewLayout
        className="min-h-0 flex-1 overflow-hidden"
        resizable={true}
        collapsible={true}
        hideBreadcrumbWhenSidebarCollapsed={true}
        mainContentClassName=""
        listPanelBackgroundClassName=""
        listWidth={180}
        minListWidth={140}
        maxListWidth={240}
        listContent={
          <SettingsSidebar
            activeSection={activeSection}
            onSectionClick={handleSectionClick}
          />
        }
        mainContent={
          <div className="h-full min-h-0 overflow-y-auto px-4 scrollbar-hide">
            <div className={SUBPAGE_CONTENT_WRAPPER_CLASSES}>{content}</div>
          </div>
        }
      />
    </div>
  );
};

export default WorkItemsSettings;
