import React from "react";

import Button from "@src/components/Button";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import {
  HugeiconsIcon,
  type IconSvgElement,
  Mail01Icon,
  Tick01Icon,
} from "@src/icons";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  InfoCard,
  PanelFooter,
  PanelHeader,
} from "@src/modules/shared/layouts/blocks";
import type { InfoCardRow } from "@src/modules/shared/layouts/blocks";

import TeamInboxHeaderIconAction from "./TeamInboxHeaderIconAction";
import type { TeamInboxHeaderIconActionProps } from "./TeamInboxHeaderIconAction";

export interface TeamInboxDetailLayoutProps {
  title: string;
  subtitle: string;
  icon: IconSvgElement;
  /** Custom shared header content, such as the canonical GitHub issue strip. */
  headerContent?: React.ReactNode;
  metadata?: InfoCardRow[];
  /**
   * `scroll` owns a padded detail column. `fill` lets a nested Work Item own
   * its scrolling and responsive rail.
   */
  contentLayout?: "scroll" | "fill";
  unread: boolean;
  markReadLabel: string;
  markUnreadLabel?: string;
  openLabel: string;
  openIcon: React.ReactNode;
  headerAuxiliaryAction?: TeamInboxHeaderIconActionProps;
  onMarkRead?: () => void;
  onMarkUnread?: () => void;
  onOpen?: () => void;
  openPlacement?: "header" | "footer";
  children?: React.ReactNode;
}

const TeamInboxDetailLayout: React.FC<TeamInboxDetailLayoutProps> = ({
  title,
  subtitle,
  icon,
  headerContent,
  metadata,
  contentLayout = "scroll",
  unread,
  markReadLabel,
  markUnreadLabel,
  openLabel,
  openIcon,
  headerAuxiliaryAction,
  onMarkRead,
  onMarkUnread,
  onOpen,
  openPlacement = "footer",
  children,
}) => {
  const readAction = unread ? (
    onMarkRead ? (
      <ToolbarTooltip label={markReadLabel} position="bottom-end">
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          icon={
            <HugeiconsIcon
              icon={Tick01Icon}
              data-icon="check"
              size={14}
              strokeWidth={2}
              aria-hidden
            />
          }
          aria-label={markReadLabel}
          onClick={onMarkRead}
        />
      </ToolbarTooltip>
    ) : null
  ) : onMarkUnread && markUnreadLabel ? (
    <ToolbarTooltip label={markUnreadLabel} position="bottom-end">
      <Button
        htmlType="button"
        variant="tertiary"
        size="small"
        iconOnly
        icon={
          <HugeiconsIcon
            icon={Mail01Icon}
            data-icon="mail"
            size={14}
            strokeWidth={2}
            aria-hidden
          />
        }
        aria-label={markUnreadLabel}
        onClick={onMarkUnread}
      />
    </ToolbarTooltip>
  ) : null;
  const headerOpenAction =
    onOpen && openPlacement === "header" ? (
      <ToolbarTooltip label={openLabel} position="bottom-end">
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          icon={openIcon}
          aria-label={openLabel}
          onClick={onOpen}
          data-testid="team-inbox-open-source"
        />
      </ToolbarTooltip>
    ) : null;
  const auxiliaryAction = headerAuxiliaryAction ? (
    <TeamInboxHeaderIconAction {...headerAuxiliaryAction} />
  ) : null;

  return (
    <DetailPanelContainer>
      <PanelHeader
        title={title}
        subtitle={subtitle}
        icon={icon}
        borderBottom
        className={DETAIL_PANEL_TOKENS.headerPadding}
        actions={
          readAction || auxiliaryAction || headerOpenAction ? (
            <div
              className="flex items-center gap-px"
              data-testid="team-inbox-detail-actions"
            >
              {readAction}
              {auxiliaryAction}
              {headerOpenAction}
            </div>
          ) : undefined
        }
      >
        {headerContent}
      </PanelHeader>

      {contentLayout === "fill" ? (
        <div className="@container flex min-h-0 flex-1 flex-col overflow-hidden">
          {children}
        </div>
      ) : (
        <div className={DETAIL_PANEL_TOKENS.scrollContent}>
          <div className={DETAIL_PANEL_TOKENS.contentWidthWithPadding}>
            {children ? (
              <div className={DETAIL_PANEL_TOKENS.sectionGap}>{children}</div>
            ) : null}
            {metadata && metadata.length > 0 ? (
              <InfoCard rows={metadata} />
            ) : null}
          </div>
        </div>
      )}

      {onOpen && openPlacement === "footer" ? (
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
};

/*
 * Keep the detail shell shared across mention and assigned-item surfaces.
 * Assigned Work Items opt into header placement so the thread owns the full
 * vertical canvas; other sources retain the established footer action.
 */

export default TeamInboxDetailLayout;
