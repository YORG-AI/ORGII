/**
 * CreateChannelDialog — Lark-inspired channel creation for a managed cloud
 * org (0014 control plane).
 *
 * Name input live-normalizes via `normalizeChannelNameInput` (lowercase,
 * leading '#' stripped, spaces → hyphens) behind a literal '#' adornment;
 * visibility is a public/private radio group; the private branch shows a
 * two-pane member picker off the shared roster coordinator (creator excluded
 * — the server adds them as manager); "who can post" maps to `postPolicy`. On
 * success bumps the per-org channels version so every listing refetches.
 * Failures NEVER clear the form — the inline error distinguishes name-taken
 * (`ORG2_CONFLICT`) and org quota (`ORG2_QUOTA_EXCEEDED`) from the generic
 * case.
 */
import Modal, { MODAL_SELECT_Z_INDEX } from "@/src/scaffold/ModalSystem";
import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Avatar from "@src/components/Avatar";
import Checkbox from "@src/components/Checkbox";
import Radio from "@src/components/Radio";
import Select from "@src/components/Select";
import {
  normalizeChannelName,
  validateChannelName,
} from "@src/features/DiscussionChannels/channelContract";
import {
  ChannelDialogErrorNotice,
  ChannelDialogFooter,
  ChannelNameField,
  ChannelTopicField,
} from "@src/features/DiscussionChannels/components/ChannelDialogPrimitives";

import { org2CloudAuthAtom } from "../../org2CloudAuthAtom";
import { bumpOrg2CloudChannelsVersionAtom } from "../channelsAtom";
import { createCloudChannel, isOrg2ChannelsErrorCode } from "../channelsClient";
import type { CloudChannelPostPolicy, CloudChannelVisibility } from "../types";
import { CHANNEL_ADD_MEMBERS_MAX_PER_CALL } from "../types";
import {
  useActiveOrgMembers,
  useFreshChannelAccessToken,
} from "./useChannelDialogAccess";

type CreateChannelErrorKind = "nameTaken" | "quotaExceeded" | "generic";

export interface CreateChannelDialogProps {
  open: boolean;
  orgId: string | null;
  onClose: () => void;
}

