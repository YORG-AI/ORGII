import type { TFunction } from "i18next";
import React from "react";

import Button from "@src/components/Button";
import { SectionContainer } from "@src/modules/shared/layouts/SectionLayout";
import { COLLAB_ROLE } from "@src/store/collaboration/types";
import type {
  CollabInviteRecord,
  CollabMemberRecord,
  CollabOrgRecord,
} from "@src/store/collaboration/types";

import { formatSessionDate, getInviteRemainingUses } from "./utils";

function MemberStatusPill({
  active,
  label,
}: {
  active: boolean;
  label: string;
}): React.ReactNode {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-fill-2 px-2 py-0.5 text-[11px] font-medium text-text-2">
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          active ? "bg-success-6" : "bg-fill-4"
        }`}
      />
      {label}
    </span>
  );
}

interface InviteCardProps {
  t: TFunction<"navigation">;
  latestInvite: CollabInviteRecord | undefined;
  canCreateInvite: boolean;
  creatingInvite: boolean;
  copyingInvite: boolean;
  inviteError: string | null;
  onCreateInvite: () => void;
  onCopyInvite: () => void;
}

function InviteCard({
  t,
  latestInvite,
  canCreateInvite,
  creatingInvite,
  copyingInvite,
  inviteError,
  onCreateInvite,
  onCopyInvite,
}: InviteCardProps) {
  return (
    <SectionContainer color="chatPanelInfo" padding="none">
      <div className="flex flex-col gap-3 p-4 @[720px]:flex-row @[720px]:items-center @[720px]:justify-between">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-text-1">
            {t("collaboration.invite.title")}
          </div>
          {!canCreateInvite ? (
            <div className="mt-1 text-[12px] text-text-3">
              {t("collaboration.invite.adminOnly")}
            </div>
          ) : null}
          {latestInvite ? (
            <div className="mt-2 rounded-lg bg-fill-1 px-3 py-2">
              <div className="select-text break-all text-[12px] text-text-2">
                {latestInvite.inviteLink}
              </div>
              <div className="mt-1 text-[11px] text-text-3">
                {t("collaboration.invite.remainingUses", {
                  count: getInviteRemainingUses(latestInvite),
                })}
                {latestInvite.expiresAt
                  ? ` · ${t("collaboration.invite.expires", {
                      date: formatSessionDate(latestInvite.expiresAt),
                    })}`
                  : ""}
              </div>
            </div>
          ) : null}
          {inviteError ? (
            <div className="mt-2 text-[12px] text-danger-6">{inviteError}</div>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          {latestInvite ? (
            <Button
              htmlType="button"
              size="small"
              disabled={copyingInvite}
              onClick={() => void onCopyInvite()}
            >
              {copyingInvite
                ? t("collaboration.copiedInvite")
                : t("collaboration.copyInvite")}
            </Button>
          ) : null}
          <Button
            htmlType="button"
            size="small"
            variant="primary"
            disabled={!canCreateInvite || creatingInvite}
            loading={creatingInvite}
            onClick={() => void onCreateInvite()}
          >
            {latestInvite
              ? t("collaboration.invite.createNew")
              : t("collaboration.invite.create")}
          </Button>
        </div>
      </div>
    </SectionContainer>
  );
}

interface MembersSectionProps {
  t: TFunction<"navigation">;
  org: CollabOrgRecord;
  orgMembers: CollabMemberRecord[];
  selectedMember: CollabMemberRecord | null;
  currentMember: CollabMemberRecord | undefined;
  activeMemberIds: Set<string>;
  latestInvite: CollabInviteRecord | undefined;
  canCreateInvite: boolean;
  creatingInvite: boolean;
  copyingInvite: boolean;
  inviteError: string | null;
  memberError: string | null;
  removingMemberId: string | null;
  onCreateInvite: () => void;
  onCopyInvite: () => void;
  onSelectMember: (member: CollabMemberRecord) => void;
  onRemoveMember: (member: CollabMemberRecord) => void;
}

export function MembersSection({
  t,
  org,
  orgMembers,
  selectedMember,
  currentMember,
  activeMemberIds,
  latestInvite,
  canCreateInvite,
  creatingInvite,
  copyingInvite,
  inviteError,
  memberError,
  removingMemberId,
  onCreateInvite,
  onCopyInvite,
  onSelectMember,
  onRemoveMember,
}: MembersSectionProps) {
  return (
    <>
      {!selectedMember ? (
        <InviteCard
          t={t}
          latestInvite={latestInvite}
          canCreateInvite={canCreateInvite}
          creatingInvite={creatingInvite}
          copyingInvite={copyingInvite}
          inviteError={inviteError}
          onCreateInvite={onCreateInvite}
          onCopyInvite={onCopyInvite}
        />
      ) : null}

      <SectionContainer color="chatPanelInfo" padding="default">
        <div className="flex flex-col divide-y divide-border-2">
          {memberError ? (
            <div className="px-3 pb-2 text-[12px] text-danger-6">
              {memberError}
            </div>
          ) : null}
          {orgMembers.map((member) => {
            const canRemoveMember =
              currentMember?.role === COLLAB_ROLE.ADMIN &&
              currentMember.id !== member.id &&
              Boolean(org.supabaseUrl && org.supabaseAnonKey && org.orgSecret);
            const active = activeMemberIds.has(member.id);
            return (
              <div
                key={member.id}
                className="flex w-full items-center justify-between gap-3 py-2"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center justify-between gap-3 px-3 text-left transition-colors hover:bg-surface-hover"
                  onClick={() => onSelectMember(member)}
                >
                  <span className="min-w-0 text-[13px] font-medium text-text-1">
                    {member.displayName}
                  </span>
                  <span className="flex min-w-0 items-center gap-2 text-[12px] text-text-3">
                    <span>{member.identityKind}</span>
                    <span>·</span>
                    <span>{member.role}</span>
                    <MemberStatusPill
                      active={active}
                      label={
                        active
                          ? t("collaboration.status.activeToday")
                          : t("collaboration.status.idle")
                      }
                    />
                  </span>
                </button>
                {canRemoveMember ? (
                  <Button
                    htmlType="button"
                    size="mini"
                    variant="danger"
                    appearance="ghost"
                    disabled={Boolean(removingMemberId)}
                    loading={removingMemberId === member.id}
                    onClick={() => void onRemoveMember(member)}
                  >
                    {t("collaboration.members.remove")}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      </SectionContainer>
    </>
  );
}
