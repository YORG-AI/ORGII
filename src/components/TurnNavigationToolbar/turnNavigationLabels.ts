import type { TFunction } from "i18next";

export function getTurnNavigationLabel(params: {
  ready: boolean;
  currentIndex: number;
  pageCount: number;
  t: TFunction;
}): string {
  const { ready, currentIndex, pageCount, t } = params;
  if (!ready || pageCount <= 0 || currentIndex >= pageCount - 1) {
    return t("pagination.latestRound");
  }
  return t("pagination.round", { current: currentIndex + 1 });
}
