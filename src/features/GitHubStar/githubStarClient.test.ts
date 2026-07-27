import { afterEach, describe, expect, it, vi } from "vitest";

import { checkOrgiiStar, starOrgii } from "@src/api/tauri/githubStar";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.clearAllMocks());

describe("GitHub Star Tauri client", () => {
  it("single-flights concurrent checks and clears the flight afterward", async () => {
    const first = deferred<{ status: "not_starred" }>();
    invokeMock.mockReturnValueOnce(first.promise);

    const a = checkOrgiiStar();
    const b = checkOrgiiStar();

    expect(a).toBe(b);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("check_orgii_star");

    first.resolve({ status: "not_starred" });
    await a;
    invokeMock.mockResolvedValueOnce({ status: "starred" });
    await checkOrgiiStar();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("single-flights star requests independently from checks", async () => {
    const check = deferred<{ status: "not_starred" }>();
    const star = deferred<{ status: "starred" }>();
    invokeMock.mockImplementation((command: string) =>
      command === "check_orgii_star" ? check.promise : star.promise
    );

    const checkRequest = checkOrgiiStar();
    const firstStar = starOrgii();
    const secondStar = starOrgii();

    expect(firstStar).toBe(secondStar);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenCalledWith("star_orgii");

    check.resolve({ status: "not_starred" });
    star.resolve({ status: "starred" });
    await Promise.all([checkRequest, firstStar]);
  });
});
