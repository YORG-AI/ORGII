/**
 * Management sections of `CloudOrgPanelView` (managed-cloud mirror of the
 * self-hosted `CollabOrgPanelView/MembersSection`):
 *
 *  - `CloudInvitesCard`   (admin) — two cards: "New invite" (role + max uses +
 *    optional expiry, then the one-time copyable HTTPS handoff link) and
 *    "Previous invites" (one row per invite, status + revoke trailing).
 *  - `CloudMembersSection` — the signed-in member gets a dedicated About me
 *    card above the remaining member rows. Admins get a role dropdown
 *    (admin/member) and Remove; everyone but the owner gets Leave from the
 *    About me card with an inline confirm (the owner must transfer or delete
 *    instead).
 * All handlers/state come from `useCloudOrgManagement`; these components
 * are render-only.
 */
import type { TFunction } from "i18next";
import React, { useMemo, useState } from "react";

import Button from "@src/components/Button";
import Select from "@src/components/Select";
import { isAccessModeAtLeast } from "@src/features/Org2Cloud/org2CloudAccessSettings";
import type { CloudOrgMember } from "@src/features/Org2Cloud/org2CloudClient";
import {
  CLOUD_ASSIGNABLE_ROLES,
  CLOUD_INVITE_STATE,
  type CloudAssignableRole,
  type CloudInviteRecord,
  deriveCloudInviteState,
  getCloudInviteRemainingUses,
  isCloudAssignableRole,
} from "@src/features/Org2Cloud/org2CloudOrgManagement";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_CONTROL_STYLE,
  SECTION_VALUE_SMALL_MUTED_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";
import {
  DEFAULT_INVITE_EXPIRY_DAYS,
  PANEL_INVITE_USAGE_LIMIT,
} from "@src/store/collaboration/inviteDefaults";
import {
  COLLAB_SESSION_ACCESS_MODE,
  type CollabSessionAccessMode,
} from "@src/store/collaboration/types";
import { formatSmartDateTime } from "@src/util/data/formatters/date";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import type {
  CloudOrgManagement,
  CreateCloudInviteOptions,
} from "./useCloudOrgManagement";

const INVITE_USAGE_LIMIT_OPTIONS = [1, 5, 10, 25] as const;
/** 0 is the "never expires" sentinel (maps to a null expiry). */
const INVITE_EXPIRY_DAY_OPTIONS = [1, 7, 30, 0] as const;
const MEMBER_ROLE_CONTROL_STYLE = {
  ...SECTION_CONTROL_STYLE,
  width: 132,
} as const;
function roleLabel(
  t: TFunction<"navigation">,
  role: CloudAssignableRole
): string {
  return role === "admin"
    ? t("cloud.orgManagement.invites.roleAdmin")
    : t("cloud.orgManagement.invites.roleMember");
}

function CloudBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-fill-2 px-2 py-0.5 text-[11px] font-medium text-text-2">
      {children}
    </span>
  );
}

interface CloudMemberLabelProps {
  t: TFunction<"navigation">;
  member: CloudOrgMember;
  isSelf?: boolean;
}

