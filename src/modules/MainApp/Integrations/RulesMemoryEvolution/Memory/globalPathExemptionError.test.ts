import { describe, expect, it } from "vitest";

import { RpcError } from "@src/api/tauri/rpc/invoke";

import { globalPathExemptionErrorMessage } from "./globalPathExemptionError";

describe("global path exemption errors", () => {
  it("keeps the backend non-existent-directory explanation visible", () => {
    const serverMessage =
      'Directory "/home/panshuainan/.agent" does not exist or is inaccessible: No such file or directory (os error 2)';

    expect(
      globalPathExemptionErrorMessage(
        new RpcError("global_path_exemptions_add", serverMessage)
      )
    ).toBe(`[RPC:global_path_exemptions_add] ${serverMessage}`);
  });
});
