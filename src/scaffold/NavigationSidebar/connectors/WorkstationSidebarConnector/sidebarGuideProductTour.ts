import { GENERAL_LAYOUT_TOUR_EVENT } from "@src/scaffold/Tutorials/generalLayoutTourConfig";

/** Start the maintained layout tour without introducing another guide state. */
export function startSidebarGuideProductTour(
  eventTarget: Pick<Window, "dispatchEvent"> = window
): void {
  eventTarget.dispatchEvent(new CustomEvent(GENERAL_LAYOUT_TOUR_EVENT));
}
