/**
 * ManageChannelMembersDialog — membership surface for one org channel (0014
 * membership RPCs). Lists members on open; managers additionally get an
 * add-members picker (org roster minus current members, shared coordinator
 * source) and per-row overflow actions (remove / toggle manager role). The
 * current user's own row offers "Leave channel" on private channels — the
 * server allows any member to remove THEMSELVES. `ORG2_LAST_MANAGER` is
 * surfaced as an instructive inline message instead of a generic failure.
 * Every successful mutation bumps the per-org channels version and refreshes
 * the member list.
 */
import Modal from "@/src/scaffold/ModalSystem";
import { useSetAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Checkbox from "@src/components/Checkbox";
import Dropdown from "@src/components/Dropdown";
import type { DropdownOption } from "@src/components/Dropdown/types";
import PersonAvatar from "@src/components/PersonAvatar";
import { ChannelDialogErrorNotice } from "@src/features/DiscussionChannels/components/ChannelDialogPrimitives";
import { HugeiconsIcon, MoreHorizontalIcon } from "@src/icons";
import { PanelFooter } from "@src/modules/shared/layouts/blocks";

import { bumpOrg2CloudChannelsVersionAtom } from "../channelsAtom";
import {
  addCloudChannelMembers,
  isOrg2ChannelsErrorCode,
  listCloudChannelMembers,
  removeCloudChannelMember,
  setCloudChannelMemberRole,
} from "../channelsClient";
import type { CloudChannel, CloudChannelMember } from "../types";
import { CHANNEL_ADD_MEMBERS_MAX_PER_CALL } from "../types";
import {
  useActiveOrgMembers,
  useFreshChannelAccessToken,
} from "./useChannelDialogAccess";

type MembersErrorKind = "lastManager" | "generic";

export interface ManageChannelMembersDialogProps {
  open: boolean;
  orgId: string | null;
  channel: CloudChannel | null;
  currentUserId: string | null;
  canManage: boolean;
  onClose: () => void;
}

const ManageChannelMembersDialog: React.FC<ManageChannelMembersDialogProps> = ({
  open,
  orgId,
  channel,
  currentUserId,
  canManage,
  onClose,
}) => {
  const { t } = useTranslation("navigation");
  const bumpChannelsVersion = useSetAtom(bumpOrg2CloudChannelsVersionAtom);
  const getFreshAccessToken = useFreshChannelAccessToken();
  const channelId = channel?.id ?? null;

  const [members, setMembers] = useState<CloudChannelMember[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [mutating, setMutating] = useState(false);
  const [errorKind, setErrorKind] = useState<MembersErrorKind | null>(null);
  const [selectedAddIds, setSelectedAddIds] = useState<string[]>([]);

  // Late fetches after a channel/org switch must never land (roster idiom).
  const requestRef = useRef(0);
  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    []
  );

  // A channel switch (or re-open) is a hard state boundary.
  useEffect(() => {
    setMembers(null);
    setLoadFailed(false);
    setErrorKind(null);
    setSelectedAddIds([]);
  }, [open, channelId]);

  useEffect(() => {
    if (!open || !orgId || !channelId) return;
    let cancelled = false;
    const seq = ++requestRef.current;
    void (async () => {
      setLoading(true);
      setLoadFailed(false);
      try {
        const accessToken = await getFreshAccessToken();
        const list = await listCloudChannelMembers(
          accessToken,
          orgId,
          channelId
        );
        if (cancelled || seq !== requestRef.current) return;
        setMembers(list);
      } catch {
        if (!cancelled && seq === requestRef.current) setLoadFailed(true);
      } finally {
        if (!cancelled && seq === requestRef.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, orgId, channelId, refreshNonce, getFreshAccessToken]);

  const refresh = useCallback(() => {
    setRefreshNonce((nonce) => nonce + 1);
  }, []);

  const runMutation = useCallback(
    async (
      mutate: (accessToken: string) => Promise<void>,
      options?: { closeAfter?: boolean; onSuccess?: () => void }
    ) => {
      if (!orgId || mutating) return;
      setMutating(true);
      setErrorKind(null);
      try {
        const accessToken = await getFreshAccessToken();
        await mutate(accessToken);
        bumpChannelsVersion(orgId);
        options?.onSuccess?.();
        if (options?.closeAfter) {
          onClose();
        } else {
          refresh();
        }
      } catch (caught) {
        setErrorKind(
          isOrg2ChannelsErrorCode(caught, "ORG2_LAST_MANAGER")
            ? "lastManager"
            : "generic"
        );
      } finally {
        setMutating(false);
      }
    },
    [
      orgId,
      mutating,
      getFreshAccessToken,
      bumpChannelsVersion,
      onClose,
      refresh,
    ]
  );

  const handleAddMembers = useCallback(() => {
    if (!orgId || !channelId || selectedAddIds.length === 0) return;
    const userIds = selectedAddIds;
    void runMutation(
      (accessToken) =>
        addCloudChannelMembers(accessToken, orgId, channelId, userIds),
      { onSuccess: () => setSelectedAddIds([]) }
    );
  }, [orgId, channelId, selectedAddIds, runMutation]);

  const handleRemoveMember = useCallback(
    (userId: string) => {
      if (!orgId || !channelId) return;
      void runMutation(
        (accessToken) =>
          removeCloudChannelMember(accessToken, orgId, channelId, userId),
        // Leaving is remove-self; a private channel is unreadable afterwards.
        { closeAfter: userId === currentUserId }
      );
    },
    [orgId, channelId, currentUserId, runMutation]
  );

  const handleToggleRole = useCallback(
    (member: CloudChannelMember) => {
      if (!orgId || !channelId) return;
      const nextRole = member.role === "manager" ? "member" : "manager";
      void runMutation((accessToken) =>
        setCloudChannelMemberRole(
          accessToken,
          orgId,
          channelId,
          member.userId,
          nextRole
        )
      );
    },
    [orgId, channelId, runMutation]
  );

  const handleToggleAddId = useCallback((userId: string) => {
    setSelectedAddIds((current) =>
      current.includes(userId)
        ? current.filter((id) => id !== userId)
        : [...current, userId]
    );
  }, []);

  const roster = useActiveOrgMembers(orgId, open && canManage);
  const memberIds = useMemo(
    () => new Set((members ?? []).map((member) => member.userId)),
    [members]
  );
  const addableMembers = useMemo(
    () => roster.members.filter((member) => !memberIds.has(member.userId)),
    [roster.members, memberIds]
  );

  const rowActionsFor = useCallback(
    (member: CloudChannelMember): DropdownOption[] => {
      if (!canManage || member.userId === currentUserId) return [];
      return [
        {
          value: "toggle-role",
          label:
            member.role === "manager"
              ? t("cloud.channels.members.removeManager")
              : t("cloud.channels.members.makeManager"),
          dataTestId: `channel-member-action-role-${member.userId}`,
        },
        {
          value: "remove",
          label: t("cloud.channels.members.remove"),
          dataTestId: `channel-member-action-remove-${member.userId}`,
        },
      ];
    },
    [canManage, currentUserId, t]
  );

  return (
    <Modal
      visible={open && channel !== null}
      title={t("cloud.channels.members.title", { name: channel?.name ?? "" })}
      onCancel={onClose}
      footer={
        <PanelFooter
          secondaryActions={[
            {
              label: t("cloud.channels.cancel"),
              onClick: onClose,
              variant: "secondary",
              disabled: mutating,
              dataTestId: "channel-members-cancel",
            },
          ]}
          primaryAction={
            canManage
              ? {
                  label: t("cloud.channels.members.addSubmit"),
                  onClick: handleAddMembers,
                  loading: mutating,
                  disabled: mutating || selectedAddIds.length === 0,
                  dataTestId: "channel-members-add-submit",
                }
              : undefined
          }
        />
      }
      width={480}
    >
      <div
        className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto"
        data-testid="channel-members-dialog"
      >
        <ChannelDialogErrorNotice
          message={
            errorKind === "lastManager"
              ? t("cloud.channels.members.lastManager")
              : errorKind
                ? t("cloud.channels.members.error")
                : null
          }
          testId="channel-members-error"
        />

        {loading && members === null ? (
          <div
            className="text-[12px] text-text-3"
            data-testid="channel-members-loading"
          >
            {t("cloud.channels.members.loading")}
          </div>
        ) : loadFailed && members === null ? (
          <ChannelDialogErrorNotice
            message={t("cloud.channels.members.loadError")}
            testId="channel-members-load-error"
          />
        ) : (members ?? []).length === 0 ? (
          <div className="text-[12px] text-text-3">
            {t("cloud.channels.members.empty")}
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-border-2 rounded-lg border border-border-2">
            {(members ?? []).map((member) => {
              const isSelf = member.userId === currentUserId;
              const displayName = member.displayName ?? member.userId;
              const actions = rowActionsFor(member);
              return (
                <div
                  key={member.userId}
                  className="flex items-center gap-2 px-2.5 py-1.5"
                  data-testid={`channel-member-row-${member.userId}`}
                >
                  <PersonAvatar
                    size={24}
                    name={displayName}
                    src={member.avatarUrl}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text-1">
                    {displayName}
                    {isSelf ? (
                      <span className="ml-1.5 text-[11px] text-text-4">
                        {t("cloud.channels.members.you")}
                      </span>
                    ) : null}
                  </span>
                  {member.role === "manager" ? (
                    <span
                      className="rounded bg-fill-1 px-1.5 py-0.5 text-[10px] font-medium text-text-3"
                      data-testid={`channel-member-manager-badge-${member.userId}`}
                    >
                      {t("cloud.channels.members.managerBadge")}
                    </span>
                  ) : null}
                  {isSelf && channel?.visibility === "private" ? (
                    <Button
                      htmlType="button"
                      variant="secondary"
                      size="small"
                      disabled={mutating}
                      onClick={() => handleRemoveMember(member.userId)}
                      data-testid="channel-member-leave"
                    >
                      {t("cloud.channels.members.leave")}
                    </Button>
                  ) : null}
                  {actions.length > 0 ? (
                    <Dropdown
                      options={actions}
                      position="bottom-end"
                      onSelect={(value) => {
                        if (value === "remove") {
                          handleRemoveMember(member.userId);
                        } else if (value === "toggle-role") {
                          handleToggleRole(member);
                        }
                      }}
                    >
                      <Button
                        htmlType="button"
                        variant="tertiary"
                        appearance="ghost"
                        size="small"
                        disabled={mutating}
                        icon={
                          <HugeiconsIcon
                            icon={MoreHorizontalIcon}
                            data-icon="ellipsis"
                            size={14}
                          />
                        }
                        aria-label={t("cloud.channels.members.actions")}
                        data-testid={`channel-member-actions-${member.userId}`}
                      />
                    </Dropdown>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {canManage ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-text-2">
              {t("cloud.channels.members.addLabel")}
            </span>
            {roster.loading ? (
              <div
                className="text-[11px] text-text-3"
                data-testid="channel-members-add-loading"
              >
                {t("cloud.channels.members.loading")}
              </div>
            ) : addableMembers.length === 0 ? (
              <div className="text-[11px] text-text-3">
                {t("cloud.channels.members.addEmpty")}
              </div>
            ) : (
              <div className="flex max-h-40 flex-col divide-y divide-border-2 overflow-y-auto rounded-lg border border-border-2">
                {addableMembers.map((member) => {
                  const checked = selectedAddIds.includes(member.userId);
                  return (
                    <div
                      key={member.userId}
                      data-testid={`channel-members-add-${member.userId}`}
                    >
                      <Checkbox
                        size="small"
                        className="w-full px-2.5 py-1.5 hover:bg-surface-hover"
                        checked={checked}
                        disabled={
                          !checked &&
                          selectedAddIds.length >=
                            CHANNEL_ADD_MEMBERS_MAX_PER_CALL
                        }
                        onCheckedChange={() => handleToggleAddId(member.userId)}
                      >
                        {member.displayName ?? member.userId}
                      </Checkbox>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </Modal>
  );
};

export default ManageChannelMembersDialog;
