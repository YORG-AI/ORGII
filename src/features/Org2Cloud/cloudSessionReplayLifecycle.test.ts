import { describe, expect, it, vi } from "vitest";

import {
  buildCloudPendingPlayEntry,
  resolveCloudSessionReplayIconId,
  runImmediateCloudSessionReplay,
} from "./cloudSessionReplayLifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("runImmediateCloudSessionReplay", () => {
  it("opens the Chat Pane tab before the transcript finishes loading", async () => {
    const transcript = deferred<string>();
    const calls: string[] = [];

    const resultPromise = runImmediateCloudSessionReplay({
      sessionId: "imported-session-1",
      beginHydration: (sessionId) => calls.push(`begin:${sessionId}`),
      openTab: (sessionId) => calls.push(`open:${sessionId}`),
      load: () => {
        calls.push("load");
        return transcript.promise;
      },
      endHydration: (sessionId) => calls.push(`end:${sessionId}`),
    });

    expect(calls).toEqual([
      "begin:imported-session-1",
      "open:imported-session-1",
      "load",
    ]);

    transcript.resolve("loaded");
    await expect(resultPromise).resolves.toBe("loaded");
    expect(calls.at(-1)).toBe("end:imported-session-1");
  });

  it("releases hydration when loading fails", async () => {
    const endHydration = vi.fn();

    await expect(
      runImmediateCloudSessionReplay({
        sessionId: "imported-session-1",
        beginHydration: vi.fn(),
        openTab: vi.fn(),
        load: () => Promise.reject(new Error("network failed")),
        endHydration,
      })
    ).rejects.toThrow("network failed");

    expect(endHydration).toHaveBeenCalledWith("imported-session-1");
  });
});

describe("resolveCloudSessionReplayIconId", () => {
  it("uses the shared external-history source brand while loading", () => {
    expect(
      resolveCloudSessionReplayIconId({
        origin: { kind: "external_history", source: "codex_app" },
      })
    ).toBe("codex");
  });

  it("uses the CLI brand before the native ORGII fallback", () => {
    expect(resolveCloudSessionReplayIconId({ cliAgentType: "opencode" })).toBe(
      "opencode"
    );
    expect(resolveCloudSessionReplayIconId({})).toBe("orgii");
  });
});

describe("buildCloudPendingPlayEntry", () => {
  it("preserves the remote row and source brand before local import", () => {
    expect(
      buildCloudPendingPlayEntry({
        remoteSession: {
          id: "remote-row-1",
          origin: { kind: "external_history", source: "codex_app" },
          repoScopeKey: "github.com/acme/ORGII.git",
          branch: "develop",
          baseBranch: "main",
          worktreeBranch: "agent/session-1",
          ownerUserId: "user-ada",
          ownerDisplayName: "Ada Lovelace",
          ownerAvatarUrl: "https://example.com/ada.png",
        },
        orgId: "org-1",
        pendingEvents: 953,
        etaMs: 20_000,
        kind: "replay",
      })
    ).toEqual({
      rowId: "remote-row-1",
      orgId: "org-1",
      iconId: "codex",
      sessionEnvironment: {
        repoName: "ORGII",
        branchName: "develop",
        baseBranchName: "main",
        worktreeBranchName: "agent/session-1",
      },
      sessionOwner: {
        identityId: "user-ada",
        displayName: "Ada Lovelace",
        avatarUrl: "https://example.com/ada.png",
      },
      pendingEvents: 953,
      etaMs: 20_000,
      kind: "replay",
    });
  });
});
