import { describe, expect, it } from "vitest";

import { SESSION_TARGET_KIND } from "@src/store/session/creatorStateAtom";

import { createHumanSessionOption } from "./humanSessionOption";

describe("createHumanSessionOption", () => {
  it("builds the non-runnable Work log target for both picker variants", () => {
    expect(createHumanSessionOption("Work log")).toMatchObject({
      id: "human-session",
      name: "Work log",
      desc: "",
      category: "human_session",
      targetKind: SESSION_TARGET_KIND.HUMAN,
      isBuiltIn: true,
      isCli: false,
      isOrg: false,
    });
  });
});
