import React from "react";
import { useTranslation } from "react-i18next";

const disclaimerClass =
  "flex flex-col gap-1.5 px-1 pt-3 text-[11px] leading-relaxed text-text-3";

export const TrademarkDisclaimer: React.FC = () => {
  const { t } = useTranslation("terms");

  return (
    <div className={disclaimerClass}>
      <p>{t("notices.trademark")}</p>
      <p>{t("notices.responsibleUse")}</p>
    </div>
  );
};

export const KeyPrivacyDisclaimer: React.FC = () => {
  const { t } = useTranslation("terms");

  return (
    <div className={disclaimerClass}>
      <p>{t("notices.trademark")}</p>
      <p>{t("notices.keyPrivacy")}</p>
      <p>{t("notices.responsibleUse")}</p>
    </div>
  );
};

export const CliDisclaimer: React.FC = () => {
  const { t } = useTranslation("terms");

  return (
    <div className={disclaimerClass}>
      <p>{t("notices.trademark")}</p>
      <p>{t("notices.cli")}</p>
      <p>{t("notices.responsibleUse")}</p>
    </div>
  );
};

export const ThirdPartyDisclaimer: React.FC = () => {
  const { t } = useTranslation("terms");

  return (
    <div className={disclaimerClass}>
      <p>{t("notices.trademark")}</p>
    </div>
  );
};
