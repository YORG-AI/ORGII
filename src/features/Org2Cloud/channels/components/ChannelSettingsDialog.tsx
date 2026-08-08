/**
 * ChannelSettingsDialog — rename / topic / post-policy editing for a cloud
 * org channel (0014 `cloud_update_channel`). Callers gate the entry point to
 * channel managers / org admins; the server re-checks and the
 * `ORG2_CHANNEL_MANAGER_REQUIRED` refusal surfaces as a dedicated inline
 * error. Shares the `LocalChannelSettingsDialog` layout, plus the cloud-only
 * "who can post" select.
 *
 * Only fields that actually changed are sent (`cloud_update_channel` treats
 * null as no-change; an empty topic string clears it). On success bumps the
 * per-org channels version so listings refetch. Failures NEVER clear the
 * form.
 *
 * The form seeds from the target channel at MOUNT (`useState` initializers):
 * the mounting parent KEYS this dialog on open-state + channel id
 * (`channelsSection.tsx`), so every open is a fresh mount with a fresh seed
 * — no reset-in-effect (`react-hooks/set-state-in-effect`-safe).
 */
import Modal, { MODAL_SELECT_Z_INDEX } from "@/src/scaffold/ModalSystem";
import { useSetAtom } from "jotai";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Select from "@src/components/Select";
import {
  normalizeChannelName,
  validateChannelName,
} from "@src/features/DiscussionChannels/channelContract";
import {
  ChannelDialogErrorNotice,
  ChannelDialogFooter,
  ChannelFieldLabel,
  ChannelNameField,
  ChannelTopicField,
} from "@src/features/DiscussionChannels/components/ChannelDialogPrimitives";

import { bumpOrg2CloudChannelsVersionAtom } from "../channelsAtom";
import { isOrg2ChannelsErrorCode, updateCloudChannel } from "../channelsClient";
import type { CloudChannel, CloudChannelPostPolicy } from "../types";
import { useFreshChannelAccessToken } from "./useChannelDialogAccess";

type SettingsErrorKind = "nameTaken" | "managerRequired" | "generic";

export interface ChannelSettingsDialogProps {
  open: boolean;
  orgId: string | null;
  channel: CloudChannel | null;
  onClose: () => void;
}

const ChannelSettingsDialog: React.FC<ChannelSettingsDialogProps> = ({
  open,
  orgId,
  channel,
  onClose,
}) => {
  const { t } = useTranslation("navigation");
  const bumpChannelsVersion = useSetAtom(bumpOrg2CloudChannelsVersionAtom);
  const getFreshAccessToken = useFreshChannelAccessToken();

  // Seeded once per mount — the parent's key makes each open a fresh mount.
  const [name, setName] = useState(() => channel?.name ?? "");
  const [topic, setTopic] = useState(() => channel?.topic ?? "");
  const [postPolicy, setPostPolicy] = useState<CloudChannelPostPolicy>(
    () => channel?.postPolicy ?? "everyone"
  );
  const [submitting, setSubmitting] = useState(false);
  const [errorKind, setErrorKind] = useState<SettingsErrorKind | null>(null);

  const normalizedName = normalizeChannelName(name);
  const canSubmit =
    open &&
    orgId !== null &&
    channel !== null &&
    normalizedName.length > 0 &&
    !submitting;

  const handleSubmit = useCallback(async () => {
    if (!orgId || !channel || submitting) return;
    const submittedName = normalizeChannelName(name);
    if (validateChannelName(submittedName) !== null) return;
    const trimmedTopic = topic.trim();
    const nameChanged = submittedName !== channel.name;
    const topicChanged = trimmedTopic !== (channel.topic ?? "");
    const postPolicyChanged = postPolicy !== channel.postPolicy;
    if (!nameChanged && !topicChanged && !postPolicyChanged) {
      onClose();
      return;
    }
    setSubmitting(true);
    setErrorKind(null);
    try {
      const accessToken = await getFreshAccessToken();
      await updateCloudChannel(accessToken, orgId, channel.id, {
        name: nameChanged ? submittedName : undefined,
        // Empty string clears the topic (0014 contract).
        topic: topicChanged ? trimmedTopic : undefined,
        postPolicy: postPolicyChanged ? postPolicy : undefined,
      });
      bumpChannelsVersion(orgId);
      onClose();
    } catch (caught) {
      // The form is intentionally left untouched on every failure path.
      if (isOrg2ChannelsErrorCode(caught, "ORG2_CONFLICT")) {
        setErrorKind("nameTaken");
      } else if (
        isOrg2ChannelsErrorCode(caught, "ORG2_CHANNEL_MANAGER_REQUIRED")
      ) {
        setErrorKind("managerRequired");
      } else {
        setErrorKind("generic");
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    orgId,
    channel,
    submitting,
    name,
    topic,
    postPolicy,
    getFreshAccessToken,
    bumpChannelsVersion,
    onClose,
  ]);

  const postPolicyOptions = useMemo(
    () => [
      {
        value: "everyone",
        label: t("cloud.channels.create.postPolicyEveryone"),
        dataTestId: "channel-settings-post-policy-everyone",
      },
      {
        value: "managers",
        label: t("cloud.channels.create.postPolicyManagers"),
        dataTestId: "channel-settings-post-policy-managers",
      },
    ],
    [t]
  );

  let errorMessage: string | null = null;
  if (errorKind === "nameTaken") {
    errorMessage = t("cloud.channels.create.nameTaken");
  } else if (errorKind === "managerRequired") {
    errorMessage = t("cloud.channels.settings.managerRequired");
  } else if (errorKind === "generic") {
    errorMessage = t("cloud.channels.settings.error");
  }

  return (
    <Modal
      visible={open && channel !== null}
      title={t("cloud.channels.settings.title", { name: channel?.name ?? "" })}
      onCancel={onClose}
      footer={
        <ChannelDialogFooter
          cancelLabel={t("cloud.channels.cancel")}
          submitLabel={t("cloud.channels.settings.submit")}
          onCancel={onClose}
          onSubmit={() => void handleSubmit()}
          cancelTestId="channel-settings-cancel"
          submitTestId="channel-settings-submit"
          loading={submitting}
          disabled={!canSubmit}
        />
      }
      width={480}
    >
      <div
        className="flex flex-col gap-3"
        data-testid="channel-settings-dialog"
      >
        <ChannelNameField
          autoFocus
          value={name}
          onChange={setName}
          testId="channel-settings-name"
        />

        <ChannelTopicField
          value={topic}
          onChange={setTopic}
          testId="channel-settings-topic"
        />

        <div className="flex flex-col gap-1.5">
          <ChannelFieldLabel>
            {t("cloud.channels.create.postPolicyLabel")}
          </ChannelFieldLabel>
          <Select
            value={postPolicy}
            options={postPolicyOptions}
            onChange={(value) => setPostPolicy(value as CloudChannelPostPolicy)}
            size="default"
            panelZIndex={MODAL_SELECT_Z_INDEX}
            dataTestId="channel-settings-post-policy"
          />
        </div>

        <ChannelDialogErrorNotice
          message={errorMessage}
          testId="channel-settings-error"
        />
      </div>
    </Modal>
  );
};

export default ChannelSettingsDialog;
