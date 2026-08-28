import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import type { WorkItemHandoff } from "@src/api/http/project";
import Button from "@src/components/Button";
import Textarea from "@src/components/Textarea";
import {
  ArrowLeft02Icon,
  Clock03Icon,
  HugeiconsIcon,
  Tick01Icon,
  UserRoundCheckIcon,
} from "@src/icons";
import Modal from "@src/scaffold/ModalSystem";

interface WorkItemHandoffNoticeProps {
  handoff: WorkItemHandoff;
  canRespond: boolean;
  error?: string | null;
  unavailableReason?: string;
  responding?: "accept" | "return" | null;
  onAccept: () => void;
  onReturn: (reason: string) => void;
}

const WorkItemHandoffNotice: React.FC<WorkItemHandoffNoticeProps> = ({
  handoff,
  canRespond,
  error,
  unavailableReason,
  responding,
  onAccept,
  onReturn,
}) => {
  const { t } = useTranslation();
  const [returnOpen, setReturnOpen] = useState(false);
  const [reason, setReason] = useState("");
  const canAct = handoff.status === "pending" && canRespond;

  const icon =
    handoff.status === "accepted" ? (
      <HugeiconsIcon
        icon={UserRoundCheckIcon}
        data-icon="user-round-check"
        size={16}
        aria-hidden
      />
    ) : handoff.status === "returned" ? (
      <HugeiconsIcon
        icon={ArrowLeft02Icon}
        data-icon="arrow-left"
        size={16}
        aria-hidden
      />
    ) : (
      <HugeiconsIcon
        icon={Clock03Icon}
        data-icon="clock-3"
        size={16}
        aria-hidden
      />
    );
  const title =
    handoff.status === "accepted"
      ? t("teamInbox.handoff.acceptedTitle", {
          name: handoff.recipientName,
        })
      : handoff.status === "returned"
        ? t("teamInbox.handoff.returnedTitle", {
            name: handoff.recipientName,
          })
        : t("teamInbox.handoff.pendingTitle", {
            name: handoff.senderName,
          });
  const detail =
    handoff.status === "returned"
      ? handoff.responseNote
      : handoff.note || t("teamInbox.handoff.noNote");

  return (
    <>
      <section
        data-testid="work-item-handoff-notice"
        className="flex w-full flex-wrap items-start gap-3 rounded-xl border border-border-2 bg-bg-2 px-4 py-3"
        aria-label={t("teamInbox.handoff.statusLabel")}
      >
        <span
          className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ${
            handoff.status === "returned"
              ? "bg-warning-6/10 text-warning-6"
              : handoff.status === "accepted"
                ? "bg-success-6/10 text-success-6"
                : "bg-primary-6/10 text-primary-6"
          }`}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-1">{title}</p>
          {detail ? (
            <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-text-3">
              {detail}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-2 text-xs text-danger-6">
              {error}
            </p>
          ) : null}
          {unavailableReason ? (
            <p role="status" className="mt-2 text-xs text-warning-6">
              {unavailableReason}
            </p>
          ) : null}
        </div>
        {canAct ? (
          <div className="ml-11 flex w-full items-center justify-end gap-2">
            <Button
              variant="secondary"
              size="mini"
              onClick={() => setReturnOpen(true)}
              disabled={responding != null}
            >
              {t("teamInbox.handoff.return")}
            </Button>
            <Button
              variant="primary"
              size="mini"
              icon={
                <HugeiconsIcon
                  icon={Tick01Icon}
                  data-icon="check"
                  size={14}
                  aria-hidden
                />
              }
              onClick={onAccept}
              loading={responding === "accept"}
              disabled={responding != null}
            >
              {t("teamInbox.handoff.accept")}
            </Button>
          </div>
        ) : null}
      </section>

      <Modal
        visible={returnOpen}
        title={t("teamInbox.handoff.returnTitle")}
        width={460}
        onCancel={() => setReturnOpen(false)}
        onOk={() => {
          const trimmed = reason.trim();
          if (!trimmed) return;
          onReturn(trimmed);
          setReturnOpen(false);
          setReason("");
        }}
        okText={t("teamInbox.handoff.confirmReturn")}
        cancelText={t("common:actions.cancel")}
        okButtonProps={{
          status: "warning",
          disabled: !reason.trim(),
          loading: responding === "return",
        }}
        cancelButtonProps={{ disabled: responding === "return" }}
        maskClosable={responding !== "return"}
        escToExit={responding !== "return"}
      >
        <div className="flex flex-col gap-2 p-4">
          <p className="text-xs leading-5 text-text-3">
            {t("teamInbox.handoff.returnHint", {
              name: handoff.senderName,
            })}
          </p>
          <Textarea
            value={reason}
            onChange={setReason}
            maxLength={500}
            showWordLimit
            autoSize={{ minRows: 3, maxRows: 6 }}
            resize="none"
            placeholder={t("teamInbox.handoff.returnPlaceholder")}
            disabled={responding === "return"}
          />
        </div>
      </Modal>
    </>
  );
};

export default WorkItemHandoffNotice;
