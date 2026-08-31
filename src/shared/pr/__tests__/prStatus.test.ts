import { describe, expect, it } from "vitest";

import {
  PR_STATUS_UNKNOWN,
  getPrStatusIconName,
  getPrStatusLabelKey,
  getPrStatusVariant,
  normalizePrStatus,
} from "../prStatus";

describe("normalizePrStatus", () => {
  it("returns 'merged' when merged overrides any state", () => {
    expect(normalizePrStatus({ state: "open", merged: true })).toBe("merged");
    expect(normalizePrStatus({ state: "closed", merged: true })).toBe("merged");
  });

  it("returns 'draft' when draft is set and not merged", () => {
    expect(normalizePrStatus({ state: "open", draft: true })).toBe("draft");
  });

  it("lowercases known GitHub states", () => {
    expect(normalizePrStatus({ state: "OPEN" })).toBe("open");
    expect(normalizePrStatus({ state: "Closed" })).toBe("closed");
    expect(normalizePrStatus({ state: "MERGED" })).toBe("merged");
    expect(normalizePrStatus({ state: "Draft" })).toBe("draft");
  });

  it("defaults to 'open' for empty / missing state", () => {
    expect(normalizePrStatus({})).toBe("open");
    expect(normalizePrStatus({ state: "" })).toBe("open");
    expect(normalizePrStatus({ state: null })).toBe("open");
  });

  it("passes through unknown / custom states unchanged", () => {
    expect(normalizePrStatus({ state: "pending_review" })).toBe(
      "pending_review"
    );
  });
});

describe("getPrStatusVariant", () => {
  it("maps each known status to its semantic badge + dot classes", () => {
    expect(getPrStatusVariant("open")).toEqual({
      badgeClass: "bg-success-1 text-success-6",
      dotClass: "bg-success-6",
      textClass: "text-success-6",
    });
    expect(getPrStatusVariant("merged")).toEqual({
      badgeClass: "bg-purple-1 text-purple-6",
      dotClass: "bg-purple-6",
      textClass: "text-purple-6",
    });
    expect(getPrStatusVariant("closed")).toEqual({
      badgeClass: "bg-danger-1 text-danger-6",
      dotClass: "bg-danger-6",
      textClass: "text-danger-6",
    });
    expect(getPrStatusVariant("draft")).toEqual({
      badgeClass: "bg-fill-2 text-text-2",
      dotClass: "bg-text-2",
      textClass: "text-text-2",
    });
  });

  it("falls back to a neutral variant for unknown states", () => {
    expect(getPrStatusVariant("pending_review")).toEqual({
      badgeClass: "bg-fill-2 text-text-3",
      dotClass: "bg-text-3",
      textClass: "text-text-3",
    });
  });

  it("falls back to a neutral variant for an empty key", () => {
    expect(getPrStatusVariant("")).toEqual({
      badgeClass: "bg-fill-2 text-text-3",
      dotClass: "bg-text-3",
      textClass: "text-text-3",
    });
  });
});

describe("getPrStatusLabelKey", () => {
  it("returns the common-namespace i18n key for each status", () => {
    expect(getPrStatusLabelKey("open")).toBe("labels.prStatus.open");
    expect(getPrStatusLabelKey("merged")).toBe("labels.prStatus.merged");
    expect(getPrStatusLabelKey("closed")).toBe("labels.prStatus.closed");
    expect(getPrStatusLabelKey("draft")).toBe("labels.prStatus.draft");
  });

  it("builds a key for unknown states too (caller supplies fallback)", () => {
    expect(getPrStatusLabelKey("pending_review")).toBe(
      "labels.prStatus.pending_review"
    );
  });
});

describe("getPrStatusIconName", () => {
  it("maps statuses to their semantic icon names", () => {
    expect(getPrStatusIconName("open")).toBe("pull-request");
    expect(getPrStatusIconName("draft")).toBe("draft");
    expect(getPrStatusIconName("merged")).toBe("merge");
    expect(getPrStatusIconName("closed")).toBe("closed");
  });

  it("defaults to 'pull-request' for unknown states", () => {
    expect(getPrStatusIconName("pending_review")).toBe("pull-request");
  });
});

describe("PR_STATUS_UNKNOWN", () => {
  it("is not one of the real GitHub states", () => {
    // It marks the absence of a status, so `normalizePrStatus` must never
    // produce it: a PR GitHub actually answered for always has a real state.
    expect(["open", "merged", "closed", "draft"]).not.toContain(
      PR_STATUS_UNKNOWN
    );
    expect(normalizePrStatus({ state: "open" })).not.toBe(PR_STATUS_UNKNOWN);
    expect(normalizePrStatus({})).not.toBe(PR_STATUS_UNKNOWN);
  });

  it("presents neutrally rather than as any state-bearing color", () => {
    const unknown = getPrStatusVariant(PR_STATUS_UNKNOWN);

    expect(unknown).toEqual({
      badgeClass: "bg-fill-2 text-text-3",
      dotClass: "bg-text-3",
      textClass: "text-text-3",
    });
    // Specifically not green: a failed status read must not read as "open".
    expect(unknown).not.toEqual(getPrStatusVariant("open"));
    expect(getPrStatusIconName(PR_STATUS_UNKNOWN)).toBe("pull-request");
  });

  it("has a label key backed by a translation", async () => {
    expect(getPrStatusLabelKey(PR_STATUS_UNKNOWN)).toBe(
      "labels.prStatus.unknown"
    );

    const en = await import("@src/i18n/locales/en/common.json");
    expect(en.default.labels.prStatus).toHaveProperty(PR_STATUS_UNKNOWN);
  });
});
