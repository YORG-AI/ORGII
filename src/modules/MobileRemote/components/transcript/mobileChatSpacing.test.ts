import { describe, expect, it } from "vitest";

import type { TranscriptItem } from "../../lib/transcriptReducer";
import {
  MOBILE_CHAT_ITEM_GAP,
  mobileTranscriptItemGapClass,
} from "./mobileChatSpacing";

const tool = (id: string): TranscriptItem => ({
  id,
  kind: "tool",
  text: "tool",
});

describe("mobileChatSpacing", () => {
  it("uses the default mobile gap for the first tool in a run", () => {
    expect(mobileTranscriptItemGapClass(tool("t-1"), undefined)).toBe(
      MOBILE_CHAT_ITEM_GAP
    );
  });

  it("collapses top padding between consecutive tools", () => {
    expect(mobileTranscriptItemGapClass(tool("t-2"), tool("t-1"))).toBe(
      "pt-0 pb-0.5"
    );
  });

  it("keeps the default gap after non-tool items", () => {
    const agent: TranscriptItem = { id: "a-1", kind: "agent", text: "hi" };
    expect(mobileTranscriptItemGapClass(tool("t-1"), agent)).toBe(
      MOBILE_CHAT_ITEM_GAP
    );
  });
});
