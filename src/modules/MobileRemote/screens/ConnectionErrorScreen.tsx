import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { Placeholder } from "@src/components/Placeholder";

/** M-04 Connection Error */
export interface ConnectionErrorScreenProps {
  message?: string;
  onRetry?: () => void;
}

export function ConnectionErrorScreen({
  message,
  onRetry,
}: ConnectionErrorScreenProps) {
  const { t } = useTranslation("mobileRemote");

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6">
      <Placeholder
        variant="error"
        title={t("connectionFailed", { defaultValue: "Connection failed" })}
        subtitle={message}
      />
      {onRetry ? (
        <Button
          variant="primary"
          className="mt-6 w-full max-w-xs"
          onClick={onRetry}
        >
          {t("actions.retry", { ns: "common", defaultValue: "Retry" })}
        </Button>
      ) : null}
    </div>
  );
}

ConnectionErrorScreen.displayName = "ConnectionErrorScreen";
