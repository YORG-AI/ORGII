import { describe, expect, it } from "vitest";

import {
  reArmTrackedShareUrls,
  trackReArmableShareUrl,
} from "./useDeepLinkHandler";

const SHARE_A = "orgii://collaboration/session?token=aaa";
const SHARE_B = "orgii://collaboration/session?token=bbb";

describe("share deep-link re-arm tracking", () => {
  it("re-arms the tracked url once the pending share clears", () => {
    const processed = new Set<string>([SHARE_A]);
    const reArmable = new Set<string>();

    trackReArmableShareUrl(processed, reArmable, SHARE_A);
    expect(processed.has(SHARE_A)).toBe(true);

    reArmTrackedShareUrls(processed, reArmable);
    expect(processed.has(SHARE_A)).toBe(false);
    expect(reArmable.size).toBe(0);
  });

  it("re-arms a superseded share url immediately instead of dedup-blocking it forever", () => {
    const processed = new Set<string>([SHARE_A]);
    const reArmable = new Set<string>();
    trackReArmableShareUrl(processed, reArmable, SHARE_A);

    // A second share link arrives BEFORE the first dialog is dismissed: the
    // old url must leave the dedup set now — the dismiss-time sweep only
    // re-arms the urls still tracked at that point.
    processed.add(SHARE_B);
    trackReArmableShareUrl(processed, reArmable, SHARE_B);

    expect(processed.has(SHARE_A)).toBe(false); // clickable again
    expect(processed.has(SHARE_B)).toBe(true); // still deduped while pending
    expect(Array.from(reArmable)).toEqual([SHARE_B]);

    // Dismissing the (second) dialog re-arms the second link too.
    reArmTrackedShareUrls(processed, reArmable);
    expect(processed.has(SHARE_B)).toBe(false);
    expect(reArmable.size).toBe(0);
  });

  it("keeps a re-clicked url deduped while its own dialog is pending", () => {
    const processed = new Set<string>([SHARE_A]);
    const reArmable = new Set<string>();
    trackReArmableShareUrl(processed, reArmable, SHARE_A);

    // The same url tracked again (re-click after a previous dismiss) must
    // not delete itself from the dedup set.
    trackReArmableShareUrl(processed, reArmable, SHARE_A);
    expect(processed.has(SHARE_A)).toBe(true);
    expect(Array.from(reArmable)).toEqual([SHARE_A]);
  });
});
