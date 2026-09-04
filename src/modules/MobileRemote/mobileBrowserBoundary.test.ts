import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  SRC_ROOT,
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
  const sharedRootGraph = walkStaticImports([
    "modules/MobileRemote/MobileRemoteRoot.tsx",
  ]);

  it("keeps desktop transcript renderers out of the public mobile bundle", () => {
    // Mobile may reuse the explicitly listed pure header/config leaves. Keep
    // the barrel and every stateful/renderer block outside the browser graph.
    const browserSafePrimitive =
      "primitives/(?:EventBlockHeader|EventBlockHeaderIcon|EventBlockHeaderTextSlots|EventNavigateIcon|config|inSimulatorReplayContext|types|useStrokeDraw)\\.(?:ts|tsx)$";
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

  it("keeps the shared root independent from the browser platform adapter", () => {
    const browserPlatformFiles = reachableFilesMatching(
      sharedRootGraph,
      /^modules\/MobileRemote\/platform\/browser\//u
    );
    expect(
      browserPlatformFiles.map((file) => sharedRootGraph.explain(file)),
      "the platform-neutral MobileRemoteRoot reached the browser adapter"
    ).toEqual([]);
  });

  it("keeps browser globals out of the shared root import graph", () => {
    const browserGlobalPattern =
      /\b(?:window|document)\.|\b(?:localStorage|sessionStorage)\b/u;
    const offenders = [...sharedRootGraph.files]
      .filter((file) =>
        path
          .relative(SRC_ROOT, file)
          .startsWith(`modules${path.sep}MobileRemote${path.sep}`)
      )
      .filter((file) => browserGlobalPattern.test(readFileSync(file, "utf8")))
      .map((file) => sharedRootGraph.explain(path.relative(SRC_ROOT, file)));

    expect(
      offenders,
      "browser globals became reachable from the platform-neutral MobileRemoteRoot"
    ).toEqual([]);
  });
});
