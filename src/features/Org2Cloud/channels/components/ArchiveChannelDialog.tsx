/**
 * ArchiveChannelDialog — Slack-tone confirm for archiving an org channel
 * (0014 `cloud_archive_channel`). Archiving hides the channel from the
 * sidebar for everyone; history is kept and it can be unarchived later. On
 * success bumps the per-org channels version so listings refetch.
 */
import Modal from "@/src/scaffold/ModalSystem";
import { useSetAtom } from "jotai";
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  ChannelDialogErrorNotice,
  ChannelDialogFooter,
} from "@src/features/DiscussionChannels/components/ChannelDialogPrimitives";

import { bumpOrg2CloudChannelsVersionAtom } from "../channelsAtom";
import {
  archiveCloudChannel,
  isOrg2ChannelsErrorCode,
} from "../channelsClient";
import type { CloudChannel } from "../types";
import { useFreshChannelAccessToken } from "./useChannelDialogAccess";

type ArchiveErrorKind = "managerRequired" | "generic";

export interface ArchiveChannelDialogProps {
  open: boolean;
  orgId: string | null;
  channel: CloudChannel | null;
  onClose: () => void;
}

const ArchiveChannelDialog: React.FC<ArchiveChannelDialogProps> = ({
  open,
  orgId,
  channel,
  onClose,
}) => {
  const { t } = useTranslation("navigation");
  const bumpChannelsVersion = useSetAtom(bumpOrg2CloudChannelsVersionAtom);
  const getFreshAccessToken = useFreshChannelAccessToken();
  const [archiving, setArchiving] = useState(false);
  const [errorKind, setErrorKind] = useState<ArchiveErrorKind | null>(null);

  // A stale error must never greet the next open (or another channel).
  useEffect(() => {
    setErrorKind(null);
  }, [open, channel?.id]);

  const handleArchive = useCallback(async () => {
    if (!orgId || !channel || archiving) return;
    setArchiving(true);
    setErrorKind(null);
    try {
      const accessToken = await getFreshAccessToken();
      await archiveCloudChannel(accessToken, orgId, channel.id);
      bumpChannelsVersion(orgId);
      onClose();
    } catch (caught) {
      setErrorKind(
        isOrg2ChannelsErrorCode(caught, "ORG2_CHANNEL_MANAGER_REQUIRED")
          ? "managerRequired"
          : "generic"
      );
    } finally {
      setArchiving(false);
    }
  }, [
    orgId,
    channel,
    archiving,
    getFreshAccessToken,
    bumpChannelsVersion,
    onClose,
  ]);

  return (
    <Modal
      visible={open && channel !== null}
      title={t("cloud.channels.archive.title", { name: channel?.name ?? "" })}
      onCancel={onClose}
      footer={
        <ChannelDialogFooter
          cancelLabel={t("cloud.channels.cancel")}
          submitLabel={t("cloud.channels.archive.confirm")}
          onCancel={onClose}
          onSubmit={() => void handleArchive()}
          cancelTestId="channel-archive-cancel"
          submitTestId="channel-archive-confirm"
          loading={archiving}
          disabled={archiving || !channel || !orgId}
        />
      }
      width={440}
    >
      <div className="flex flex-col gap-3" data-testid="channel-archive-dialog">
        <div className="text-[12px] text-text-2">
          {t("cloud.channels.archive.body")}
        </div>

        <ChannelDialogErrorNotice
          message={
            errorKind === "managerRequired"
              ? t("cloud.channels.archive.managerRequired")
              : errorKind
                ? t("cloud.channels.archive.error")
                : null
          }
          testId="channel-archive-error"
        />
      </div>
    </Modal>
  );
};

export default ArchiveChannelDialog;
