import { describe, expect, it } from "vitest";
import { ZodError } from "zod/v4";

import type { Session } from "@src/store/session/sessionAtom/types";

import {
  classifyCloudShareResolveError,
  findLocalCloudShareSource,
} from "./cloudShareImportModel";
import { CloudShareEndpointMismatchError } from "./org2CloudShareEndpoint";
import { Org2CloudShareError } from "./org2CloudSharesClient";

describe("classifyCloudShareResolveError", () => {
  it("keeps invalid capabilities opaque", () => {
    expect(
      classifyCloudShareResolveError(
        new Org2CloudShareError("ORG2_UNAUTHORIZED", 400)
      )
    ).toBe("invalid");
  });

  it("distinguishes endpoint, network, protocol, and server failures", () => {
    expect(
      classifyCloudShareResolveError(
        new CloudShareEndpointMismatchError(
          "https://expected.example.com",
          "https://current.example.com"
        )
      )
    ).toBe("endpoint_mismatch");
    expect(classifyCloudShareResolveError(new TypeError("fetch failed"))).toBe(
      "connection"
    );
    expect(classifyCloudShareResolveError(new ZodError([]))).toBe(
      "incompatible"
    );
    expect(classifyCloudShareResolveError(new Error("boom"))).toBe("server");
  });
});

describe("findLocalCloudShareSource", () => {
  it("finds the original local session by sourceSessionId", () => {
    const original = {
      session_id: "source-1",
      name: "Original",
      category: "external_history",
    } as Session;
    const imported = {
      session_id: "imported-other-id",
      importedFrom: { sourceSessionId: "source-1" },
    } as Session;
    expect(
      findLocalCloudShareSource([imported, original], {
        sourceSessionId: "source-1",
      })
    ).toBe(original);
  });

  it("does not mistake an imported copy for the local source", () => {
    const imported = {
      session_id: "imported-other-id",
      importedFrom: { sourceSessionId: "source-1" },
    } as Session;
    expect(
      findLocalCloudShareSource([imported], { sourceSessionId: "source-1" })
    ).toBeNull();
  });
});
