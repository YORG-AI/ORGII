import { describe, expect, it } from "vitest";

import { LatestRequestGuard } from "./latestRequestGuard";

describe("LatestRequestGuard", () => {
  it("allows only the latest request to commit", () => {
    const guard = new LatestRequestGuard();
    const backendSearch = guard.issue();
    const frontendSearch = guard.issue();

    expect(backendSearch.isCurrent()).toBe(false);
    expect(frontendSearch.isCurrent()).toBe(true);
  });

  it("prevents an older search from overwriting a newer result", async () => {
    const guard = new LatestRequestGuard();
    const committedResults: string[] = [];
    let resolveBackend!: (value: string) => void;
    let resolveFrontend!: (value: string) => void;
    const backendResult = new Promise<string>((resolve) => {
      resolveBackend = resolve;
    });
    const frontendResult = new Promise<string>((resolve) => {
      resolveFrontend = resolve;
    });

    const runSearch = async (result: Promise<string>) => {
      const ticket = guard.issue();
      const value = await result;
      if (ticket.isCurrent()) committedResults.push(value);
    };

    const olderSearch = runSearch(backendResult);
    const newerSearch = runSearch(frontendResult);
    resolveFrontend("docs/FRONTEND.md");
    await newerSearch;
    resolveBackend("docs/BACKEND_DESIGN.md");
    await olderSearch;

    expect(committedResults).toEqual(["docs/FRONTEND.md"]);
  });

  it("invalidates an in-flight request when the consumer resets", () => {
    const guard = new LatestRequestGuard();
    const request = guard.issue();

    guard.invalidate();

    expect(request.isCurrent()).toBe(false);
  });

  it("keeps a request current until it is superseded", () => {
    const guard = new LatestRequestGuard();
    const request = guard.issue();

    expect(request.isCurrent()).toBe(true);
    expect(request.isCurrent()).toBe(true);
  });
});
