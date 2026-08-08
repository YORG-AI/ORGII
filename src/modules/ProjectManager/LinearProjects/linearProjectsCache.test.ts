import { afterEach, describe, expect, it, vi } from "vitest";

import { linearProjectsApi } from "@src/api/http/integrations";

import {
  LINEAR_PROJECTS_CACHE_TTL_MS,
  cachedLinearProjectsApi,
} from "./linearProjectsCache";

vi.mock("@src/api/http/integrations", () => ({
  linearProjectsApi: {
    listProjects: vi.fn(),
  },
}));

describe("linearProjectsCache", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("single-flights fresh reads and refreshes after the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T09:00:00.000Z"));
    const listProjects = vi.mocked(linearProjectsApi.listProjects);
    listProjects
      .mockResolvedValueOnce({
        projects: [],
        page_info: { has_next_page: false, end_cursor: null },
      })
      .mockResolvedValueOnce({
        projects: [],
        page_info: { has_next_page: false, end_cursor: null },
      });
    const connectionId = `connection-${crypto.randomUUID()}`;

    const first = cachedLinearProjectsApi.listProjects(connectionId);
    const concurrent = cachedLinearProjectsApi.listProjects(connectionId);
    await Promise.all([first, concurrent]);
    expect(listProjects).toHaveBeenCalledTimes(1);

    await cachedLinearProjectsApi.listProjects(connectionId);
    expect(listProjects).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(LINEAR_PROJECTS_CACHE_TTL_MS + 1);
    await cachedLinearProjectsApi.listProjects(connectionId);
    expect(listProjects).toHaveBeenCalledTimes(2);
  });

  it("single-flights overlapping forced refreshes", async () => {
    let release:
      | ((value: {
          projects: never[];
          page_info: { has_next_page: false; end_cursor: null };
        }) => void)
      | undefined;
    vi.mocked(linearProjectsApi.listProjects).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const connectionId = `forced-${crypto.randomUUID()}`;

    const first = cachedLinearProjectsApi.listProjects(connectionId, {
      forceRefresh: true,
    });
    const second = cachedLinearProjectsApi.listProjects(connectionId, {
      forceRefresh: true,
    });

    expect(linearProjectsApi.listProjects).toHaveBeenCalledTimes(1);
    release?.({
      projects: [],
      page_info: { has_next_page: false, end_cursor: null },
    });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });
});