function CloudMemberLabel({
  t,
  member,
  isSelf = false,
}: CloudMemberLabelProps) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 truncate">
        {member.displayName ?? member.userId}
      </span>
      {member.role === "owner" ? (
        <CloudBadge>{t("cloud.orgManagement.members.ownerTag")}</CloudBadge>
      ) : null}
      {isSelf ? (
        <CloudBadge>{t("cloud.orgManagement.members.youTag")}</CloudBadge>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

interface CloudInvitesCardProps {
  t: TFunction<"navigation">;
  management: CloudOrgManagement;
}

export function CloudInvitesCard({ t, management }: CloudInvitesCardProps) {
  const {
    invites,
    inviteListError,
    creatingInvite,
    copyingInvite,
    inviteError,
    revokingInviteId,
    latestCreatedInvite,
    handleCreateInvite,
    handleCopyInvite,
    handleRevokeInvite,
  } = management;

  const [usageLimit, setUsageLimit] = useState<number>(
    PANEL_INVITE_USAGE_LIMIT
  );
  const [expiresInDays, setExpiresInDays] = useState<number>(
    DEFAULT_INVITE_EXPIRY_DAYS
  );
  const [role, setRole] = useState<CloudAssignableRole>("member");

  const usageOptions = useMemo(
    () =>
      INVITE_USAGE_LIMIT_OPTIONS.map((limit) => ({
        value: limit,
        label: String(limit),
        dataTestId: `cloud-org-invite-usage-${limit}`,
      })),
    []
  );
  const expiryOptions = useMemo(
    () =>
      INVITE_EXPIRY_DAY_OPTIONS.map((days) => ({
        value: days,
        dataTestId: `cloud-org-invite-expiry-${days}`,
        label:
          days === 0
            ? t("cloud.orgManagement.invites.expiryOptionNever")
            : days === 1
              ? t("cloud.orgManagement.invites.expiryOption1d")
              : days === 7
                ? t("cloud.orgManagement.invites.expiryOption7d")
                : t("cloud.orgManagement.invites.expiryOption30d"),
      })),
    [t]
  );
  const roleOptions = useMemo(
    () =>
      CLOUD_ASSIGNABLE_ROLES.map((value) => ({
        value,
        label: roleLabel(t, value),
        dataTestId: `cloud-org-invite-role-${value}`,
      })),
    [t]
  );

  // No window.confirm here: the blocking native dialog leaves a stale-paint
  // ghost of the row in WebKit after dismissal (repaints only on the next
  // interaction). Revoking an invite is low-stakes — a new one is one click
  // away — so the loading state on the button is confirmation enough.
  const handleRevoke = (invite: CloudInviteRecord) => {
    void handleRevokeInvite(invite);
  };

  const handleCreate = () => {
    const options: CreateCloudInviteOptions = {
      usageLimit,
      expiresInDays: expiresInDays === 0 ? null : expiresInDays,
      role,
    };
    void handleCreateInvite(options);
  };

  return (
    <>
      {/* Box 1 — create. Keeps the `cloud-org-invites` testid: it is the
      admin-only surface E2E asserts on (present for owner, absent for member). */}
      <SectionContainer title={t("cloud.orgManagement.invites.createTitle")}>
        <div data-testid="cloud-org-invites">
          <SectionRow label={t("cloud.orgManagement.invites.usageLimitLabel")}>
            <Select
              size="default"
              value={usageLimit}
              options={usageOptions}
              style={SECTION_CONTROL_STYLE}
              dataTestId="cloud-org-invite-usage-select"
              onChange={(value) => setUsageLimit(Number(value))}
            />
          </SectionRow>
          <SectionRow label={t("cloud.orgManagement.invites.expiryLabel")}>
            <Select
              size="default"
              value={expiresInDays}
              options={expiryOptions}
              style={SECTION_CONTROL_STYLE}
              dataTestId="cloud-org-invite-expiry-select"
              onChange={(value) => setExpiresInDays(Number(value))}
            />
          </SectionRow>
          <SectionRow label={t("cloud.orgManagement.invites.roleLabel")}>
            <Select
              size="default"
              value={role}
              options={roleOptions}
              style={SECTION_CONTROL_STYLE}
              dataTestId="cloud-org-invite-role-select"
              onChange={(value) => {
                if (isCloudAssignableRole(value)) setRole(value);
              }}
            />
          </SectionRow>
          {/* No row label — the card title already says what this creates. */}
          <SectionRow showHeader={false}>
            <div className="flex w-full justify-end">
              <Button
                htmlType="button"
                size="default"
                variant="primary"
                disabled={creatingInvite}
                loading={creatingInvite}
                data-guide-target={GUIDE_TARGETS.CLOUD_ORG_INVITE_ACTION}
                data-testid="cloud-org-create-invite"
                onClick={handleCreate}
              >
                {t("cloud.orgManagement.invites.create")}
              </Button>
            </div>
          </SectionRow>

          {latestCreatedInvite ? (
            <SectionRow
              label={t("cloud.orgManagement.invites.linkOneTimeNote")}
              layout="vertical"
            >
              <div className="flex flex-col gap-2">
                <div
                  className="select-text break-all rounded-md bg-fill-1 px-3 py-2 font-mono text-[12px] text-text-2"
                  data-testid="cloud-org-invite-link"
                >
                  {latestCreatedInvite.inviteLink}
                </div>
                <Button
                  htmlType="button"
                  size="default"
                  variant="primary"
                  data-testid="cloud-org-invite-link-copy"
                  disabled={copyingInvite}
                  onClick={() => void handleCopyInvite()}
                >
                  {copyingInvite
                    ? t("cloud.orgManagement.invites.copied")
                    : t("cloud.orgManagement.invites.copyLink")}
                </Button>
              </div>
            </SectionRow>
          ) : null}

          {inviteError ? (
            <div className="pb-2 text-[12px] text-danger-6">{inviteError}</div>
          ) : null}
        </div>
      </SectionContainer>

      {/* Box 2 — inventory. One row per invite: role + created-at on the left,
      status and Revoke trailing on the right. */}
      <SectionContainer title={t("cloud.orgManagement.invites.historyTitle")}>
        <div data-testid="cloud-org-invite-history">
          {invites.length === 0 ? (
            <SectionRow
              label={inviteListError ?? t("cloud.orgManagement.invites.empty")}
              light
            />
          ) : (
            invites.map((invite) => {
              const state = deriveCloudInviteState(invite);
              const active = state === CLOUD_INVITE_STATE.ACTIVE;
              const inviteStatus = active
                ? `${t("cloud.orgManagement.invites.remainingUses", {
                    uses: getCloudInviteRemainingUses(invite),
                  })} · ${
                    invite.expiresAt
                      ? t("cloud.orgManagement.invites.expires", {
                          date: formatSmartDateTime(invite.expiresAt),
                        })
                      : t("cloud.orgManagement.invites.neverExpires")
                  }`
                : t(
                    state === CLOUD_INVITE_STATE.REVOKED
                      ? "cloud.orgManagement.invites.stateRevoked"
                      : state === CLOUD_INVITE_STATE.EXPIRED
                        ? "cloud.orgManagement.invites.stateExpired"
                        : "cloud.orgManagement.invites.stateExhausted"
                  );
              return (
                <div
                  key={invite.inviteId}
                  data-testid="cloud-org-invite-row"
                  data-invite-id={invite.inviteId}
                >
                  <SectionRow
                    label={
                      <span className="flex min-w-0 items-center gap-2">
                        <CloudBadge>{roleLabel(t, invite.role)}</CloudBadge>
                        <span className="min-w-0 truncate">
                          {t("cloud.orgManagement.invites.createdAt", {
                            date: formatSmartDateTime(invite.createdAt),
                          })}
                        </span>
                      </span>
                    }
                  >
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <span className={SECTION_VALUE_SMALL_MUTED_CLASSES}>
                        {inviteStatus}
                      </span>
                      {active ? (
                        <Button
                          htmlType="button"
                          size="default"
                          variant="secondary"
                          disabled={Boolean(revokingInviteId)}
                          loading={revokingInviteId === invite.inviteId}
                          data-testid={`cloud-org-invite-revoke-${invite.inviteId}`}
                          onClick={() => handleRevoke(invite)}
                        >
                          {t("cloud.orgManagement.invites.revoke")}
                        </Button>
                      ) : null}
                    </div>
                  </SectionRow>
                </div>
              );
            })
          )}
        </div>
      </SectionContainer>
    </>
  );
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

interface CloudMembersSectionProps {
  t: TFunction<"navigation">;
  members: CloudOrgMember[];
  currentUserId: string | null;
  management: CloudOrgManagement;
  /** Org-wide sharing floor; composed into the per-member override display. */
  orgFloor: CollabSessionAccessMode;
}

export function CloudMembersSection({
  t,
  members,
  currentUserId,
  management,
  orgFloor,
}: CloudMembersSectionProps) {
  const {
    isAdmin,
    isOwner,
    memberError,
    removingUserId,
    updatingRoleUserId,
    updatingFloorUserId,
    leavingOrg,
    leaveError,
    handleUpdateMemberRole,
    handleUpdateMemberFloor,
    handleRemoveMember,
    handleLeaveOrg,
  } = management;
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  const roleOptions = useMemo(
    () =>
      CLOUD_ASSIGNABLE_ROLES.map((value) => ({
        value,
        label: roleLabel(t, value),
        dataTestId: `cloud-org-member-role-option-${value}`,
      })),
    [t]
  );

  // Per-member sharing floor options: 'off' = no member-level minimum. When
  // the org-wide floor is set, 'off' is NOT "no requirement" — the org floor
  // still applies — so the sentinel label surfaces the effective org minimum
  // and sub-floor overrides (which the org floor would mask anyway) are
  // dropped from the picker.
  const memberFloorOptions = useMemo(() => {
    const hasOrgFloor = orgFloor !== COLLAB_SESSION_ACCESS_MODE.OFF;
    const modeLabel = (mode: CollabSessionAccessMode) =>
      mode === COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY
        ? t("cloud.syncLevel.modeFullReplay")
        : t("cloud.syncLevel.modeMetadata");
    return [
      {
        value: COLLAB_SESSION_ACCESS_MODE.OFF,
        label: hasOrgFloor
          ? t("cloud.orgManagement.members.floorOrgMinimum", {
              mode: modeLabel(orgFloor),
            })
          : t("cloud.orgManagement.members.floorOff"),
        dataTestId: "cloud-org-member-floor-option-off",
      },
      ...(
        [
          COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY,
          COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY,
        ] as const
      )
        .filter((mode) => isAccessModeAtLeast(mode, orgFloor))
        .map((mode) => ({
          value: mode,
          label: modeLabel(mode),
          dataTestId: `cloud-org-member-floor-option-${
            mode === COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY
              ? "metadata"
              : "full"
          }`,
        })),
    ];
  }, [orgFloor, t]);

  const handleRoleChange = async (
    member: CloudOrgMember,
    role: CloudAssignableRole
  ) => {
    if (role === member.role) return;
    const confirmed = await confirmDestructiveAction({
      title: t("cloud.orgManagement.members.roleChangeTitle"),
      message: t("cloud.orgManagement.members.roleChangeConfirm", {
        member: member.displayName ?? member.userId,
        role: roleLabel(t, role),
      }),
      okLabel: t("cloud.orgManagement.members.roleChangeAction"),
      cancelLabel: t("cloud.orgManagement.leave.cancel"),
    });
    if (!confirmed) return;
    void handleUpdateMemberRole(member, role);
  };

  const handleRemove = async (member: CloudOrgMember) => {
    const confirmed = await confirmDestructiveAction({
      title: t("cloud.orgManagement.members.removeTitle"),
      message: t("cloud.orgManagement.members.removeConfirm", {
        member: member.displayName ?? member.userId,
      }),
      okLabel: t("cloud.orgManagement.members.remove"),
      cancelLabel: t("cloud.orgManagement.leave.cancel"),
    });
    if (!confirmed) return;
    void handleRemoveMember(member);
  };

  const handleFloorChange = (
    member: CloudOrgMember,
    value: CollabSessionAccessMode
  ) => {
    void handleUpdateMemberFloor(member, value);
  };

  const activeMembers = members.filter((member) => member.status === "active");
  const currentMember = activeMembers.find(
    (member) => member.userId === currentUserId
  );
  const otherMembers = activeMembers.filter(
    (member) => member.userId !== currentUserId
  );

  return (
    <>
      {currentMember ? (
        <SectionContainer title={t("cloud.orgPanel.aboutMeTitle")}>
          <div data-testid="cloud-org-about-me">
            <SectionRow
              label={<CloudMemberLabel t={t} member={currentMember} isSelf />}
            >
              <div className="flex flex-wrap items-center justify-end gap-2">
                <span className={SECTION_VALUE_SMALL_MUTED_CLASSES}>
                  {currentMember.role} · {currentMember.status}
                </span>
                {!isOwner ? (
                  <Button
                    htmlType="button"
                    size="default"
                    variant="danger"
                    appearance="outline"
                    disabled={leavingOrg || confirmingLeave}
                    data-testid="cloud-org-leave"
                    onClick={() => setConfirmingLeave(true)}
                  >
                    {t("cloud.orgManagement.leave.action")}
                  </Button>
                ) : null}
              </div>
            </SectionRow>
            {confirmingLeave ? (
              <SectionRow
                label={t("cloud.orgManagement.leave.confirmTitle")}
                description={t("cloud.orgManagement.leave.warning")}
                layout="vertical"
              >
                <div className={SECTION_ACTION_GAP_CLASSES}>
                  <Button
                    htmlType="button"
                    size="default"
                    variant="danger"
                    disabled={leavingOrg}
                    loading={leavingOrg}
                    data-testid="cloud-org-leave-confirm"
                    onClick={() => void handleLeaveOrg()}
                  >
                    {t("cloud.orgManagement.leave.confirm")}
                  </Button>
                  <Button
                    htmlType="button"
                    size="default"
                    variant="secondary"
                    disabled={leavingOrg}
                    onClick={() => setConfirmingLeave(false)}
                  >
                    {t("cloud.orgManagement.leave.cancel")}
                  </Button>
                </div>
              </SectionRow>
            ) : null}
            {leaveError ? (
              <div className="pb-2 text-[12px] text-danger-6">{leaveError}</div>
            ) : null}
          </div>
        </SectionContainer>
      ) : null}

      <SectionContainer title={t("cloud.orgPanel.membersTitle")}>
        <div data-testid="cloud-org-members">
          {memberError ? (
            <div
              className="pb-2 text-[12px] text-danger-6"
              data-testid="cloud-org-member-error"
            >
              {memberError}
            </div>
          ) : null}
          {otherMembers.length === 0 ? (
            <SectionRow label={t("cloud.orgPanel.membersEmpty")} light />
          ) : (
            otherMembers.map((member) => {
              const targetIsOwner = member.role === "owner";
              const showMemberControls = isAdmin;
              return (
                <div
                  key={member.userId}
                  data-testid="cloud-org-member-row"
                  data-member-id={member.userId}
                >
                  <SectionRow
                    label={<CloudMemberLabel t={t} member={member} />}
                  >
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {showMemberControls ? (
                        <>
                          {/* Per-member sharing floor: the minimum this member
                          must share at. The wrapper span carries the hover
                          tooltip (Select has no title prop). */}
                          <span
                            title={t(
                              "cloud.orgManagement.members.floorTooltip"
                            )}
                          >
                            <Select
                              size="default"
                              value={
                                // A member override below the org floor is masked
                                // by it; show the org-minimum sentinel instead of
                                // a hidden sub-floor option.
                                member.sharingFloor &&
                                isAccessModeAtLeast(
                                  member.sharingFloor,
                                  orgFloor
                                )
                                  ? member.sharingFloor
                                  : COLLAB_SESSION_ACCESS_MODE.OFF
                              }
                              options={memberFloorOptions}
                              style={MEMBER_ROLE_CONTROL_STYLE}
                              disabled={
                                targetIsOwner || Boolean(updatingFloorUserId)
                              }
                              loading={updatingFloorUserId === member.userId}
                              dataTestId={`cloud-org-member-floor-${member.userId}`}
                              onChange={(value) =>
                                handleFloorChange(
                                  member,
                                  value as CollabSessionAccessMode
                                )
                              }
                            />
                          </span>
                          <Select
                            size="default"
                            value={member.role}
                            options={roleOptions}
                            style={MEMBER_ROLE_CONTROL_STYLE}
                            disabled={
                              targetIsOwner || Boolean(updatingRoleUserId)
                            }
                            loading={updatingRoleUserId === member.userId}
                            dataTestId={`cloud-org-member-role-${member.userId}`}
                            onChange={(value) => {
                              if (isCloudAssignableRole(value)) {
                                void handleRoleChange(member, value);
                              }
                            }}
                          />
                          <Button
                            htmlType="button"
                            size="default"
                            variant="secondary"
                            disabled={targetIsOwner || Boolean(removingUserId)}
                            loading={removingUserId === member.userId}
                            data-testid={`cloud-org-member-remove-${member.userId}`}
                            onClick={() => void handleRemove(member)}
                          >
                            {t("cloud.orgManagement.members.remove")}
                          </Button>
                        </>
                      ) : (
                        <span className={SECTION_VALUE_SMALL_MUTED_CLASSES}>
                          {member.role} · {member.status}
                        </span>
                      )}
                    </div>
                  </SectionRow>
                </div>
              );
            })
          )}
        </div>
      </SectionContainer>
    </>
  );
}
