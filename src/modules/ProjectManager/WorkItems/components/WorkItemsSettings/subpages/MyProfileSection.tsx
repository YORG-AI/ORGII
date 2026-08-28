/**
 * MyProfileSection — Shows the current user's member profile.
 *
 * Resolves the current git user against members.yaml and displays:
 * - Avatar, display name (editable), email
 * - Activity status (active within 7 days or last commit date)
 * - GitHub username (editable)
 *
 * Shared between RepoSettings and WorkItemsSettings (project-level).
 * Layout matches MembersSection / RepoMembersSection for consistency.
 */
import type { TFunction } from "i18next";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LinkedEmail, MemberEntry } from "@src/api/http/project";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import { createLogger } from "@src/hooks/logger";
import { useCurrentUserMemberIds } from "@src/hooks/project/useCurrentUserMemberId";
import {
  Cancel01Icon,
  Copy01Icon,
  HugeiconsIcon,
  MinusSignIcon,
  Pen01Icon,
  Tick01Icon,
} from "@src/icons";
import { ClaimIdentityModal } from "@src/modules/ProjectManager/shared/components";
import {
  SECTION_DESCRIPTION_CLASSES,
  SectionContainer,
  SectionHeading,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { CARD_ROW_TOKENS } from "@src/modules/shared/layouts/blocks";
import { copyText } from "@src/util/data/clipboard";
import { formatLastCommitDate } from "@src/util/datetime/formatLastCommitDate";

const logger = createLogger("MyProfileSection");

export interface MyProfileSectionProps {
  members: MemberEntry[];
  onUpdateMembers: (members: MemberEntry[]) => Promise<void>;
}

// ============================================
// Linked Email Row
// ============================================

const LinkedEmailRow: React.FC<{
  email: string;
  lastCommitDate?: string;
  isPrimary?: boolean;
  onUnlink?: () => void;
  t: TFunction;
}> = ({ email, lastCommitDate, isPrimary, onUnlink, t }) => {
  const parts: string[] = [];
  if (lastCommitDate) {
    parts.push(formatLastCommitDate(lastCommitDate, t));
  }

  return (
    <div className="flex items-center gap-2 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[14px] text-text-1">{email}</span>
          {isPrimary && (
            <span className="rounded bg-fill-2 px-1.5 py-0.5 text-[11px] text-text-3">
              {t("settings.primary")}
            </span>
          )}
        </div>
        {parts.length > 0 && (
          <div className={SECTION_DESCRIPTION_CLASSES}>{parts.join(" · ")}</div>
        )}
      </div>
      {!isPrimary && onUnlink && (
        <Button
          icon={
            <HugeiconsIcon icon={MinusSignIcon} data-icon="minus" size={14} />
          }
          iconOnly
          onClick={onUnlink}
          title={t("settings.unlinkIdentity")}
        />
      )}
    </div>
  );
};

// ============================================
// Suggested Match Row
// ============================================

const SuggestedMatchRow: React.FC<{
  member: MemberEntry;
  reason: string;
  onClaim: () => void;
  t: TFunction;
}> = ({ member, reason, onClaim, t }) => {
  const parts: string[] = [];
  if (member.last_commit_date) {
    parts.push(formatLastCommitDate(member.last_commit_date, t));
  }

  return (
    <div className="flex items-center gap-2 py-2">
      {member.avatar ? (
        <img
          src={member.avatar}
          alt={member.name}
          className="h-7 w-7 flex-shrink-0 rounded-full opacity-60"
        />
      ) : (
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-fill-3 text-[11px] font-medium text-text-2 opacity-60">
          {member.name.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[14px] text-text-1">{member.email}</div>
        <div className={SECTION_DESCRIPTION_CLASSES}>
          {reason}: &ldquo;{member.name}&rdquo;
          {parts.length > 0 && ` · ${parts.join(" · ")}`}
        </div>
      </div>
      <Button size="small" onClick={onClaim}>
        {t("settings.claimAsMine")}
      </Button>
    </div>
  );
};

// ============================================
// Editable Field
// ============================================

const EditableField: React.FC<{
  label: string;
  value: string;
  onSave: (value: string) => void;
}> = ({ label: _label, value, onSave }) => {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleStartEdit = useCallback(() => {
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const handleSave = useCallback(
    (newValue: string) => {
      const trimmed = newValue.trim();
      if (trimmed && trimmed !== value) {
        onSave(trimmed);
      }
      setEditing(false);
    },
    [value, onSave]
  );

  const handleCancel = useCallback(() => {
    setEditing(false);
  }, []);

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            ref={inputRef}
            defaultValue={value}
            className="w-full"
            onKeyDown={(keyEvent) => {
              if (keyEvent.key === "Enter")
                handleSave((keyEvent.target as HTMLInputElement).value);
              if (keyEvent.key === "Escape") handleCancel();
            }}
          />
        ) : (
          <span className="text-[14px] text-text-1">{value || "—"}</span>
        )}
      </div>

      <div className="flex flex-shrink-0 items-center gap-2">
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
          <Button
            icon={
              <HugeiconsIcon icon={Pen01Icon} data-icon="pencil" size={14} />
            }
            iconOnly
            onClick={handleStartEdit}
          />
        )}
      </div>
    </div>
  );
};

// ============================================
// Main Component
// ============================================

const MyProfileSection: React.FC<MyProfileSectionProps> = ({
  members,
  onUpdateMembers,
}) => {
  const { t } = useTranslation("projects");
  const { memberIds, gitEmail } = useCurrentUserMemberIds(members);
  const [claimModalMember, setClaimModalMember] = useState<MemberEntry | null>(
    null
  );

  const myMember = useMemo(() => {
    for (const member of members) {
      if (memberIds.has(member.id)) return member;
    }
    return null;
  }, [members, memberIds]);

  // Find suggested matches: members with similar names but different IDs
  const suggestedMatches = useMemo(() => {
    if (!myMember) return [];
    const myName = myMember.name.toLowerCase().trim();

    // Get all emails that are already claimed by any member
    const claimedEmails = new Set<string>();
    for (const member of members) {
      if (member.linked_emails) {
        for (const linked of member.linked_emails) {
          claimedEmails.add(linked.email.toLowerCase());
        }
      }
    }

    return members.filter((member) => {
      // Skip if it's the current user's member
      if (memberIds.has(member.id)) return false;
      // Skip if already claimed by someone
      if (member.email && claimedEmails.has(member.email.toLowerCase()))
        return false;
      // Match by similar name
      const memberName = member.name.toLowerCase().trim();
      return memberName === myName || memberName.includes(myName);
    });
  }, [members, myMember, memberIds]);

  const handleUpdateField = useCallback(
    (field: keyof MemberEntry, value: string) => {
      if (!myMember) return;
      const updated = members.map((member) =>
        memberIds.has(member.id) ? { ...member, [field]: value } : member
      );
      onUpdateMembers(updated);
    },
    [members, memberIds, myMember, onUpdateMembers]
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

  // Handle unlinking an identity
  const handleUnlinkIdentity = useCallback(
    (emailToUnlink: string) => {
      if (!myMember) return;

      const updated = members.map((member) => {
        if (memberIds.has(member.id) && member.linked_emails) {
          return {
            ...member,
            linked_emails: member.linked_emails.filter(
              (linked) => linked.email !== emailToUnlink
            ),
          };
        }
        return member;
      });

      onUpdateMembers(updated);
    },
    [members, memberIds, myMember, onUpdateMembers]
  );

  if (!myMember) {
    return (
      <SectionHeading title={t("settings.myProfile")}>
        <SectionContainer>
          <SectionRow label="" indent showHeader={false}>
            <div className={CARD_ROW_TOKENS.emptyState}>
              {t("settings.profileNotFound")}
            </div>
            {gitEmail && (
              <div className={SECTION_DESCRIPTION_CLASSES}>
                {t("settings.profileNotFoundHint", { email: gitEmail })}
              </div>
            )}
          </SectionRow>
        </SectionContainer>
      </SectionHeading>
    );
  }

  const descriptionParts: string[] = [];
  if (myMember.email) descriptionParts.push(myMember.email);
  if (myMember.last_commit_date) {
    descriptionParts.push(formatLastCommitDate(myMember.last_commit_date, t));
  }
  const descriptionText =
    descriptionParts.length > 0 ? descriptionParts.join(" · ") : undefined;

  return (
    <SectionHeading title={t("settings.myProfile")}>
      <SectionContainer>
        <SectionRow
          label={t("settings.myProfile")}
          description={
            descriptionText
              ? `${t("settings.myProfileDescription")} ${descriptionText}`
              : t("settings.myProfileDescription")
          }
        >
          {null}
        </SectionRow>
        <SectionRow
          indent
          label={t("settings.displayName")}
          description={t("settings.displayNameDesc")}
        >
          <EditableField
            label={t("settings.displayName")}
            value={myMember.name}
            onSave={(val) => handleUpdateField("name", val)}
          />
        </SectionRow>
        <SectionRow
          indent
          label={t("settings.memberId")}
          description={t("settings.memberIdDesc")}
        >
          <div className="flex items-center gap-2">
            <span className="text-[14px] text-text-1">{myMember.id}</span>
            <Button
              icon={
                <HugeiconsIcon icon={Copy01Icon} data-icon="copy" size={14} />
              }
              iconOnly
              onClick={() => {
                copyText(myMember.id).catch((err) => {
                  logger.error("Failed to copy:", err);
                });
              }}
            />
          </div>
        </SectionRow>
      </SectionContainer>

      <SectionContainer>
        <SectionRow
          label={t("settings.github")}
          description={t("settings.githubDescription")}
        >
          {null}
        </SectionRow>
        <SectionRow
          indent
          label={t("settings.githubUsername")}
          description={t("settings.githubUsernameDesc")}
        >
          <EditableField
            label={t("settings.githubUsername")}
            value={myMember.github_username || ""}
            onSave={(val) => handleUpdateField("github_username", val)}
          />
        </SectionRow>
      </SectionContainer>

      {/* Linked Identities Section */}
      <SectionContainer>
        <SectionRow
          label={t("settings.linkedIdentities")}
          description={t("settings.linkedIdentitiesDesc")}
        >
          {null}
        </SectionRow>
        <SectionRow label="" indent showHeader={false}>
          {/* Primary email */}
          <LinkedEmailRow
            email={myMember.email || ""}
            lastCommitDate={myMember.last_commit_date}
            isPrimary
            t={t}
          />
          {/* Linked emails */}
          {myMember.linked_emails?.map((linked) => (
            <LinkedEmailRow
              key={linked.email}
              email={linked.email}
              lastCommitDate={linked.last_commit_date}
              onUnlink={() => handleUnlinkIdentity(linked.email)}
              t={t}
            />
          ))}
        </SectionRow>

        {/* Suggested Matches */}
        {suggestedMatches.length > 0 && (
          <>
            <SectionRow
              label={t("settings.suggestedMatches")}
              description={t("settings.suggestedMatchesDesc")}
            >
              {null}
            </SectionRow>
            <SectionRow label="" indent showHeader={false}>
              {suggestedMatches.map((member) => (
                <SuggestedMatchRow
                  key={member.id}
                  member={member}
                  reason={t("settings.similarName")}
                  onClaim={() => setClaimModalMember(member)}
                  t={t}
                />
              ))}
            </SectionRow>
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
    </SectionHeading>
  );
};

export default MyProfileSection;
