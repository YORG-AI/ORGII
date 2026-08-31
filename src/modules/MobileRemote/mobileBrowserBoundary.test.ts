import { describe, expect, it } from "vitest";

import {
  reachableFilesMatching,
  walkStaticImports,
} from "@src/test/staticImportGraph";

describe("mobile remote browser boundary", () => {
  const graph = walkStaticImports(["mobileRemoteEntry.tsx"]);

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
});
