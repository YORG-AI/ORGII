import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";

import { SPINNER_TOKENS } from "@src/config/spinnerTokens";

import type { ConnectionStatus } from "./types";

export interface ConnectionTestStatusBannerProps {
  testStatus: ConnectionStatus;
  testError: string | null;
}

export const ConnectionTestStatusBanner = memo(
  function ConnectionTestStatusBanner({
    testStatus,
    testError,
  }: ConnectionTestStatusBannerProps) {
    const { t } = useTranslation();

    if (testStatus === "idle") {
      return null;
    }

    return (
      <div
        className={`mb-4 flex items-center gap-2 rounded-lg p-3 text-sm ${
          testStatus === "testing" || testStatus === "adding"
            ? "bg-fill-1 text-text-2"
            : testStatus === "success"
              ? "bg-success-6/10 text-success-6"
              : "bg-danger-6/10 text-danger-6"
        }`}
      >
        {testStatus === "testing" && (
          <span className="flex items-center gap-2 text-[13px] text-text-3">
            <Loader2 size={SPINNER_TOKENS.default} className="animate-spin" />
            {t("database.testingConnection")}
          </span>
        )}
        {testStatus === "adding" && (
          <span className="flex items-center gap-2 text-[13px] text-text-3">
            <Loader2 size={SPINNER_TOKENS.default} className="animate-spin" />
            {t("database.addingConnection")}
          </span>
        )}
        {testStatus === "success" && (
          <>
            <CheckCircle2 size={16} />
            <span>{t("database.connectionSuccessful")}</span>
          </>
        )}
        {testStatus === "error" && (
          <>
            <AlertCircle size={16} />
            <span className="flex-1">{testError}</span>
          </>
        )}
      </div>
    );
  }
);
