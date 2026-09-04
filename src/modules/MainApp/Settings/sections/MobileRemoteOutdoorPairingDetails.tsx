import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { PairingInitOutput } from "@src/api/tauri/mobileRemote";
import Button from "@src/components/Button";
import Message from "@src/components/Message";
import Textarea from "@src/components/Textarea";
import { copyText } from "@src/util/data/clipboard";

import MobileRemoteQrCodeDisplay from "./MobileRemoteQrCodeDisplay";

interface MobileRemoteOutdoorPairingDetailsProps {
  pairing: PairingInitOutput;
  confirming: boolean;
  regenerating: boolean;
  onConfirm: () => void;
  onRegenerate: () => void;
}

const MobileRemoteOutdoorPairingDetails: React.FC<
  MobileRemoteOutdoorPairingDetailsProps
> = ({ pairing, confirming, regenerating, onConfirm, onRegenerate }) => {
  const { t } = useTranslation("settings");

  const handleCopyPayload = useCallback(async () => {
    try {
      await copyText(pairing.qrPayload);
      Message.success({ content: t("mobileRemote.pairingPayloadCopied") });
    } catch {
      Message.error({ content: t("mobileRemote.pairingPayloadCopyFailed") });
    }
  }, [pairing.qrPayload, t]);

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <MobileRemoteQrCodeDisplay
        value={pairing.qrPayload}
        size={180}
        ariaLabel={t("mobileRemote.qrAriaLabel")}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="rounded-md border border-border-2 bg-bg-2 p-3">
          <p className="text-xs text-text-3">{t("mobileRemote.sasPhrase")}</p>
          <p className="mt-1 font-mono text-lg text-text-1">
            {pairing.confirmationPhrase}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label
            className="text-xs font-medium text-text-2"
            htmlFor="mobile-remote-pairing-payload"
          >
            {t("mobileRemote.pairingPayload")}
          </label>
          <Textarea
            id="mobile-remote-pairing-payload"
            value={pairing.qrPayload}
            readOnly
            autoSize={{ minRows: 2, maxRows: 4 }}
            resize="none"
            spellCheck={false}
            textareaClassName="font-mono text-xs"
          />
          <p className="text-xs text-text-3">
            {t("mobileRemote.pairingPayloadHint")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="small"
              disabled={regenerating}
              onClick={() => void handleCopyPayload()}
            >
              {t("mobileRemote.copyPairingPayload")}
            </Button>
            <Button
              variant="tertiary"
              appearance="ghost"
              size="small"
              disabled={regenerating || confirming}
              loading={regenerating}
              onClick={onRegenerate}
            >
              {t("mobileRemote.regeneratePairing")}
            </Button>
          </div>
        </div>

        <p className="text-xs text-text-3">
          {t("mobileRemote.pairingExpires", {
            seconds: pairing.expiresInSeconds,
          })}
        </p>
        <Button
          variant="primary"
          disabled={confirming || regenerating}
          loading={confirming}
          onClick={onConfirm}
        >
          {t("mobileRemote.confirmPairing")}
        </Button>
      </div>
    </div>
  );
};

export default MobileRemoteOutdoorPairingDetails;
