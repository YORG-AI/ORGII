import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadCliTranscriptRevision } from "../cliHistory";

const mocks = vi.hoisted(() => ({
  transcriptRevision: vi.fn(),
}));

vi.mock("@src/api/tauri/rpc", () => ({
  rpc: { cli: { transcriptRevision: mocks.transcriptRevision } },
}));

describe("loadCliTranscriptRevision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves the legacy, unavailable, and stable native revision states", async () => {
    mocks.transcriptRevision.mockResolvedValueOnce({
      native: false,
      revision: null,
    });
    await expect(loadCliTranscriptRevision("legacy")).resolves.toBeUndefined();

    mocks.transcriptRevision.mockResolvedValueOnce({
      native: true,
      revision: null,
    });
    await expect(loadCliTranscriptRevision("unavailable")).resolves.toBeNull();

    mocks.transcriptRevision.mockResolvedValueOnce({
      native: true,
      revision: "native-file-v1:123:456",
    });
    await expect(loadCliTranscriptRevision("stable")).resolves.toBe(
      "native-file-v1:123:456"
    );
  });
});