const CreateChannelDialog: React.FC<CreateChannelDialogProps> = ({
  open,
  orgId,
  onClose,
}) => {
  const { t } = useTranslation("navigation");
  const currentUserId = useAtomValue(org2CloudAuthAtom)?.userId ?? null;
  const bumpChannelsVersion = useSetAtom(bumpOrg2CloudChannelsVersionAtom);
  const getFreshAccessToken = useFreshChannelAccessToken();

  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [visibility, setVisibility] = useState<CloudChannelVisibility>("org");
  const [postPolicy, setPostPolicy] =
    useState<CloudChannelPostPolicy>("everyone");
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errorKind, setErrorKind] = useState<CreateChannelErrorKind | null>(
    null
  );

  const roster = useActiveOrgMembers(orgId, open && visibility === "private");
  // The creator is added as manager server-side; never offer them as a pick.
  const selectableMembers = useMemo(
    () => roster.members.filter((member) => member.userId !== currentUserId),
    [roster.members, currentUserId]
  );
  const selectedMemberIdSet = useMemo(
    () => new Set(selectedMemberIds),
    [selectedMemberIds]
  );
  const selectedMembers = useMemo(
    () =>
      selectableMembers.filter((member) =>
        selectedMemberIdSet.has(member.userId)
      ),
    [selectableMembers, selectedMemberIdSet]
  );

  const normalizedName = normalizeChannelName(name);
  const canSubmit =
    open && orgId !== null && normalizedName.length > 0 && !submitting;

  const handleToggleMember = useCallback((userId: string) => {
    setSelectedMemberIds((current) =>
      current.includes(userId)
        ? current.filter((id) => id !== userId)
        : [...current, userId]
    );
  }, []);

  const resetForm = useCallback(() => {
    setName("");
    setTopic("");
    setVisibility("org");
    setPostPolicy("everyone");
    setSelectedMemberIds([]);
    setErrorKind(null);
  }, []);

  const handleClose = useCallback(() => {
    setErrorKind(null);
    onClose();
  }, [onClose]);

  const handleSubmit = useCallback(async () => {
    if (!orgId || submitting) return;
    const submittedName = normalizeChannelName(name);
    if (validateChannelName(submittedName) !== null) return;
    setSubmitting(true);
    setErrorKind(null);
    try {
      const accessToken = await getFreshAccessToken();
      const trimmedTopic = topic.trim();
      await createCloudChannel(accessToken, orgId, {
        name: submittedName,
        topic: trimmedTopic.length > 0 ? trimmedTopic : undefined,
        visibility,
        postPolicy,
        memberUserIds:
          visibility === "private" && selectedMemberIds.length > 0
            ? selectedMemberIds
            : undefined,
      });
      bumpChannelsVersion(orgId);
      resetForm();
      onClose();
    } catch (caught) {
      // The form is intentionally left untouched on every failure path.
      if (isOrg2ChannelsErrorCode(caught, "ORG2_CONFLICT")) {
        setErrorKind("nameTaken");
      } else if (isOrg2ChannelsErrorCode(caught, "ORG2_QUOTA_EXCEEDED")) {
        setErrorKind("quotaExceeded");
      } else {
        setErrorKind("generic");
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    orgId,
    submitting,
    name,
    topic,
    visibility,
    postPolicy,
    selectedMemberIds,
    getFreshAccessToken,
    bumpChannelsVersion,
    resetForm,
    onClose,
  ]);

  const postPolicyOptions = useMemo(
    () => [
      {
        value: "everyone",
        label: t("cloud.channels.create.postPolicyEveryone"),
        dataTestId: "channel-create-post-policy-everyone",
      },
      {
        value: "managers",
        label: t("cloud.channels.create.postPolicyManagers"),
        dataTestId: "channel-create-post-policy-managers",
      },
    ],
    [t]
  );

  let errorMessage: string | null = null;
  if (errorKind === "nameTaken") {
    errorMessage = t("cloud.channels.create.nameTaken");
  } else if (errorKind === "quotaExceeded") {
    errorMessage = t("cloud.channels.create.quotaExceeded");
  } else if (errorKind === "generic") {
    errorMessage = t("cloud.channels.create.error");
  }

  return (
    <Modal
      visible={open}
      title={t("cloud.channels.create.title")}
      onCancel={handleClose}
      footer={
        <ChannelDialogFooter
          cancelLabel={t("cloud.channels.cancel")}
          submitLabel={t("cloud.channels.create.submit")}
          onCancel={handleClose}
          onSubmit={() => void handleSubmit()}
          cancelTestId="channel-create-cancel"
          submitTestId="channel-create-submit"
          loading={submitting}
          disabled={!canSubmit}
        />
      }
      bodyClassName="p-0"
      width={760}
    >
      <div
        className="flex flex-col gap-5 px-5 py-4"
        data-testid="channel-create-dialog"
      >
        <ChannelNameField
          autoFocus
          layout="aligned"
          value={name}
          onChange={setName}
          testId="channel-create-name"
        />

        <ChannelTopicField
          layout="aligned"
          value={topic}
          onChange={setTopic}
          testId="channel-create-topic"
        />

        <div className="grid grid-cols-[112px_minmax(0,1fr)] items-start gap-x-4">
          <span className="pt-1 text-[13px] font-medium text-text-1">
            {t("cloud.channels.create.visibilityLabel")}
          </span>
          <Radio.Group
            value={visibility}
            onChange={(value) => setVisibility(value as CloudChannelVisibility)}
            size="small"
            className="gap-7"
          >
            <div data-testid="channel-create-visibility-org">
              <Radio value="org">
                <span className="flex flex-col">
                  <span>{t("cloud.channels.create.publicTitle")}</span>
                  <span className="text-[11px] font-normal text-text-3">
                    {t("cloud.channels.create.publicDesc")}
                  </span>
                </span>
              </Radio>
            </div>
            <div data-testid="channel-create-visibility-private">
              <Radio value="private">
                <span className="flex flex-col">
                  <span>{t("cloud.channels.create.privateTitle")}</span>
                  <span className="text-[11px] font-normal text-text-3">
                    {t("cloud.channels.create.privateDesc")}
                  </span>
                </span>
              </Radio>
            </div>
          </Radio.Group>
        </div>

        {visibility === "private" ? (
          <div className="grid grid-cols-[112px_minmax(0,1fr)] items-start gap-x-4">
            <span className="pt-2 text-[13px] font-medium text-text-1">
              {t("cloud.channels.create.membersLabel")}
            </span>
            <div className="min-w-0">
              <div className="mb-2 text-[11px] text-text-3">
                {t("cloud.channels.create.membersHint")}
              </div>
              <div className="grid h-72 min-h-0 grid-cols-2 overflow-hidden rounded-xl border border-border-2">
                <div className="flex min-w-0 flex-col border-r border-border-2">
                  <div className="border-b border-border-2 px-3 py-2 text-[12px] font-medium text-text-2">
                    {t("cloud.channels.create.membersLabel")}
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    {roster.loading ? (
                      <div
                        className="px-2 py-1.5 text-[12px] text-text-3"
                        data-testid="channel-create-members-loading"
                      >
                        {t("cloud.channels.create.membersLoading")}
                      </div>
                    ) : selectableMembers.length === 0 ? (
                      <div className="px-2 py-1.5 text-[12px] text-text-3">
                        {t("cloud.channels.create.membersEmpty")}
                      </div>
                    ) : (
                      selectableMembers.map((member) => {
                        const checked = selectedMemberIdSet.has(member.userId);
                        const displayName = member.displayName ?? member.userId;
                        return (
                          <div
                            key={member.userId}
                            data-testid={`channel-create-member-${member.userId}`}
                          >
                            <Checkbox
                              size="small"
                              className="w-full rounded-lg px-2 py-1.5 hover:bg-surface-hover"
                              checked={checked}
                              disabled={
                                !checked &&
                                selectedMemberIds.length >=
                                  CHANNEL_ADD_MEMBERS_MAX_PER_CALL
                              }
                              onCheckedChange={() =>
                                handleToggleMember(member.userId)
                              }
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <Avatar size={28}>
                                  {displayName.slice(0, 1).toUpperCase()}
                                </Avatar>
                                <span className="truncate text-[13px] text-text-1">
                                  {displayName}
                                </span>
                              </span>
                            </Checkbox>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
                <div className="flex min-w-0 flex-col">
                  <div
                    className="flex items-center gap-1 border-b border-border-2 px-3 py-2 text-[12px] font-medium text-text-2"
                    data-testid="channel-create-selected-count"
                  >
                    <span>{t("cloud.channels.create.membersLabel")}</span>
                    <span className="tabular-nums text-text-3">
                      ({selectedMembers.length})
                    </span>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    {selectedMembers.map((member) => {
                      const displayName = member.displayName ?? member.userId;
                      return (
                        <div
                          key={member.userId}
                          className="flex items-center gap-2 rounded-lg px-2 py-1.5"
                          data-testid={`channel-create-selected-member-${member.userId}`}
                        >
                          <Avatar size={28}>
                            {displayName.slice(0, 1).toUpperCase()}
                          </Avatar>
                          <span className="min-w-0 flex-1 truncate text-[13px] text-text-1">
                            {displayName}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-[112px_minmax(0,1fr)] items-center gap-x-4">
          <span className="text-[13px] font-medium text-text-1">
            {t("cloud.channels.create.postPolicyLabel")}
          </span>
          <Select
            value={postPolicy}
            options={postPolicyOptions}
            onChange={(value) => setPostPolicy(value as CloudChannelPostPolicy)}
            size="default"
            panelZIndex={MODAL_SELECT_Z_INDEX}
            dataTestId="channel-create-post-policy"
          />
        </div>

        {errorMessage ? (
          <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-x-4">
            <span />
            <ChannelDialogErrorNotice
              message={errorMessage}
              testId="channel-create-error"
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
};

export default CreateChannelDialog;
