import React from "react";

import {
  HugeiconsIcon,
  type IconSvgElement,
  Mail01Icon,
  Tick01Icon,
} from "@src/icons";
import DetailHeaderIconAction from "@src/modules/shared/components/DetailHeaderIconAction";
import type { DetailHeaderIconActionProps } from "@src/modules/shared/components/DetailHeaderIconAction";
import DetailPaneLayout from "@src/modules/shared/layouts/DetailPaneLayout";

export interface TeamInboxDetailLayoutProps {
  title: string;
  subtitle: string;
  icon: IconSvgElement;
  /** Custom shared header content, such as the canonical GitHub issue strip. */
  headerContent?: React.ReactNode;
  unread: boolean;
  markReadLabel: string;
  markUnreadLabel?: string;
  openLabel: string;
  openIcon: React.ReactNode;
  headerAuxiliaryAction?: DetailHeaderIconActionProps;
  onMarkRead?: () => void;
  onMarkUnread?: () => void;
  onOpen?: () => void;
  onClose?: () => void;
  children?: React.ReactNode;
}

const TeamInboxDetailLayout: React.FC<TeamInboxDetailLayoutProps> = ({
  title,
  subtitle,
  icon,
  headerContent,
  unread,
  markReadLabel,
  markUnreadLabel,
  openLabel,
  openIcon,
  headerAuxiliaryAction,
  onMarkRead,
  onMarkUnread,
  onOpen,
  onClose,
  children,
}) => {
  const readAction = unread ? (
    onMarkRead ? (
      <DetailHeaderIconAction
        label={markReadLabel}
        icon={
          <HugeiconsIcon
            icon={Tick01Icon}
            data-icon="check"
            size={14}
            strokeWidth={2}
            aria-hidden
          />
        }
        onClick={onMarkRead}
      />
    ) : null
  ) : onMarkUnread && markUnreadLabel ? (
    <DetailHeaderIconAction
      label={markUnreadLabel}
      icon={
        <HugeiconsIcon
          icon={Mail01Icon}
          data-icon="mail"
          size={14}
          strokeWidth={2}
          aria-hidden
        />
      }
      onClick={onMarkUnread}
    />
  ) : null;
  const headerOpenAction = onOpen ? (
    <DetailHeaderIconAction
      label={openLabel}
      icon={openIcon}
      onClick={onOpen}
      testId="team-inbox-open-source"
    />
  ) : null;
  const auxiliaryAction = headerAuxiliaryAction ? (
    <DetailHeaderIconAction {...headerAuxiliaryAction} />
  ) : null;

  return (
    <DetailPaneLayout
      onClose={onClose}
      closeTestId="team-inbox-close-detail"
      header={{
        title,
        subtitle,
        icon,
        children: headerContent,
        actions:
          readAction || auxiliaryAction || headerOpenAction ? (
            <div
              className="flex items-center gap-px"
              data-testid="team-inbox-detail-actions"
            >
              {readAction}
              {auxiliaryAction}
              {headerOpenAction}
            </div>
          ) : undefined,
      }}
    >
      {children}
    </DetailPaneLayout>
  );
};

/*
 * This adapter maps Inbox read/open actions into the domain-neutral shared
 * detail pane; it does not own a second layout implementation.
 */

export default TeamInboxDetailLayout;
