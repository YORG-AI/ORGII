import { describe, expect, it } from "vitest";

import { isBillingCompleteDeepLink } from "./billingComplete";

describe("isBillingCompleteDeepLink", () => {
  it("matches the billing complete deep link", () => {
    expect(isBillingCompleteDeepLink("orgii://billing/complete")).toBe(true);
  });

  it("matches with trailing slash and surrounding whitespace", () => {
    expect(isBillingCompleteDeepLink(" orgii://billing/complete/ ")).toBe(true);
  });

  it("matches case-insensitively on scheme and path", () => {
    expect(isBillingCompleteDeepLink("ORGII://Billing/Complete")).toBe(true);
  });

  it("rejects other orgii deep links", () => {
    expect(isBillingCompleteDeepLink("orgii://auth/callback#x=1")).toBe(false);
    expect(isBillingCompleteDeepLink("orgii://billing/other")).toBe(false);
    expect(isBillingCompleteDeepLink("orgii://billing")).toBe(false);
    expect(isBillingCompleteDeepLink("orgii://cloud/join?invite=abc")).toBe(
      false
    );
  });

  it("rejects other schemes and malformed urls", () => {
    expect(isBillingCompleteDeepLink("https://billing/complete")).toBe(false);
    expect(isBillingCompleteDeepLink("yorgai://billing/complete")).toBe(false);
    expect(isBillingCompleteDeepLink("not a url")).toBe(false);
    expect(isBillingCompleteDeepLink("")).toBe(false);
  });
});
