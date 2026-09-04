/**
 * RepoMembersSection — Repo-wide member management.
 * Toggle members active/inactive. Inactive members are hidden from assignee dropdowns.
 *
 * This is the repo-level variant (no Project tab — that lives in WorkItemsSettings).
 */
import type { TFunction } from "i18next";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import type { LinkedEmail, MemberEntry } from "@src/api/http/project";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import PersonAvatar from "@src/components/PersonAvatar";
import { useCurrentUserMemberIds } from "@src/hooks/project/useCurrentUserMemberId";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  HugeiconsIcon,
  MinusSignIcon,
  Pen01Icon,
  Refresh04Icon,
  Tick01Icon,
  UserAdd01Icon,
} from "@src/icons";
import { ClaimIdentityModal } from "@src/modules/ProjectManager/shared/components";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_DESCRIPTION_CLASSES,
  SectionContainer,
  SectionHeading,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { CARD_ROW_TOKENS } from "@src/modules/shared/layouts/blocks";
import { formatLastCommitDate } from "@src/util/datetime/formatLastCommitDate";

export interface RepoMembersSectionProps {
  members: MemberEntry[];
  onUpdateMembers: (members: MemberEntry[]) => Promise<void>;
  onSyncMembers?: () => Promise<void>;
  showTitle?: boolean;
}

// ============================================
// Member Row
// ============================================

