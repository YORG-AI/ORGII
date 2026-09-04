import React from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";

export interface ConnectingScreenProps {
  /** @deprecated Demo-only timer path — live connect is driven by ConnectingLiveBridge. */
  onComplete?: () => void;
  delayMs?: number;
}

/** M-03 Connecting */
export function ConnectingScreen(_props: ConnectingScreenProps) {
  const { t } = useTranslation("mobileRemote");

  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <Placeholder
        variant="loading"
        title={t("pairing.connectingTitle")}
        subtitle={t("pairing.connectingSubtitle")}
      />
    </div>
  );
}

ConnectingScreen.displayName = "ConnectingScreen";
