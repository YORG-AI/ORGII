import React, { type ComponentProps, memo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { Cancel01Icon, HugeiconsIcon } from "@src/icons";
import DetailHeaderIconAction from "@src/modules/shared/components/DetailHeaderIconAction";

import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  PanelHeader,
  type PanelHeaderProps,
} from "./blocks";

export type DetailPaneHeaderProps = Omit<
  PanelHeaderProps,
  "background" | "borderBottom" | "className" | "height" | "variant"
>;

export interface DetailPaneLayoutProps {
  /** Domain-owned identity rendered in the shared 36px detail header. */
  header?: DetailPaneHeaderProps;
  /** Draw a divider beneath the detail header. Defaults to true. */
  headerBorderBottom?: boolean;
  children?: React.ReactNode;
  className?: string;
  testId?: string;
  rootProps?: React.HTMLAttributes<HTMLDivElement>;
  dataAttributes?: Record<
    `data-${string}`,
    boolean | number | string | undefined
  >;
  /** Standard right-edge close action, including header-only empty panes. */
  onClose?: () => void;
  closeLabel?: string;
  closeTestId?: string;
}

export interface DetailPaneCloseActionProps {
  onClose: () => void;
  label?: string;
  testId?: string;
}

/** One close action shared by detail headers and tab strips. */
export const DetailPaneCloseAction: React.FC<DetailPaneCloseActionProps> = memo(
  ({ onClose, label, testId }) => {
    const { t } = useTranslation("common");
    const resolvedLabel = label ?? t("actions.close");
    return (
      <DetailHeaderIconAction
        label={resolvedLabel}
        icon={
          <HugeiconsIcon
            icon={Cancel01Icon}
            data-icon="x"
            size={HEADER_ICON_SIZE.sm}
            strokeWidth={1.75}
            aria-hidden
          />
        }
        onClick={onClose}
        testId={testId}
      />
    );
  }
);

DetailPaneCloseAction.displayName = "DetailPaneCloseAction";

/**
 * Canonical right-hand pane for Inbox-style list/detail surfaces.
 *
 * The shell owns responsive containment, header geometry, and the full-height
 * body. Domains own only header content/actions and the detail body itself.
 */
const DetailPaneLayout: React.FC<DetailPaneLayoutProps> = memo(
  ({
    header,
    headerBorderBottom = true,
    children,
    className = "",
    testId,
    rootProps,
    dataAttributes,
    onClose,
    closeLabel,
    closeTestId,
  }) => {
    const resolvedHeader =
      header || onClose
        ? {
            ...header,
            actions: onClose ? (
              <div className="flex shrink-0 items-center gap-px">
                {header?.actions}
                <DetailPaneCloseAction
                  onClose={onClose}
                  label={closeLabel}
                  testId={closeTestId}
                />
              </div>
            ) : (
              header?.actions
            ),
          }
        : undefined;

    return (
      <DetailPanelContainer
        className={className}
        testId={testId}
        rootProps={rootProps}
        dataAttributes={{
          ...dataAttributes,
          "data-detail-pane-layout": "true",
        }}
      >
        {resolvedHeader ? (
          <PanelHeader
            {...resolvedHeader}
            borderBottom={headerBorderBottom}
            background="default"
            height="detail"
            className={DETAIL_PANEL_TOKENS.headerPadding}
          />
        ) : null}
        <div
          className="@container flex min-h-0 flex-1 flex-col overflow-hidden"
          data-detail-pane-body
        >
          {children}
        </div>
      </DetailPanelContainer>
    );
  }
);

DetailPaneLayout.displayName = "DetailPaneLayout";

type PlaceholderProps = ComponentProps<typeof Placeholder>;

export type DetailPanePlaceholderProps = Omit<
  PlaceholderProps,
  "placement" | "fillParentHeight"
>;

/** Full-height placeholder whose position cannot drift from the detail body. */
export const DetailPanePlaceholder: React.FC<DetailPanePlaceholderProps> = memo(
  (props) => (
    <Placeholder {...props} placement="detail-panel" fillParentHeight />
  )
);

DetailPanePlaceholder.displayName = "DetailPanePlaceholder";

export default DetailPaneLayout;
