import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Textarea from "@src/components/Textarea";

import { MobileTopBar } from "../components/MobileTopBar";
import { parseMobileRemoteWsUrl } from "../connection/parseMobileRemoteWsUrl";
import type { MobileConnectionConfig } from "../connection/types";

export interface QRScanScreenProps {
  onBack?: () => void;
  onAcceptPairing?: (args: {
    config: MobileConnectionConfig;
    requiresSas: boolean;
    sasPhrase?: string;
  }) => void;
}

/** M-01b QR / manual URL entry — Phase 0 paste from Settings QR or LAN URL. */
export function QRScanScreen({ onBack, onAcceptPairing }: QRScanScreenProps) {
  const { t } = useTranslation("mobileRemote");
  const [payload, setPayload] = useState("");
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const handleSubmit = useCallback(() => {
    const result = parseMobileRemoteWsUrl(payload);
    if (!result.ok) {
      setErrorKey(result.errorKey);
      return;
    }
    setErrorKey(null);
    onAcceptPairing?.({
      config: result.config,
      requiresSas: result.requiresSas,
      sasPhrase: result.sasPhrase,
    });
  }, [onAcceptPairing, payload]);

  return (
    <>
      <MobileTopBar title={t("pairing.scanTitle")} onBack={onBack} />
      <div className="flex flex-1 flex-col px-4 py-4">
        <p className="mb-3 text-sm text-text-2">{t("pairing.scanHint")}</p>
        <Textarea
          value={payload}
          onChange={(value) => {
            setPayload(value);
            if (errorKey) setErrorKey(null);
          }}
          placeholder={t("pairing.urlPlaceholder")}
          rows={4}
          aria-label={t("pairing.urlPlaceholder")}
        />
        {errorKey ? (
          <p className="mt-2 text-sm text-danger-6" role="alert">
            {t(errorKey)}
          </p>
        ) : null}
        <div className="mt-4">
          <Button
            variant="primary"
            className="w-full"
            disabled={payload.trim().length === 0}
            onClick={handleSubmit}
          >
            {t("pairing.connect")}
          </Button>
        </div>
      </div>
    </>
  );
}

QRScanScreen.displayName = "QRScanScreen";
