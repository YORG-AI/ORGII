import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import RegionNoticeButton from "@src/components/RegionNoticeButton";
import { isRegionSanctioned } from "@src/config/providerRegions";
import { useRegionCheck } from "@src/hooks/config";
import type { RouteToolbarButton } from "@src/store/ui/routeToolbarAtom";

const SETTINGS_REGION_NOTICE_BUTTON_ID = "settings-region-notice";

export function useSettingsRegionNoticeButton(): RouteToolbarButton | null {
  const { t } = useTranslation("sessions");
  const regionCheck = useRegionCheck("");

  return useMemo(() => {
    if (regionCheck.status === "loading" || !regionCheck.countryCode) {
      return null;
    }

    const sanctioned = isRegionSanctioned(regionCheck.countryCode);
    const providerRestricted = regionCheck.restrictedProviders.length > 0;
    if (!providerRestricted && !sanctioned) {
      return null;
    }

    const location = regionCheck.locationText || regionCheck.countryCode;
    const body = providerRestricted
      ? sanctioned
        ? t("creator.regionNoticeBodyBoth", { location })
        : t("creator.regionNoticeBodyProvider", { location })
      : t("creator.regionNoticeBodySanctions", { location });
    const title = t("creator.regionNoticeTitle");

    return {
      id: SETTINGS_REGION_NOTICE_BUTTON_ID,
      title,
      element: (
        <RegionNoticeButton
          title={title}
          body={<p className="m-0">{body}</p>}
          alertClassName="border-border-2! bg-chat-container! text-text-1! shadow-lg"
        />
      ),
      onClick: () => {},
    };
  }, [
    regionCheck.countryCode,
    regionCheck.locationText,
    regionCheck.restrictedProviders,
    regionCheck.status,
    t,
  ]);
}
