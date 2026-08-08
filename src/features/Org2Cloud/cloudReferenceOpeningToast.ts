/**
 * "Opening team session…" toast for the chip → replay pre-phase.
 *
 * Between an admitted in-app reference click and the replay actually
 * starting there is an org-scope switch, a listing fetch and possibly a
 * forced refresh probe — previously all silent, which read as a dead chip.
 * The fixed id makes the toast an update slot: repeated clicks replace it,
 * and every terminal outcome (replay started, refocused, revealed local,
 * skipped) dismisses it.
 */
import Message from "@src/components/Message";
import i18n from "@src/i18n";

const CLOUD_REFERENCE_OPENING_TOAST_ID = "cloud-session-ref-opening";

/** Outlives any plausible pre-phase; a terminal decision dismisses earlier. */
const OPENING_TOAST_DURATION_MS = 30_000;

export function showCloudReferenceOpeningToast(): void {
  Message.info(i18n.t("navigation:cloud.sessionRef.opening"), {
    id: CLOUD_REFERENCE_OPENING_TOAST_ID,
    duration: OPENING_TOAST_DURATION_MS,
    closable: true,
  });
}

export function dismissCloudReferenceOpeningToast(): void {
  Message.remove(CLOUD_REFERENCE_OPENING_TOAST_ID);
}
