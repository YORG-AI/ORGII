import Modal from "@/src/scaffold/ModalSystem";
import { useAtomValue } from "jotai";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import Button from "@src/components/Button";
import Tooltip from "@src/components/Tooltip";
import CommentThreadList from "@src/features/Org2Cloud/SessionComments/CommentThreadList";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  groupCommentThreads,
  useSessionComments,
} from "@src/features/Org2Cloud/org2CloudSessionCommentsAtom";
import { BookEditIcon, HugeiconsIcon } from "@src/icons";

import type { WebSessionListItem } from "./useWebSessionRoster";

const noopAsync = async () => undefined;

export interface WebSessionCommentsHeaderExtrasProps {
  session: WebSessionListItem;
}

interface WebSessionCommentsModalBodyProps {
  session: WebSessionListItem;
}

const WebSessionCommentsModalBody: React.FC<
  WebSessionCommentsModalBodyProps
> = ({ session }) => {
  const { t } = useTranslation("navigation");
  const { comments, state } = useSessionComments(
    session.orgId,
    session.sourceSessionId,
    null
  );
  const grouped = useMemo(
    () => groupCommentThreads(comments, new Set()),
    [comments]
  );

  return (
    <div
      className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto"
      data-testid="web-session-comment-thread"
    >
      <CommentThreadList
        threads={grouped.sessionLevel}
        viewerUserId={null}
        viewerIsAdmin={false}
        readOnly
        showComposer={false}
        emptyLabel={
          state === "error"
            ? t("cloud.comments.loadError")
            : t("web.sessionPage.notesEmpty", {
                defaultValue: t("cloud.comments.empty"),
              })
        }
        onAdd={noopAsync}
        onEdit={noopAsync}
        onDelete={noopAsync}
        onResolve={noopAsync}
      />
      {grouped.orphaned.length > 0 && (
        <div
          className="flex flex-col gap-2 border-t border-border-1 pt-2"
          data-testid="web-session-comment-orphans"
        >
          <div className="text-[11px] text-text-3">
            {t("cloud.comments.earlierVersion")}
          </div>
          <CommentThreadList
            threads={grouped.orphaned}
            viewerUserId={null}
            viewerIsAdmin={false}
            readOnly
            showComposer={false}
            onAdd={noopAsync}
            onEdit={noopAsync}
            onDelete={noopAsync}
            onResolve={noopAsync}
          />
        </div>
      )}
    </div>
  );
};

const WebSessionCommentsHeaderExtras: React.FC<
  WebSessionCommentsHeaderExtrasProps
> = ({ session }) => {
  const { t } = useTranslation("navigation");
  const auth = useAtomValue(org2CloudAuthAtom);
  const [searchParams, setSearchParams] = useSearchParams();
  const notesFromQuery = searchParams.get("notes") === "1";
  const [panelOpen, setPanelOpen] = useState(false);
  const open = notesFromQuery || panelOpen;
  const unresolvedCount = session.unresolvedCommentCount ?? 0;
  const badgeCount = unresolvedCount;

  const openNotes = useCallback(() => setPanelOpen(true), []);
  const closeNotes = useCallback(() => {
    setPanelOpen(false);
    if (searchParams.get("notes") === "1") {
      const next = new URLSearchParams(searchParams);
      next.delete("notes");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  if (!auth) return null;

  const buttonLabel = t("web.sessionPage.notesButton", {
    defaultValue: t("cloud.comments.notesButton"),
  });

  return (
    <>
      <Tooltip
        content={buttonLabel}
        position="bottom-end"
        mouseEnterDelay={200}
        framedPanel
      >
        <span className="relative inline-flex">
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            onClick={openNotes}
            aria-label={buttonLabel}
            data-testid="web-session-notes-button"
            icon={
              <HugeiconsIcon
                icon={BookEditIcon}
                data-icon="sticky-note"
                size={14}
                strokeWidth={2}
              />
            }
          />
          {badgeCount > 0 && (
            <span
              className="pointer-events-none absolute -top-0.5 -right-0.5 inline-flex h-[13px] min-w-[13px] items-center justify-center rounded-full bg-primary-6 px-0.5 text-[9px] leading-none font-medium text-white"
              data-testid="web-session-notes-count"
            >
              {badgeCount}
            </span>
          )}
        </span>
      </Tooltip>
      <Modal
        visible={open}
        title={t("web.sessionPage.notesTitle", {
          defaultValue: t("cloud.comments.notesTitle"),
        })}
        onCancel={closeNotes}
        footer={null}
        width={640}
      >
        {open ? <WebSessionCommentsModalBody session={session} /> : null}
      </Modal>
    </>
  );
};

export default WebSessionCommentsHeaderExtras;
