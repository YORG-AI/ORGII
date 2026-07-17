import { describe, expect, it } from "vitest";

import {
  buildAddressCommentsPillPath,
  parseAddressCommentsSlashCommand,
} from "./addressCommentsSlashToken";

describe("buildAddressCommentsPillPath", () => {
  it("joins selected head ids after the token", () => {
    expect(buildAddressCommentsPillPath(["a", "b"])).toBe(
      "/address-comments:a,b"
    );
  });
});

describe("parseAddressCommentsSlashCommand", () => {
  it("parses a pill with ids and trailing instruction text", () => {
    const draft = parseAddressCommentsSlashCommand(
      "address 2 comments [skill:/address-comments:c-1,c-2] prefer minimal diffs"
    );
    expect(draft).toEqual({
      selectedHeadIds: ["c-1", "c-2"],
      instruction: "prefer minimal diffs",
    });
  });

  it("parses a pill without ids as all-unresolved", () => {
    expect(
      parseAddressCommentsSlashCommand(
        "address 3 comments [skill:/address-comments:]"
      )
    ).toEqual({});
  });

  it("parses the plain typed form with an instruction", () => {
    expect(
      parseAddressCommentsSlashCommand("/address-comments focus on tests")
    ).toEqual({ instruction: "focus on tests" });
    expect(parseAddressCommentsSlashCommand("/address-comments")).toEqual({});
  });

  it("returns null for ordinary messages", () => {
    expect(parseAddressCommentsSlashCommand("fix the bug")).toBeNull();
    expect(
      parseAddressCommentsSlashCommand("see /address-commentsish token")
    ).toBeNull();
  });

  it("round-trips the built pill path inside a serialized pill", () => {
    const path = buildAddressCommentsPillPath(["x"]);
    const draft = parseAddressCommentsSlashCommand(
      `address 1 comment [skill:${path}] tighten wording`
    );
    expect(draft).toEqual({
      selectedHeadIds: ["x"],
      instruction: "tighten wording",
    });
  });
});
