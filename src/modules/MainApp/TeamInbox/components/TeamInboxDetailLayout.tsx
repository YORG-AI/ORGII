import type { LucideIcon } from "lucide-react";
import { Check, Undo2 } from "lucide-react";
import React from "react";

import Button from "@src/components/Button";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  InfoCard,
  PanelFooter,
  PanelHeader,
} from "@src/modules/shared/layouts/blocks";
import type { InfoCardRow } from "@src/modules/shared/layouts/blocks";

export interface TeamInboxDetailLayoutProps {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  /** Key-value rows rendered under the body. Omitted when the body owns its
   *  own property surface (see `contentLayout: "fill"`). */
  metadata?: InfoCardRow[];
  /**
   * `scroll` (default) puts the body in a padded, centred scroll column.
   * `fill` hands it the remaining height untouched, for bodies that manage
   * their own scrolling and side rails.
   */
  contentLayout?: "scroll" | "fill";
  unread: boolean;
  markReadLabel: string;
  markUnreadLabel?: string;
  openLabel: string;
  openIcon: React.ReactNode;
  onMarkRead?: () => void;
  onMarkUnread?: () => void;
  onOpen?: () => void;
  children?: React.ReactNode;
}

const TeamInboxDetailLayout: React.FC<TeamInboxDetailLayoutProps> = ({
  title,
  subtitle,
  icon,
  metadata,
  contentLayout = "scroll",
  unread,
  markReadLabel,
  markUnreadLabel,
  openLabel,
  openIcon,
  onMarkRead,
  onMarkUnread,
  onOpen,
  children,
}) => (
  <DetailPanelContainer>
    <PanelHeader
      title={title}
      subtitle={subtitle}
      icon={icon}
      borderBottom
      actions={
        unread ? (
          onMarkRead ? (
            <Button
              variant="tertiary"
              appearance="ghost"
              size="mini"
              icon={<Check size={14} aria-hidden />}
              onClick={onMarkRead}
            >
              {markReadLabel}
            </Button>
          ) : undefined
        ) : onMarkUnread && markUnreadLabel ? (
          <Button
            variant="tertiary"
            appearance="ghost"
            size="mini"
            icon={<Undo2 size={14} aria-hidden />}
            onClick={onMarkUnread}
          >
            {markUnreadLabel}
          </Button>
        ) : undefined
      }
    />

    {contentLayout === "fill" ? (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    ) : (
      <div className={DETAIL_PANEL_TOKENS.scrollContent}>
        <div className={DETAIL_PANEL_TOKENS.contentWidthWithPadding}>
          {children ? (
            <div className={DETAIL_PANEL_TOKENS.sectionGap}>{children}</div>
          ) : null}
          {metadata && metadata.length > 0 ? (
            <InfoCard rows={metadata} variant="plain" />
          ) : null}
        </div>
      </div>
    )}

    {onOpen ? (
      <PanelFooter
        primaryAction={{
          label: openLabel,
          icon: openIcon,
          onClick: onOpen,
        }}
      />
    ) : null}
  </DetailPanelContainer>
);

export default TeamInboxDetailLayout;
