import { afterEach, describe, expect, it, vi } from "vitest";

import { getGitRemotes } from "./remotes";

function response(options: {
  ok: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
}): Response {
  return {
    ok: options.ok,
    status: options.status ?? (options.ok ? 200 : 404),
    statusText: options.statusText ?? "",
    text: vi.fn().mockResolvedValue(JSON.stringify(options.body ?? {})),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getGitRemotes", () => {
  it.each(["Invalid path", "Repository not found"])(
    "keeps %s retryable instead of caching an empty remote list",
    async (message) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        response({ ok: false, body: { error: message } })
      );

      await expect(
        getGitRemotes({ repo_id: "C:\\Repos\\ORGII" })
      ).resolves.toBeUndefined();
    }
  );

  it("returns a cacheable empty list for a confirmed plain folder", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({ ok: false, body: { error: "Not a git repository" } })
    );

    await expect(
      getGitRemotes({ repo_id: "C:\\Projects\\plain-folder" })
    ).resolves.toEqual({ remotes: [] });
  });
});
