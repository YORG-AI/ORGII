import { describe, expect, it } from "vitest";

import {
  buildCloudSessionReference,
  collectUniqueCloudSessionReferences,
  parseCloudSessionReference,
  scanCloudSessionReferences,
} from "./cloudSessionReference";
import { isCloudShareDeepLink } from "./org2CloudOrgManagement";

const REFERENCE_SOURCE = {
  orgId: "11111111-1111-1111-1111-111111111111",
  ownerUserId: "22222222-2222-2222-2222-222222222222",
  sourceSessionId: "codexapp-rollout:2026/07/23?thread=abc",
};

describe("cloud session text references", () => {
  it("builds a versioned, URL-encoded reference and round-trips it", () => {
    const reference = buildCloudSessionReference(REFERENCE_SOURCE);

    expect(reference).toBe(
      "orgii://cloud/session/ref?v=1&org=11111111-1111-1111-1111-111111111111&owner=22222222-2222-2222-2222-222222222222&session=codexapp-rollout%3A2026%2F07%2F23%3Fthread%3Dabc"
    );
    expect(parseCloudSessionReference(reference)).toEqual({
      version: 1,
      ...REFERENCE_SOURCE,
    });
  });

  it("stays distinct from capability-bearing session share links", () => {
    const reference = buildCloudSessionReference(REFERENCE_SOURCE);

    expect(isCloudShareDeepLink(reference)).toBe(false);
    expect(
      parseCloudSessionReference("orgii://cloud/session?share=secret")
    ).toBeNull();
  });

  it("rejects missing, duplicate, malformed, and unsupported fields", () => {
    const base =
      "orgii://cloud/session/ref?v=1&org=o&owner=u&session=session-1";

    expect(parseCloudSessionReference(`${base}&session=session-2`)).toBeNull();
    expect(
      parseCloudSessionReference(
        "orgii://cloud/session/ref?v=2&org=o&owner=u&session=s"
      )
    ).toBeNull();
    expect(
      parseCloudSessionReference("orgii://cloud/session/ref?v=1&org=o&owner=u")
    ).toBeNull();
    expect(parseCloudSessionReference(`${base}#fragment`)).toBeNull();
    expect(parseCloudSessionReference("not a reference")).toBeNull();
  });

  it("refuses to build incomplete identity tuples", () => {
    expect(() =>
      buildCloudSessionReference({ ...REFERENCE_SOURCE, ownerUserId: " " })
    ).toThrow("ownerUserId");
  });
});

describe("scanCloudSessionReferences", () => {
  const reference = buildCloudSessionReference(REFERENCE_SOURCE);

  it("finds a bare reference with its exact location and text", () => {
    const text = `please review ${reference} before merging`;

    expect(scanCloudSessionReferences(text)).toEqual([
      {
        start: "please review ".length,
        end: "please review ".length + reference.length,
        url: reference,
        reference: { version: 1, ...REFERENCE_SOURCE },
      },
    ]);
  });

  it("strips trailing sentence punctuation before validating", () => {
    const spans = scanCloudSessionReferences(`see ${reference}.`);

    expect(spans).toHaveLength(1);
    expect(spans[0].url).toBe(reference);
    expect(spans[0].end).toBe("see ".length + reference.length);
  });

  it("strips a trailing backtick instead of folding it into the session id", () => {
    const spans = scanCloudSessionReferences(`${reference}\``);

    expect(spans).toHaveLength(1);
    expect(spans[0].url).toBe(reference);
  });

  it("skips malformed candidates without losing later valid ones", () => {
    const text = `orgii://cloud/nope ${reference}`;

    const spans = scanCloudSessionReferences(text);
    expect(spans).toHaveLength(1);
    expect(spans[0].url).toBe(reference);
  });

  it("fails closed on a whitespace-free run longer than any real reference", () => {
    const text = `${reference}${"x".repeat(600)}`;

    expect(scanCloudSessionReferences(text)).toEqual([]);
  });
});

describe("collectUniqueCloudSessionReferences", () => {
  const first = buildCloudSessionReference(REFERENCE_SOURCE);
  const second = buildCloudSessionReference({
    ...REFERENCE_SOURCE,
    sourceSessionId: "sdeagent-other",
  });

  it("dedupes repeats and keeps first-appearance order", () => {
    const text = `${first}\n${second}\nagain: ${first}`;

    expect(collectUniqueCloudSessionReferences(text)).toEqual([
      { version: 1, ...REFERENCE_SOURCE },
      { version: 1, ...REFERENCE_SOURCE, sourceSessionId: "sdeagent-other" },
    ]);
  });

  it("returns nothing for reference-free text", () => {
    expect(collectUniqueCloudSessionReferences("plain text")).toEqual([]);
  });

  it("excludes references inside code spans and fences, matching the renderer", () => {
    expect(collectUniqueCloudSessionReferences(`\`${first}\``)).toEqual([]);
    expect(
      collectUniqueCloudSessionReferences("```\n" + first + "\n```")
    ).toEqual([]);
    expect(
      collectUniqueCloudSessionReferences(`\`${first}\` but bare: ${second}`)
    ).toEqual([
      { version: 1, ...REFERENCE_SOURCE, sourceSessionId: "sdeagent-other" },
    ]);
  });

  it("still collects a reference after an unpaired backtick, like GFM", () => {
    expect(collectUniqueCloudSessionReferences(`\` ${first}`)).toEqual([
      { version: 1, ...REFERENCE_SOURCE },
    ]);
  });
});