const MemberRowItem: React.FC<{
  member: MemberEntry;
  descriptionText: string | undefined;
  variant: "active" | "inactive";
  isCurrentUser: boolean;
  canClaim: boolean;
  onToggleActive: (memberId: string) => void;
  onRename: (memberId: string, newName: string) => void;
  onClaim?: (member: MemberEntry) => void;
  t: TFunction;
}> = ({
  member,
  descriptionText,
  variant,
  isCurrentUser,
  canClaim,
  onToggleActive,
  onRename,
  onClaim,
  t,
}) => {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const avatar = (
    <span
      className={`inline-flex shrink-0 ${variant === "inactive" ? "opacity-40 grayscale" : ""}`}
    >
      <PersonAvatar name={member.name} src={member.avatar} size={28} />
    </span>
  );

  const handleStartEdit = useCallback(() => {
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const handleSave = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed && trimmed !== member.name) {
        onRename(member.id, trimmed);
      }
      setEditing(false);
    },
    [member.id, member.name, onRename]
  );

  const handleCancel = useCallback(() => {
    setEditing(false);
  }, []);

  return (
    <div className="flex items-center gap-2 py-2">
      {avatar}

      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            ref={inputRef}
            defaultValue={member.name}
            className="w-full"
            onKeyDown={(e) => {
              if (e.key === "Enter")
                handleSave((e.target as HTMLInputElement).value);
              if (e.key === "Escape") handleCancel();
            }}
          />
        ) : (
          <>
            <div className="text-[14px] font-semibold text-text-1">
              {member.name}
            </div>
            {descriptionText && (
              <div className={SECTION_DESCRIPTION_CLASSES}>
                {descriptionText}
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {editing ? (
          <>
            <Button
              icon={
                <HugeiconsIcon icon={Tick01Icon} data-icon="check" size={14} />
              }
              iconOnly
              onClick={() => {
                if (inputRef.current) handleSave(inputRef.current.value);
              }}
            />
            <Button
              icon={
                <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={14} />
              }
              iconOnly
              onClick={handleCancel}
            />
          </>
        ) : (
          <>
            <Button
              icon={
                <HugeiconsIcon icon={Pen01Icon} data-icon="pencil" size={14} />
              }
              iconOnly
              onClick={handleStartEdit}
            />
            {!isCurrentUser && canClaim && onClaim && (
              <Button
                icon={
                  <HugeiconsIcon
                    icon={UserAdd01Icon}
                    data-icon="user-plus"
                    size={14}
                  />
                }
                iconOnly
                onClick={() => onClaim(member)}
                title={t("settings.claimAsMine")}
              />
            )}
            <Button
              icon={
                variant === "active" ? (
                  <HugeiconsIcon
                    icon={MinusSignIcon}
                    data-icon="minus"
                    size={14}
                  />
                ) : (
                  <HugeiconsIcon icon={Add01Icon} data-icon="plus" size={14} />
                )
              }
              iconOnly
              onClick={() => onToggleActive(member.id)}
            />
          </>
        )}
      </div>
    </div>
  );
};

// ============================================
// Main Component
// ============================================

const RepoMembersSection: React.FC<RepoMembersSectionProps> = ({
  members,
  onUpdateMembers,
  onSyncMembers,
  showTitle = true,
}) => {
  const { t } = useTranslation("projects");
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [inactiveExpanded, setInactiveExpanded] = useState(true);
  const [claimModalMember, setClaimModalMember] = useState<MemberEntry | null>(
    null
  );

  const { memberIds } = useCurrentUserMemberIds(members);

  // Get the current user's member entry
  const myMember = useMemo(() => {
    for (const member of members) {
      if (memberIds.has(member.id)) return member;
    }
    return null;
  }, [members, memberIds]);

  // Get all emails that are already claimed
  const claimedEmails = useMemo(() => {
    const emails = new Set<string>();
    for (const member of members) {
      if (member.linked_emails) {
        for (const linked of member.linked_emails) {
          emails.add(linked.email.toLowerCase());
        }
      }
    }
    return emails;
  }, [members]);

  const deduplicatedMembers = useMemo(() => {
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
    return Array.from(memberMap.values());
  }, [members]);

  const { activeMembers, inactiveMembers } = useMemo(() => {
    const sortByDate = (list: MemberEntry[]) =>
      [...list].sort((memberA, memberB) => {
        const dateA = memberA.last_commit_date ?? "";
        const dateB = memberB.last_commit_date ?? "";
        return dateB.localeCompare(dateA);
      });
    return {
      activeMembers: sortByDate(deduplicatedMembers.filter((m) => m.active)),
      inactiveMembers: sortByDate(deduplicatedMembers.filter((m) => !m.active)),
    };
  }, [deduplicatedMembers]);

  // Prefetch avatars: active first, then inactive (so active icons load before inactive)
  useEffect(() => {
    let cancelled = false;
    const preload = (url: string): Promise<void> =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve();
        img.onerror = () => resolve();
        img.src = url;
      });

    void (async () => {
      const activeUrls = activeMembers
        .map((m) => m.avatar)
        .filter((url): url is string => !!url);
      await Promise.all(activeUrls.map(preload));
      if (cancelled) return;

      const inactiveUrls = inactiveMembers
        .map((m) => m.avatar)
        .filter((url): url is string => !!url);
      await Promise.all(inactiveUrls.map(preload));
    })();

    return () => {
      cancelled = true;
    };
  }, [activeMembers, inactiveMembers]);

  const handleToggleActive = useCallback(
    (memberId: string) => {
      const updated = members.map((member) =>
        member.id === memberId ? { ...member, active: !member.active } : member
      );
      onUpdateMembers(updated);
    },
    [members, onUpdateMembers]
  );

  const handleRename = useCallback(
    (memberId: string, newName: string) => {
      const updated = members.map((member) =>
        member.id === memberId ? { ...member, name: newName } : member
      );
      onUpdateMembers(updated);
    },
    [members, onUpdateMembers]
  );

  // Handle claiming an identity
  const handleClaimIdentity = useCallback(() => {
    if (!myMember || !claimModalMember) return;

    const newLinkedEmail: LinkedEmail = {
      email: claimModalMember.email || "",
      last_commit_date: claimModalMember.last_commit_date,
    };

    const updated = members.map((member) => {
      if (memberIds.has(member.id)) {
        // Add to current user's linked_emails
        const existingLinked = member.linked_emails || [];
        return {
          ...member,
          linked_emails: [...existingLinked, newLinkedEmail],
        };
      }
      if (member.id === claimModalMember.id) {
        // Mark the claimed member as inactive
        return { ...member, active: false };
      }
      return member;
    });

    onUpdateMembers(updated);
    setClaimModalMember(null);
  }, [members, memberIds, myMember, claimModalMember, onUpdateMembers]);

  const handleSyncMembers = useCallback(() => {
    if (!onSyncMembers) return;
    setSyncing(true);
    onSyncMembers().finally(() => setSyncing(false));
  }, [onSyncMembers]);

  const { spinClass: syncSpinClass, handleClick: handleSyncClick } =
    useRefreshSpin(handleSyncMembers, syncing);

  const memberDescription = useCallback(
    (member: MemberEntry) => {
      const parts: string[] = [];
      if (member.email) parts.push(member.email);
      if (member.last_commit_date) {
        parts.push(formatLastCommitDate(member.last_commit_date, t));
      }
      return parts.length > 0 ? parts.join(" · ") : undefined;
    },
    [t]
  );

  const sectionBody = (
    <>
      <SectionContainer>
        {/* Active members */}
        <SectionRow
          label={`${t("settings.activeMembers")} (${activeMembers.length})`}
          description={t("settings.activeMembersDescription")}
        >
          <div className={SECTION_ACTION_GAP_CLASSES}>
            {onSyncMembers && (
              <Button
                icon={
                  <HugeiconsIcon
                    icon={Refresh04Icon}
                    data-icon="refresh-cw"
                    size={14}
                    className={syncSpinClass}
                  />
                }
                iconOnly
                disabled={syncing}
                onClick={handleSyncClick}
              />
            )}
            <Button
              onClick={() => setExpanded(!expanded)}
              icon={
                expanded ? (
                  <HugeiconsIcon
                    icon={ArrowDown01Icon}
                    data-icon="chevron-down"
                    size={14}
                  />
                ) : (
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    data-icon="chevron-right"
                    size={14}
                  />
                )
              }
              iconOnly
            />
          </div>
        </SectionRow>

        {expanded && (
          <SectionRow label="" indent showHeader={false}>
            {activeMembers.length > 0 ? (
              activeMembers.map((member) => (
                <MemberRowItem
                  key={member.id}
                  member={member}
                  descriptionText={memberDescription(member)}
                  variant="active"
                  isCurrentUser={memberIds.has(member.id)}
                  canClaim={
                    !memberIds.has(member.id) &&
                    !!member.email &&
                    !claimedEmails.has(member.email.toLowerCase())
                  }
                  onToggleActive={handleToggleActive}
                  onRename={handleRename}
                  onClaim={setClaimModalMember}
                  t={t}
                />
              ))
            ) : (
              <div className={CARD_ROW_TOKENS.emptyState}>
                {t("settings.noActiveMembers")}
              </div>
            )}
          </SectionRow>
        )}

        {/* Inactive members */}
        {inactiveMembers.length > 0 && (
          <>
            <SectionRow
              label={`${t("settings.inactiveMembers")} (${inactiveMembers.length})`}
              description={t("settings.inactiveMembersDescription")}
            >
              <Button
                onClick={() => setInactiveExpanded(!inactiveExpanded)}
                icon={
                  inactiveExpanded ? (
                    <HugeiconsIcon
                      icon={ArrowDown01Icon}
                      data-icon="chevron-down"
                      size={14}
                    />
                  ) : (
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      data-icon="chevron-right"
                      size={14}
                    />
                  )
                }
                iconOnly
              />
            </SectionRow>
            {inactiveExpanded && (
              <SectionRow label="" indent showHeader={false}>
                {inactiveMembers.map((member) => (
                  <MemberRowItem
                    key={member.id}
                    member={member}
                    descriptionText={memberDescription(member)}
                    variant="inactive"
                    isCurrentUser={memberIds.has(member.id)}
                    canClaim={
                      !memberIds.has(member.id) &&
                      !!member.email &&
                      !claimedEmails.has(member.email.toLowerCase())
                    }
                    onToggleActive={handleToggleActive}
                    onRename={handleRename}
                    onClaim={setClaimModalMember}
                    t={t}
                  />
                ))}
              </SectionRow>
            )}
          </>
        )}
      </SectionContainer>

      {/* Claim Identity Modal */}
      <ClaimIdentityModal
        visible={!!claimModalMember}
        member={claimModalMember}
        onClose={() => setClaimModalMember(null)}
        onConfirm={handleClaimIdentity}
        t={t}
      />
    </>
  );

  if (!showTitle) return sectionBody;

  return (
    <SectionHeading title={t("properties.members")}>
      {sectionBody}
    </SectionHeading>
  );
};

export default RepoMembersSection;
