/** Cloud session owner row, using the shared people-avatar treatment. */
import PersonAvatar from "@src/components/PersonAvatar";
import { WORKSTATION_TRAIL_CONTENT } from "@src/config/workstation/tokens";

import type { FocusedChatSessionContext } from "./types";

export function OwnerIdentityRow({
  compact = false,
  owner,
}: {
  compact?: boolean;
  owner: NonNullable<FocusedChatSessionContext["owner"]>;
}) {
  const displayName = owner.displayName?.trim();
  const identityLabel = displayName || owner.identityId;
  const title =
    displayName && displayName !== owner.identityId
      ? `${identityLabel} · ${owner.identityId}`
      : identityLabel;
  const className = compact
    ? "flex h-8 min-w-0 items-center gap-2 overflow-hidden rounded-md px-2 text-text-1"
    : `${WORKSTATION_TRAIL_CONTENT.row} ${WORKSTATION_TRAIL_CONTENT.rowHorizontalPadding} gap-1.5 overflow-hidden text-text-1`;

  return (
    <div
      className={className}
      title={title}
      data-owner-id={owner.identityId}
      data-testid="session-environment-owner"
    >
      <PersonAvatar
        name={displayName || owner.identityId}
        src={owner.avatarUrl}
        size={14}
      />
      <span
        className={`min-w-0 flex-1 truncate ${
          compact ? "text-[13px]" : "text-[12px]"
        }`}
      >
        {identityLabel}
      </span>
    </div>
  );
}
