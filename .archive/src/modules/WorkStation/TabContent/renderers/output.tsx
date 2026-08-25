/**
 * Renderer wrapper for `output` tabs (named output channel placeholder).
 *
 * The editor's `TabContentRenderer` renders an empty `Placeholder` with
 * the channel name today — no heavy view component. We mirror that
 * exactly so behaviour is preserved when Phase 2 wires us in.
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/modules/shared/layouts/blocks";

import type { UnifiedTabContentProps } from "../types";

const OutputTabRenderer: React.FC<UnifiedTabContentProps> = memo(({ tab }) => {
  const { t } = useTranslation();
  const channelName = String(tab.data.channelName ?? "");
  return (
    <Placeholder
      variant="empty"
      placement="detail-panel"
      title={t("placeholders.outputChannelLabel", { channelName })}
      fillParentHeight
    />
  );
});

OutputTabRenderer.displayName = "OutputTabRenderer";

export default OutputTabRenderer;
