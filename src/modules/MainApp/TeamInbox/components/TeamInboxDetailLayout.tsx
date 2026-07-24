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
  metadata: InfoCardRow[];
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

    <div className={DETAIL_PANEL_TOKENS.scrollContent}>
      <div className={DETAIL_PANEL_TOKENS.contentWidthWithPadding}>
        {children ? (
          <div className={DETAIL_PANEL_TOKENS.sectionGap}>{children}</div>
        ) : null}
        <InfoCard rows={metadata} variant="plain" />
      </div>
    </div>

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
