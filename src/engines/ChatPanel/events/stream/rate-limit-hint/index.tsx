/**
 * RateLimitHintEvent — Inline chat alert shown when persistent
 * API rate limiting is detected.  Suggests the user switch to another
 * window to continue working while the current model cools down.
 *
 * Rendered via the event registry under `rate_limit_hint`.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import InlineAlert from "@src/components/InlineAlert";
import {
  type RawEventInput,
  useNormalizedEventProps,
} from "@src/engines/SessionCore/rendering/props";
import type { EventVariant } from "@src/engines/SessionCore/rendering/types/universalProps";

interface RateLimitHintEventProps extends RawEventInput {
  variant?: EventVariant;
}

export const RateLimitHintEvent: React.FC<RateLimitHintEventProps> = (
  props
) => {
  const { t } = useTranslation("sessions");
  const normalizedProps = useNormalizedEventProps(props, "rate_limit_hint");

  if (!normalizedProps) return null;

  return (
    <InlineAlert type="warning" title={t("chat.rateLimitHintTitle")}>
      {t("chat.rateLimitHintBody")}
    </InlineAlert>
  );
};

RateLimitHintEvent.displayName = "RateLimitHintEvent";

export default RateLimitHintEvent;
