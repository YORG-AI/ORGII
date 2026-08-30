/**
 * MembersSection — Project-level member overview.
 *
 * Shows the list of repo members and lets the user toggle which ones
 * belong to this project. For full member management (mark inactive,
 * rename, sync from git), the user clicks "Manage in Repo Settings"
 * to navigate to the repo-level Settings tab from Projects.
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { MemberEntry } from "@src/api/http/project";
import Button from "@src/components/Button";
import PersonAvatar from "@src/components/PersonAvatar";
import Switch from "@src/components/Switch";
import { HugeiconsIcon, SquareArrowUpRight02Icon } from "@src/icons";
import {
  SECTION_DESCRIPTION_CLASSES,
  SectionContainer,
  SectionHeading,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { CARD_ROW_TOKENS } from "@src/modules/shared/layouts/blocks";
import type { Person } from "@src/types/core/shared";

export interface MembersSectionProps {
  members: MemberEntry[];
  /** Project-level member assignments (from ProjectMeta.members) */
  projectMembers: Person[];
  /** Update project member list */
  onUpdateProjectMembers: (members: Person[]) => void;
  /** Navigate to repo-level settings for full member management */
  onOpenRepoSettings?: () => void;
}

const MembersSection: React.FC<MembersSectionProps> = ({
  members,
  projectMembers,
  onUpdateProjectMembers,
  onOpenRepoSettings,
}) => {
  const { t } = useTranslation("projects");

  const deduplicatedActiveMembers = useMemo(() => {
    const memberMap = new Map<string, MemberEntry>();
    for (const member of members) {
      const existing = memberMap.get(member.id);
      if (
        !existing ||
        (member.last_commit_date ?? "") > (existing.last_commit_date ?? "")
      ) {
        memberMap.set(member.id, member);
      }
    }
    return Array.from(memberMap.values()).filter((m) => m.active);
  }, [members]);

  const projectMemberIds = useMemo(
    () => new Set(projectMembers.map((m) => m.id)),
    [projectMembers]
  );

  const handleToggleMember = (member: MemberEntry) => {
    const exists = projectMemberIds.has(member.id);
    let updated: Person[];
    if (exists) {
      updated = projectMembers.filter((m) => m.id !== member.id);
    } else {
      updated = [
        ...projectMembers,
        {
          id: member.id,
          name: member.name,
          email: member.email,
          avatar: member.avatar,
        },
      ];
    }
    onUpdateProjectMembers(updated);
  };

  return (
    <SectionHeading title={t("properties.members")}>
      <SectionContainer>
        <SectionRow
          label={`${t("settings.activeMembers")} (${projectMembers.length})`}
          description={t("settings.projectMemberListDescription")}
        >
          {onOpenRepoSettings && (
            <Button
              icon={
                <HugeiconsIcon
                  icon={SquareArrowUpRight02Icon}
                  data-icon="square-arrow-out-up-right"
                  size={14}
                />
              }
              iconPosition="right"
              onClick={onOpenRepoSettings}
            >
              {t("common:actions.manage")}
            </Button>
          )}
        </SectionRow>

        <SectionRow label="" indent showHeader={false}>
          {deduplicatedActiveMembers.length === 0 ? (
            <div className={CARD_ROW_TOKENS.emptyState}>
              {t("settings.noActiveMembers")}
            </div>
          ) : (
            deduplicatedActiveMembers.map((member) => {
              const isAssigned = projectMemberIds.has(member.id);
              return (
                <div key={member.id} className="flex items-center gap-2 py-2">
                  <span
                    className={`inline-flex flex-shrink-0 ${!isAssigned ? "opacity-40 grayscale" : ""}`}
                  >
                    <PersonAvatar
                      name={member.name}
                      src={member.avatar}
                      size={28}
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div
                      className={`text-[14px] font-semibold ${isAssigned ? "text-text-1" : "text-text-3"}`}
                    >
                      {member.name}
                    </div>
                    {member.email && (
                      <div className={SECTION_DESCRIPTION_CLASSES}>
                        {member.email}
                      </div>
                    )}
                  </div>
                  <Switch
                    checked={isAssigned}
                    onCheckedChange={() => handleToggleMember(member)}
                  />
                </div>
              );
            })
          )}
        </SectionRow>
      </SectionContainer>
    </SectionHeading>
  );
};

export default MembersSection;
