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
import { sessionByIdAtom } from "@src/store/session";

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
    interactive = true,
  }: {
    reference: CloudSessionReference;
    /**
     * False renders the same pill as a passive label — no button role, no
     * tab stop, no navigation. Composer previews use this: activating a
     * navigation mid-draft would yank the user out of the text they are
     * writing, and composer pills are non-navigating by convention.
     */
    interactive?: boolean;
  }) {
    const { t } = useTranslation("navigation");
    const openReference = useOpenCloudSessionReference();
    const remoteEntries = useAtomValue(org2CloudRemoteSessionsAtom);
    // Single-session subscription: a chip must not re-render on every
    // sessionsAtom write (agent status churn) just to keep a label fresh.
    const localSession = useAtomValue(
      sessionByIdAtom(reference.sourceSessionId)
    );

    const title = useMemo(
      () =>
        resolveSessionReferenceTitle({
          reference,
          orgRows: remoteEntries[reference.orgId]?.rows,
          localTitle: localSession?.name,
        }),
      [reference, remoteEntries, localSession]
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

    if (!interactive) {
      return (
        <BasePill
          variant="display"
          iconNode={<Users {...ICON_PROPS} />}
          title={tooltip}
        >
          <span>{label}</span>
        </BasePill>
      );
    }

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
