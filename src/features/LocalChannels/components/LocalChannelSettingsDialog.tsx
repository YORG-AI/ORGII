/**
 * LocalChannelSettingsDialog — rename + topic editing for a local channel
 * (the scope-neutral "Channel settings" surface; the cloud counterpart is
 * `ChannelSettingsDialog` with the extra post-policy select).
 *
 * The form seeds from the target channel at MOUNT (`useState` initializers):
 * the mounting parent KEYS this dialog on open-state + channel id
 * (`localChannelsSection.tsx`), so every open is a fresh mount with a fresh
 * seed — no reset-in-effect (`react-hooks/set-state-in-effect`-safe). It
 * submits through the synchronous `updateLocalChannelAtom` reducer and is
 * NEVER cleared on a failure path — "name taken" surfaces inline exactly
 * like the create dialog.
 */
import Modal from "@/src/scaffold/ModalSystem";
import { useSetAtom } from "jotai";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { normalizeChannelName } from "@src/features/DiscussionChannels/channelContract";
import {
  ChannelDialogErrorNotice,
  ChannelDialogFooter,
  ChannelNameField,
  ChannelTopicField,
} from "@src/features/DiscussionChannels/components/ChannelDialogPrimitives";
import {
  type LocalChannel,
  type LocalChannelErrorCode,
  updateLocalChannelAtom,
} from "@src/store/ui/localChannelsAtom";

export interface LocalChannelSettingsDialogProps {
  open: boolean;
  channel: LocalChannel | null;
  onClose: () => void;
}

const LocalChannelSettingsDialog: React.FC<LocalChannelSettingsDialogProps> = ({
  open,
  channel,
  onClose,
}) => {
  const { t } = useTranslation("navigation");
  const updateChannel = useSetAtom(updateLocalChannelAtom);

  // Seeded once per mount — the parent's key makes each open a fresh mount.
  const [name, setName] = useState(() => channel?.name ?? "");
  const [topic, setTopic] = useState(() => channel?.topic ?? "");
  const [errorCode, setErrorCode] = useState<LocalChannelErrorCode | null>(
    null
  );

  const normalizedName = normalizeChannelName(name);
  const canSubmit = open && channel !== null && normalizedName.length > 0;

  const handleSubmit = useCallback(() => {
    if (!channel) return;
    setErrorCode(null);
    // Empty topic string intentionally clears it (0014 update contract).
    const result = updateChannel({ id: channel.id, name, topic });
    if (!result.ok) {
      // The form is intentionally left untouched on every failure path.
      setErrorCode(result.error);
      return;
    }
    onClose();
  }, [channel, updateChannel, name, topic, onClose]);

  const errorMessage =
    errorCode === "nameTaken"
      ? t("cloud.channels.create.nameTaken")
      : errorCode !== null
        ? t("cloud.channels.settings.error")
        : null;

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
          onSubmit={handleSubmit}
          cancelTestId="local-channel-settings-cancel"
          submitTestId="local-channel-settings-submit"
          disabled={!canSubmit}
        />
      }
      width={480}
    >
      <div
        className="flex flex-col gap-3"
        data-testid="local-channel-settings-dialog"
      >
        <ChannelNameField
          autoFocus
          value={name}
          onChange={setName}
          testId="local-channel-settings-name"
        />

        <ChannelTopicField
          value={topic}
          onChange={setTopic}
          testId="local-channel-settings-topic"
        />

        <ChannelDialogErrorNotice
          message={errorMessage}
          testId="local-channel-settings-error"
        />
      </div>
    </Modal>
  );
};

export default LocalChannelSettingsDialog;
