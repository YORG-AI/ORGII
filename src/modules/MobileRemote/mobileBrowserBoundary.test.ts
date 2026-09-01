import { describe, expect, it } from "vitest";

import {
  importersOfPackage,
  reachableFilesMatching,
  walkStaticImports,
} from "@src/test/staticImportGraph";

describe("mobile remote browser boundary", () => {
  const graph = walkStaticImports(["mobileRemoteEntry.tsx"]);
  const mobileAuthGraph = walkStaticImports([
    "modules/MobileRemote/auth/MobileAuthGate.tsx",
    "modules/MobileRemote/auth/mobileAuthClient.ts",
  ]);

  it("keeps desktop transcript renderers out of the public mobile bundle", () => {
    // Mobile may reuse the explicitly listed pure header/config leaves. Keep
    // the barrel and every stateful/renderer block outside the browser graph.
    const browserSafePrimitive =
      "primitives/(?:EventBlockHeader|EventBlockHeaderTextSlots|EventNavigateIcon|config|inSimulatorReplayContext|types)\\.(?:ts|tsx)$";
    const desktopOnlyModules = reachableFilesMatching(
      graph,
      new RegExp(
        `^(util/platform/(ipcRenderer|tauri)\\.ts|components/MarkDown/(MarkDownImpl|MarkdownLocalImage|LinkHoverCard)\\.tsx|engines/ChatPanel/(blocks/(?!${browserSafePrimitive})|rendering)/|engines/ChatPanel/ChatHistory/components/(UserMessageContent|UserMessagePills)\\.tsx|engines/SessionCore/.*EventStoreProxy|services/terminal/)`,
        "u"
      )
    );
    expect(
      desktopOnlyModules.map((file) => graph.explain(file)),
      "desktop transcript code became reachable from mobileRemoteEntry.tsx"
    ).toEqual([]);
  });

  it("keeps desktop auth implementations out of the public mobile bundle", () => {
    const forbiddenFiles = reachableFilesMatching(
      graph,
      /^(modules\/AppLogin\/|hooks\/auth\/|features\/Org2Cloud\/(?:org2CloudAuthAtom|completeSignIn|useOrg2CloudSignIn)\.tsx?|api\/http\/auth\/sharedAuthStorage\.ts)/u
    );
    expect(
      forbiddenFiles.map((file) => graph.explain(file)),
      "desktop auth code became reachable from mobileRemoteEntry.tsx"
    ).toEqual([]);
  });

  it("keeps the browser auth boundary free of every Tauri package", () => {
    const tauriPackages = [...mobileAuthGraph.packages].filter((name) =>
      name.startsWith("@tauri-apps/")
    );
    expect(
      tauriPackages.flatMap((name) =>
        importersOfPackage(mobileAuthGraph, name)
      ),
      "Tauri packages became reachable from the browser auth boundary"
    ).toEqual([]);
  });
});
