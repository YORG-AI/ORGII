import React from "react";
import { useTranslation } from "react-i18next";

import { MobileActionButton } from "../components/MobileActionButton";
import { MobileTopBar } from "../components/MobileTopBar";

export interface SASConfirmScreenProps {
  phrase: string;
  onBack?: () => void;
  onConfirm?: () => void;
}

/** M-02 SAS Confirm */
export function SASConfirmScreen({
  phrase,
  onBack,
  onConfirm,
}: SASConfirmScreenProps) {
  const { t } = useTranslation("mobileRemote");

  return (
    <>
      <MobileTopBar title={t("pairing.sasTitle")} onBack={onBack} />
      <div className="flex flex-1 flex-col px-4 py-4">
        <p className="mb-4 text-sm text-text-2">{t("pairing.sasHint")}</p>
        <div className="rounded-lg border border-border-2 bg-bg-2 px-4 py-6 text-center">
          <p className="font-mono text-xl text-text-1">{phrase}</p>
        </div>
        <div className="mt-6">
          <MobileActionButton onClick={onConfirm}>
            {t("pairing.confirm")}
          </MobileActionButton>
        </div>
      </div>
    </>
  );
}

SASConfirmScreen.displayName = "SASConfirmScreen";
