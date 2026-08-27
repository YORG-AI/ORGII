/**
 * DeleteLocalChannelDialog — destructive confirm for the HARD local-channel
 * delete (irreversible; the row is removed from this machine's store).
 * Mirrors the cloud `DeleteChannelDialog`: the danger action stays disabled
 * until the acknowledgement checkbox is checked.
 *
 * The acknowledgement must be per-open and per-channel — the mounting parent
 * guarantees that by KEYING this dialog on open-state + channel id
 * (`localChannelsSection.tsx`), so a fresh mount resets the checkbox without
 * any reset-in-effect (`react-hooks/set-state-in-effect`-safe).
 */
import Modal from "@/src/scaffold/ModalSystem";
import { useSetAtom } from "jotai";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  ChannelDeleteConfirmation,
  ChannelDialogErrorNotice,
  ChannelDialogFooter,
} from "@src/features/DiscussionChannels/components/ChannelDialogPrimitives";
import {
  type LocalChannel,
  deleteLocalChannelAtom,
} from "@src/store/ui/localChannelsAtom";

export interface DeleteLocalChannelDialogProps {
  open: boolean;
  channel: LocalChannel | null;
  onClose: () => void;
}

const DeleteLocalChannelDialog: React.FC<DeleteLocalChannelDialogProps> = ({
  open,
  channel,
  onClose,
}) => {
  const { t } = useTranslation("navigation");
  const deleteChannel = useSetAtom(deleteLocalChannelAtom);
  const [acknowledged, setAcknowledged] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleDelete = useCallback(() => {
    if (!channel || !acknowledged) return;
    setFailed(false);
    const result = deleteChannel(channel.id);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    onClose();
  }, [channel, acknowledged, deleteChannel, onClose]);

  return (
    <Modal
      visible={open && channel !== null}
      title={t("cloud.channels.delete.title", { name: channel?.name ?? "" })}
      onCancel={onClose}
      footer={
        <ChannelDialogFooter
          cancelLabel={t("cloud.channels.cancel")}
          submitLabel={t("cloud.channels.delete.confirm")}
          onCancel={onClose}
          onSubmit={handleDelete}
          cancelTestId="local-channel-delete-cancel"
          submitTestId="local-channel-delete-confirm"
          submitVariant="danger"
          disabled={!acknowledged || !channel}
        />
      }
      width={440}
    >
      <div
        className="flex flex-col gap-3"
        data-testid="local-channel-delete-dialog"
      >
        <ChannelDeleteConfirmation
          warning={t("cloud.channels.local.deleteWarning")}
          acknowledgement={t("cloud.channels.delete.acknowledge")}
          checked={acknowledged}
          onCheckedChange={setAcknowledged}
          acknowledgeTestId="local-channel-delete-acknowledge"
        />

        <ChannelDialogErrorNotice
          message={failed ? t("cloud.channels.delete.error") : null}
          testId="local-channel-delete-error"
        />
      </div>
    </Modal>
  );
};

export default DeleteLocalChannelDialog;
