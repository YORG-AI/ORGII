/**
 * Management sections of `CloudOrgPanelView` (managed-cloud mirror of the
 * self-hosted `CollabOrgPanelView/MembersSection`):
 *
 *  - `CloudInvitesCard`   (admin) — create invite (role + max uses + optional
 *    expiry), one-time copyable `orgii://cloud/join` link, inventory with
 *    usage/state, revoke.
 *  - `CloudMembersSection` — member rows; admins get a role dropdown
 *    (admin/member) and Remove; everyone but the owner gets Leave
 *    with an inline confirm (the owner must transfer or delete instead).
 *  - `CloudOrgSettingsSection` (admin/owner) — rename; owner-only transfer
 *    picker and delete with typed name confirmation.
 *
 * All handlers/state come from `useCloudOrgManagement`; these components
 * are render-only.
 */
import type { TFunction } from "i18next";
import React, { useMemo, useState } from "react";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
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
    <SectionContainer title={t("cloud.orgManagement.invites.title")}>
      <div data-testid="cloud-org-invites">
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
                  description={inviteStatus}
                >
                  {active ? (
                    <Button
                      htmlType="button"
                      size="default"
                      variant="danger"
                      appearance="ghost"
                      disabled={Boolean(revokingInviteId)}
                      loading={revokingInviteId === invite.inviteId}
                      data-testid={`cloud-org-invite-revoke-${invite.inviteId}`}
                      onClick={() => handleRevoke(invite)}
                    >
                      {t("cloud.orgManagement.invites.revoke")}
                    </Button>
                  ) : null}
                </SectionRow>
              </div>
            );
          })
        )}

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
        <SectionRow label={t("cloud.orgManagement.invites.create")}>
          <Button
            htmlType="button"
            size="default"
            variant="primary"
            disabled={creatingInvite}
            loading={creatingInvite}
            data-testid="cloud-org-create-invite"
            onClick={handleCreate}
          >
            {t("cloud.orgManagement.invites.create")}
          </Button>
        </SectionRow>

        {inviteError ? (
          <div className="pb-2 text-[12px] text-danger-6">{inviteError}</div>
        ) : null}
      </div>
    </SectionContainer>
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
}

