import type { TFunction } from "i18next";
import React from "react";

import { SessionTable } from "@src/modules/shared/layouts/blocks";
import type { SessionTableItem } from "@src/modules/shared/layouts/blocks";
import type { CollabSessionSnapshotRequestRecord } from "@src/store/collaboration/types";

import { COLLAB_SNAPSHOT_REQUEST_STATUS } from "./constants";

interface SessionsSectionProps {
  t: TFunction<"navigation">;
  sessionItems: SessionTableItem[];
  latestSnapshotRequest: CollabSessionSnapshotRequestRecord | undefined;
  onSelectSession: (item: SessionTableItem) => void;
}

export function SessionsSection({
  t,
  sessionItems,
  latestSnapshotRequest,
  onSelectSession,
}: SessionsSectionProps) {
  const showPendingMessage =
    latestSnapshotRequest?.status === COLLAB_SNAPSHOT_REQUEST_STATUS.PENDING ||
    latestSnapshotRequest?.status === COLLAB_SNAPSHOT_REQUEST_STATUS.SENT;

  return (
    <>
      <SessionTable
        items={sessionItems}
        onSelect={onSelectSession}
        showSearch
        surfaceVariant="chatPanel"
        maxHeight={520}
        pageSize={10}
        pageSizeOptions={[10, 25, 50]}
      />
      {showPendingMessage ? (
        <div className="rounded-lg bg-fill-1 px-3 py-2 text-[12px] text-text-3">
          {t("collaboration.access.requestPending")}
        </div>
      ) : null}
      {latestSnapshotRequest?.error ? (
        <div className="rounded-lg bg-danger-1 px-3 py-2 text-[12px] text-danger-6">
          {latestSnapshotRequest.error}
        </div>
      ) : null}
    </>
  );
}
