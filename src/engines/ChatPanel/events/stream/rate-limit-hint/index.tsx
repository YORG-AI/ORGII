/**
 * RateLimitHintEvent — Informational chat block shown when persistent
 * API rate limiting is detected.  Suggests the user switch to another
 * window to continue working while the current model cools down.
 *
 * Rendered via the event registry under `rate_limit_hint`.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import {
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderTitle,
  SESSION_UI_TOKENS,
  getEventBlockContainerClasses,
  getEventBlockContentClasses,
} from "@src/engines/ChatPanel/blocks/primitives";
import {
  type RawEventInput,
  useNormalizedEventProps,
} from "@src/engines/SessionCore/rendering/props";
import type { EventVariant } from "@src/engines/SessionCore/rendering/types/universalProps";
import { Alert01Icon, HugeiconsIcon } from "@src/icons";

export interface RateLimitHintEventProps extends RawEventInput {
  variant?: EventVariant;
}

export const RateLimitHintEvent: React.FC<RateLimitHintEventProps> = (
  props
) => {
  const { t } = useTranslation("sessions");
  const normalizedProps = useNormalizedEventProps(props, "rate_limit_hint");

  if (!normalizedProps) return null;

  const icon = (
    <HugeiconsIcon
      icon={Alert01Icon}
      data-icon="alert-triangle"
      size={SESSION_UI_TOKENS.ICON.SIZE_SM}
      className="text-warning-6"
    />
  );

  return (
    <div className={getEventBlockContainerClasses(false)}>
      <EventBlockHeader isCollapsed={false} withHover={false}>
        <EventBlockHeaderIcon
          icon={icon}
          isCollapsed={false}
          isHeaderHovered={false}
          hasContent={false}
        />
        <EventBlockHeaderTitle>
          {t("chat.rateLimitHintTitle")}
        </EventBlockHeaderTitle>
      </EventBlockHeader>

      <div
        className={getEventBlockContentClasses({ padding: "px-3 pb-3 pt-1" })}
      >
        <p className="m-0 text-[13px] leading-relaxed text-text-2">
          {t("chat.rateLimitHintBody")}
        </p>
      </div>
    </div>
  );
};

RateLimitHintEvent.displayName = "RateLimitHintEvent";

export default RateLimitHintEvent;
