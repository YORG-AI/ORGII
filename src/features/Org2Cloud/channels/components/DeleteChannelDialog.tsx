/**
 * DeleteChannelDialog — Slack-style destructive confirm for the HARD channel
 * delete (0014 `cloud_delete_channel`, org owner/admin only, irreversible).
 * The danger action stays disabled until the acknowledgement checkbox is
 * checked; `ORG2_ADMIN_REQUIRED` surfaces as a dedicated inline error. On
 * success bumps the per-org channels version so listings refetch.
 */
import Modal from "@/src/scaffold/ModalSystem";
import { useSetAtom } from "jotai";
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  ChannelDeleteConfirmation,
  ChannelDialogErrorNotice,
  ChannelDialogFooter,
} from "@src/features/DiscussionChannels/components/ChannelDialogPrimitives";

import { bumpOrg2CloudChannelsVersionAtom } from "../channelsAtom";
import { deleteCloudChannel, isOrg2ChannelsErrorCode } from "../channelsClient";
import type { CloudChannel } from "../types";
import { useFreshChannelAccessToken } from "./useChannelDialogAccess";

type DeleteErrorKind = "adminRequired" | "generic";

export interface DeleteChannelDialogProps {
  open: boolean;
  orgId: string | null;
  channel: CloudChannel | null;
  onClose: () => void;
}

const DeleteChannelDialog: React.FC<DeleteChannelDialogProps> = ({
  open,
  orgId,
  channel,
  onClose,
}) => {
  const { t } = useTranslation("navigation");
  const bumpChannelsVersion = useSetAtom(bumpOrg2CloudChannelsVersionAtom);
  const getFreshAccessToken = useFreshChannelAccessToken();
  const [acknowledged, setAcknowledged] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errorKind, setErrorKind] = useState<DeleteErrorKind | null>(null);

  // The acknowledgement is per-open and per-channel — never carried over.
  useEffect(() => {
    setAcknowledged(false);
    setErrorKind(null);
  }, [open, channel?.id]);

  const handleDelete = useCallback(async () => {
    if (!orgId || !channel || !acknowledged || deleting) return;
    setDeleting(true);
    setErrorKind(null);
    try {
      const accessToken = await getFreshAccessToken();
      await deleteCloudChannel(accessToken, orgId, channel.id);
      bumpChannelsVersion(orgId);
      onClose();
    } catch (caught) {
      setErrorKind(
        isOrg2ChannelsErrorCode(caught, "ORG2_ADMIN_REQUIRED")
          ? "adminRequired"
          : "generic"
      );
    } finally {
      setDeleting(false);
    }
  }, [
    orgId,
    channel,
    acknowledged,
    deleting,
    getFreshAccessToken,
    bumpChannelsVersion,
    onClose,
  ]);

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
          onSubmit={() => void handleDelete()}
          cancelTestId="channel-delete-cancel"
          submitTestId="channel-delete-confirm"
          submitVariant="danger"
          loading={deleting}
          disabled={!acknowledged || deleting || !channel || !orgId}
        />
      }
      width={440}
    >
      <div className="flex flex-col gap-3" data-testid="channel-delete-dialog">
        <ChannelDeleteConfirmation
          warning={t("cloud.channels.delete.warning")}
          acknowledgement={t("cloud.channels.delete.acknowledge")}
          checked={acknowledged}
          onCheckedChange={setAcknowledged}
          acknowledgeTestId="channel-delete-acknowledge"
        />

        <ChannelDialogErrorNotice
          message={
            errorKind === "adminRequired"
              ? t("cloud.channels.delete.adminRequired")
              : errorKind
                ? t("cloud.channels.delete.error")
                : null
          }
          testId="channel-delete-error"
        />
      </div>
    </Modal>
  );
};

export default DeleteChannelDialog;
