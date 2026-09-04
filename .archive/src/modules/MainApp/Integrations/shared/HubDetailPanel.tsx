/**
 * HubDetailPanel — shared detail layout for Skills Hub and MCP Hub.
 *
 * Provides a consistent hero + scrollable content + sticky footer layout.
 * Consumers pass in their own metadata, content sections, and footer actions.
 */
import React from "react";

import { Placeholder } from "@src/components/Placeholder";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  PanelFooter,
  type PanelFooterActionConfig,
} from "@src/modules/shared/layouts/blocks";

interface HubDetailPanelProps {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Hero section: title, version badge, metadata row */
  hero: React.ReactNode;
  /** Main scrollable content sections */
  children: React.ReactNode;
  /** Legacy left-side footer content. Prefer action props for button layouts. */
  footer?: React.ReactNode;
  /** Primary action button on the footer right. */
  primaryAction?: PanelFooterActionConfig;
  /** Secondary action buttons rendered to the left of the primary action. */
  secondaryActions?: PanelFooterActionConfig[];
  /** Left-side content for non-button status/meta UI. */
  footerLeft?: React.ReactNode;
}

const HubDetailPanel: React.FC<HubDetailPanelProps> = ({
  loading,
  error,
  onRetry,
  hero,
  children,
  footer,
  primaryAction,
  secondaryActions,
  footerLeft,
}) => {
  if (loading) {
    return <Placeholder variant="loading" placement="detail-panel" />;
  }

  if (error) {
    return (
      <Placeholder
        variant="error"
        placement="detail-panel"
        subtitle={error}
        onRetry={onRetry}
      />
    );
  }

  return (
    <DetailPanelContainer>
      <div className={DETAIL_PANEL_TOKENS.scrollContent}>
        <div className={DETAIL_PANEL_TOKENS.contentWidthWithPadding}>
          {hero}
          {children}
        </div>
      </div>
      <PanelFooter
        left={footerLeft ?? footer}
        secondaryActions={secondaryActions}
        primaryAction={primaryAction}
      />
    </DetailPanelContainer>
  );
};

export default HubDetailPanel;
