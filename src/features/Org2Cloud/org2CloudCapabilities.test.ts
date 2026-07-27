import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __CAPABILITIES_INTERNALS,
  getCloudCapabilities,
} from "./org2CloudCapabilities";
import { getCloudCapabilitiesRaw } from "./org2CloudClient";

vi.mock("./org2CloudClient", () => ({
  getCloudCapabilitiesRaw: vi.fn(),
}));

const rawMock = vi.mocked(getCloudCapabilitiesRaw);

beforeEach(() => {
  __CAPABILITIES_INTERNALS.reset();
});

afterEach(() => {
  rawMock.mockReset();
});

describe("getCloudCapabilities", () => {
  it("parses a 0005 payload and caches it per endpoint", async () => {
    rawMock.mockResolvedValueOnce({ broadcastSignals: true });
    expect(await getCloudCapabilities("jwt-1")).toEqual({
      broadcastSignals: true,
      storageSegments: false,
      homeEndpoints: false,
    });
    expect(await getCloudCapabilities("jwt-1")).toEqual({
      broadcastSignals: true,
      storageSegments: false,
      homeEndpoints: false,
    });
    expect(rawMock).toHaveBeenCalledTimes(1);
  });

  it("parses the 0006 storageSegments flag", async () => {
    rawMock.mockResolvedValueOnce({
      broadcastSignals: true,
      storageSegments: true,
    });
    expect(await getCloudCapabilities("jwt-1")).toEqual({
      broadcastSignals: true,
      storageSegments: true,
      homeEndpoints: false,
    });
  });

  it("parses the 0007 homeEndpoints flag", async () => {
    rawMock.mockResolvedValueOnce({
      broadcastSignals: true,
      storageSegments: true,
      homeEndpoints: true,
    });
    expect(await getCloudCapabilities("jwt-1")).toEqual({
      broadcastSignals: true,
      storageSegments: true,
      homeEndpoints: true,
    });
  });

  it("answers legacy on failure without caching so the next probe retries", async () => {
    rawMock.mockResolvedValueOnce(null);
    expect(await getCloudCapabilities("jwt-1")).toEqual({
      broadcastSignals: false,
      storageSegments: false,
      homeEndpoints: false,
    });
    rawMock.mockResolvedValueOnce({ broadcastSignals: true });
    expect(await getCloudCapabilities("jwt-1")).toEqual({
      broadcastSignals: true,
      storageSegments: false,
      homeEndpoints: false,
    });
    expect(rawMock).toHaveBeenCalledTimes(2);
  });

  it("degrades a malformed flag to false and still caches the answer", async () => {
    rawMock.mockResolvedValueOnce({
      broadcastSignals: "yes",
      storageSegments: "yes",
      homeEndpoints: "yes",
    });
    expect(await getCloudCapabilities("jwt-1")).toEqual({
      broadcastSignals: false,
      storageSegments: false,
      homeEndpoints: false,
    });
    expect(await getCloudCapabilities("jwt-1")).toEqual({
      broadcastSignals: false,
      storageSegments: false,
      homeEndpoints: false,
    });
    expect(rawMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent probes into one request", async () => {
    let release: (value: unknown) => void = () => undefined;
    rawMock.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const first = getCloudCapabilities("jwt-1");
    const second = getCloudCapabilities("jwt-1");
    release({ broadcastSignals: true, storageSegments: true });
    expect(await first).toEqual({
      broadcastSignals: true,
      storageSegments: true,
      homeEndpoints: false,
    });
    expect(await second).toEqual({
      broadcastSignals: true,
      storageSegments: true,
      homeEndpoints: false,
    });
    expect(rawMock).toHaveBeenCalledTimes(1);
  });
});
