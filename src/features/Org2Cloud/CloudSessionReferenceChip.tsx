/**
 * Inline chip for an ORG2 Cloud session reference found in rendered
 * markdown — a GitHub issue body, a PR description, a chat message.
 *
 * Reuses the read-only chat pill shell so a reference reads like every
 * other inline reference in the app, and shows the session's real name
 * whenever the viewer already has it — the org listing they loaded as a
 * member, or the local session if it is theirs. Nothing is fetched for the
 * label, so a viewer without access simply sees the generic wording: the
 * name is available exactly when the viewer is entitled to it.
 */
import { useAtomValue } from "jotai";
import { Users } from "lucide-react";
import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import BasePill from "@src/components/ComposerInput/BasePill";
import { truncateVisiblePillLabel } from "@src/components/ComposerInput/utils";
import { PILL_SIZE } from "@src/config/pillTokens";
import { sessionsAtom } from "@src/store/session";

import type { CloudSessionReference } from "./cloudSessionReference";
import { org2CloudRemoteSessionsAtom } from "./org2CloudRemoteSessionsAtom";
import { resolveSessionReferenceTitle } from "./resolveSessionReferenceTitle";
import { useOpenCloudSessionReference } from "./useOpenCloudSessionReference";

const ICON_PROPS = {
  size: PILL_SIZE.iconSize,
  strokeWidth: 1.75,
  "aria-hidden": true,
} as const;
const SHORT_ID_LENGTH = 8;

export const CloudSessionReferenceChip = memo(
  function CloudSessionReferenceChip({
    reference,
  }: {
    reference: CloudSessionReference;
  }) {
    const { t } = useTranslation("navigation");
    const openReference = useOpenCloudSessionReference();
    const remoteEntries = useAtomValue(org2CloudRemoteSessionsAtom);
    const sessions = useAtomValue(sessionsAtom);

    const title = useMemo(
      () =>
        resolveSessionReferenceTitle({
          reference,
          orgRows: remoteEntries[reference.orgId]?.rows,
          localTitle: sessions.find(
            (session) => session.session_id === reference.sourceSessionId
          )?.name,
        }),
      [reference, remoteEntries, sessions]
    );

    const handleClick = useCallback(
      (event: React.SyntheticEvent) => {
        event.preventDefault();
        event.stopPropagation();
        openReference(reference, { autoReplay: true });
      },
      [openReference, reference]
    );

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        handleClick(event);
      },
      [handleClick]
    );

    const shortId = reference.sourceSessionId.slice(-SHORT_ID_LENGTH);
    const label = title
      ? truncateVisiblePillLabel(title)
      : `${t("cloud.sessionRef.chipLabel")} ${shortId}`;
    // The untruncated name belongs in the tooltip, not the inline label.
    const tooltip = title ?? label;

    return (
      <BasePill
        variant="display"
        iconNode={<Users {...ICON_PROPS} />}
        role="button"
        tabIndex={0}
        title={tooltip}
        style={{ cursor: "var(--interactive-cursor, pointer)" }}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        <span>{label}</span>
      </BasePill>
    );
  }
);
