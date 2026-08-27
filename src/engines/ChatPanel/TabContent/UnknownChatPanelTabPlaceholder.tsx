import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";

interface UnknownChatPanelTabPlaceholderProps {
  type: string;
}

/**
 * Rendered when an active chat-pane tab carries a type the surface registry
 * does not recognize (e.g. corrupted persisted state or a not-yet-registered
 * type). Replaces the old behavior of silently dropping to the Launchpad, so
 * an unmapped tab is a visible, debuggable state instead of a phantom home
 * screen.
 */
export const UnknownChatPanelTabPlaceholder: React.FC<UnknownChatPanelTabPlaceholderProps> =
  memo(({ type: _type }) => {
    const { t } = useTranslation();
    return (
      <Placeholder
        variant="error"
        placement="detail-panel"
        title={t("placeholders.unknownTabType")}
        fillParentHeight
      />
    );
  });

UnknownChatPanelTabPlaceholder.displayName = "UnknownChatPanelTabPlaceholder";

export default UnknownChatPanelTabPlaceholder;
