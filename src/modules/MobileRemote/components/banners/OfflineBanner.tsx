import React from "react";
import { useTranslation } from "react-i18next";

import { InlineBanner } from "@src/components/InlineBanner";

export interface OfflineBannerProps {
  desktopName?: string;
}

export function OfflineBanner({ desktopName }: OfflineBannerProps) {
  const { t } = useTranslation("mobileRemote");
  const message = desktopName
    ? t("offlineBannerNamed", { desktopName })
    : t("offlineBanner");

  return <InlineBanner tone="warning">{message}</InlineBanner>;
}

OfflineBanner.displayName = "OfflineBanner";