export function CloudMembersSection({
  t,
  members,
  currentUserId,
  management,
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

  // Per-member sharing floor options: 'off' = no member-level minimum (the
  // org-wide floor still applies — this dropdown is the OVERRIDE on top).
  const memberFloorOptions = useMemo(
    () => [
      {
        value: COLLAB_SESSION_ACCESS_MODE.OFF,
        label: t("cloud.orgManagement.members.floorOff"),
        dataTestId: "cloud-org-member-floor-option-off",
      },
      {
        value: COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY,
        label: t("cloud.syncLevel.modeMetadata"),
        dataTestId: "cloud-org-member-floor-option-metadata",
      },
      {
        value: COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY,
        label: t("cloud.syncLevel.modeFullReplay"),
        dataTestId: "cloud-org-member-floor-option-full",
      },
    ],
    [t]
  );

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

  return (
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
        {members.map((member) => {
          const isSelf = currentUserId === member.userId;
          const targetIsOwner = member.role === "owner";
          const canManageMember =
            isAdmin && !isSelf && !targetIsOwner && member.status === "active";
          const canLeave = isSelf && !isOwner;
          return (
            <div
              key={member.userId}
              data-testid="cloud-org-member-row"
              data-member-id={member.userId}
            >
              <SectionRow
                label={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate">
                      {member.displayName ?? member.userId}
                    </span>
                    {targetIsOwner ? (
                      <CloudBadge>
                        {t("cloud.orgManagement.members.ownerTag")}
                      </CloudBadge>
                    ) : null}
                    {isSelf ? (
                      <CloudBadge>
                        {t("cloud.orgManagement.members.youTag")}
                      </CloudBadge>
                    ) : null}
                  </span>
                }
              >
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {canManageMember ? (
                    <>
                      {/* Per-member sharing floor: the minimum this member
                          must share at. The wrapper span carries the hover
                          tooltip (Select has no title prop). */}
                      <span
                        title={t("cloud.orgManagement.members.floorTooltip")}
                      >
                        <Select
                          size="default"
                          value={
                            member.sharingFloor ??
                            COLLAB_SESSION_ACCESS_MODE.OFF
                          }
                          options={memberFloorOptions}
                          style={MEMBER_ROLE_CONTROL_STYLE}
                          disabled={Boolean(updatingFloorUserId)}
                          loading={updatingFloorUserId === member.userId}
                          dataTestId={`cloud-org-member-floor-${member.userId}`}
                          onChange={(value) =>
                            void handleUpdateMemberFloor(
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
                        disabled={Boolean(updatingRoleUserId)}
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
                        variant="danger"
                        appearance="ghost"
                        disabled={Boolean(removingUserId)}
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
                  {canLeave ? (
                    <Button
                      htmlType="button"
                      size="default"
                      variant="danger"
                      appearance="ghost"
                      disabled={leavingOrg || confirmingLeave}
                      data-testid="cloud-org-leave"
                      onClick={() => setConfirmingLeave(true)}
                    >
                      {t("cloud.orgManagement.leave.action")}
                    </Button>
                  ) : null}
                </div>
              </SectionRow>
              {isSelf && confirmingLeave ? (
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
              {isSelf && leaveError ? (
                <div className="pb-2 text-[12px] text-danger-6">
                  {leaveError}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </SectionContainer>
  );
}

// ---------------------------------------------------------------------------
// Org settings (rename / transfer / delete)
// ---------------------------------------------------------------------------

interface CloudOrgSettingsSectionProps {
  t: TFunction<"navigation">;
  orgName: string;
  members: CloudOrgMember[];
  currentUserId: string | null;
  management: CloudOrgManagement;
}

export function CloudOrgSettingsSection({
  t,
  orgName,
  members,
  currentUserId,
  management,
}: CloudOrgSettingsSectionProps) {
  const {
    isOwner,
    renaming,
    renameSaved,
    renameError,
    handleRenameOrg,
    transferring,
    transferError,
    handleTransferOwnership,
    deleting,
    deleteError,
    handleDeleteOrg,
  } = management;

  const [nameDraft, setNameDraft] = useState(orgName);
  // Re-seed when a rename lands (refetched org name) or the org switches.
  const [seededName, setSeededName] = useState(orgName);
  if (seededName !== orgName) {
    setSeededName(orgName);
    setNameDraft(orgName);
  }

  const [transferTarget, setTransferTarget] = useState<string>("");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const transferOptions = useMemo(
    () =>
      members
        .filter(
          (member) =>
            member.status === "active" && member.userId !== currentUserId
        )
        .map((member) => ({
          value: member.userId,
          label: member.displayName ?? member.userId,
          dataTestId: `cloud-org-transfer-option-${member.userId}`,
        })),
    [members, currentUserId]
  );

  const nameDirty = nameDraft.trim().length > 0 && nameDraft.trim() !== orgName;

  const handleTransfer = async () => {
    if (!transferTarget) return;
    const target = members.find((member) => member.userId === transferTarget);
    const confirmed = await confirmDestructiveAction({
      title: t("cloud.orgManagement.settings.transferTitle"),
      message: t("cloud.orgManagement.settings.transferConfirm", {
        org: orgName,
        member: target?.displayName ?? transferTarget,
      }),
      okLabel: t("cloud.orgManagement.settings.transferAction"),
      cancelLabel: t("cloud.orgManagement.leave.cancel"),
    });
    if (!confirmed) return;
    void handleTransferOwnership(transferTarget);
  };

  return (
    <>
      <SectionContainer title={t("cloud.orgManagement.settings.title")}>
        <div data-testid="cloud-org-settings">
          <SectionRow
            label={t("cloud.orgManagement.settings.renameLabel")}
            align="start"
          >
            <div className={`${SECTION_ACTION_GAP_CLASSES} flex-wrap`}>
              <Input
                size="default"
                value={nameDraft}
                onChange={setNameDraft}
                style={SECTION_CONTROL_STYLE}
                data-testid="cloud-org-rename-input"
              />
              <Button
                htmlType="button"
                size="default"
                variant="primary"
                disabled={!nameDirty || renaming}
                loading={renaming}
                data-testid="cloud-org-rename-save"
                onClick={() => void handleRenameOrg(nameDraft.trim())}
              >
                {t("cloud.orgManagement.settings.renameSave")}
              </Button>
              {renameSaved ? (
                <span className="text-[12px] text-success-6">
                  {t("cloud.orgManagement.settings.renamed")}
                </span>
              ) : null}
            </div>
          </SectionRow>
          {renameError ? (
            <div className="pb-2 text-[12px] text-danger-6">{renameError}</div>
          ) : null}

          {isOwner ? (
            <>
              <SectionRow
                label={t("cloud.orgManagement.settings.transferTitle")}
                description={t("cloud.orgManagement.settings.transferHint")}
                align="start"
              >
                <div className={`${SECTION_ACTION_GAP_CLASSES} flex-wrap`}>
                  <Select
                    size="default"
                    value={transferTarget || undefined}
                    options={transferOptions}
                    placeholder={t(
                      "cloud.orgManagement.settings.transferPlaceholder"
                    )}
                    style={SECTION_CONTROL_STYLE}
                    disabled={transferring || transferOptions.length === 0}
                    dataTestId="cloud-org-transfer-select"
                    onChange={(value) => setTransferTarget(String(value))}
                  />
                  <Button
                    htmlType="button"
                    size="default"
                    variant="secondary"
                    disabled={!transferTarget || transferring}
                    loading={transferring}
                    data-testid="cloud-org-transfer-confirm"
                    onClick={() => void handleTransfer()}
                  >
                    {t("cloud.orgManagement.settings.transferAction")}
                  </Button>
                </div>
              </SectionRow>
              {transferError ? (
                <div className="pb-2 text-[12px] text-danger-6">
                  {transferError}
                </div>
              ) : null}

              <SectionRow
                label={t("cloud.orgManagement.settings.ownerLeaveHint")}
                light
              />
            </>
          ) : null}
        </div>
      </SectionContainer>
      {isOwner ? (
        <SectionContainer title={t("cloud.orgManagement.settings.dangerZone")}>
          <div data-testid="cloud-org-danger-zone">
            <SectionRow
              label={t("cloud.orgManagement.settings.deleteTitle")}
              description={t("cloud.orgManagement.settings.deleteHint", {
                org: orgName,
              })}
              layout="vertical"
              align="start"
            >
              <div className={`${SECTION_ACTION_GAP_CLASSES} flex-wrap`}>
                <Input
                  size="default"
                  value={deleteConfirmText}
                  onChange={setDeleteConfirmText}
                  placeholder={t(
                    "cloud.orgManagement.settings.deleteTypeToConfirm",
                    { org: orgName }
                  )}
                  style={SECTION_CONTROL_STYLE}
                  data-testid="cloud-org-delete-confirm-input"
                />
                <Button
                  htmlType="button"
                  size="default"
                  variant="danger"
                  disabled={deleteConfirmText.trim() !== orgName || deleting}
                  loading={deleting}
                  data-testid="cloud-org-delete-confirm"
                  onClick={() => void handleDeleteOrg()}
                >
                  {t("cloud.orgManagement.settings.deleteAction")}
                </Button>
              </div>
            </SectionRow>
            {deleteError ? (
              <div className="pb-2 text-[12px] text-danger-6">
                {deleteError}
              </div>
            ) : null}
          </div>
        </SectionContainer>
      ) : null}
    </>
  );
}
