// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StatusDefinition } from "@src/api/http/project";
import { invalidateCache } from "@src/api/http/project/cache";
import { projectStatusDefinitionsVersionAtom } from "@src/hooks/project/useProjectDataChanged";
import { type SmokeRoot, createSmokeRoot } from "@src/test/reactSmokeHarness";

import { useCustomStatusDefinitions } from "../useStatusDefinitions";

const mocks = vi.hoisted(() => ({ listStatusDefinitions: vi.fn() }));

vi.mock("@src/api/http/project", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/api/http/project")>();
  const { cachedRead } = await import("@src/api/http/project/cache");
  return {
    ...actual,
    projectApi: {
      ...actual.projectApi,
      listStatusDefinitions: (orgId: string, includeArchived: boolean) =>
        cachedRead(
          actual.statusDefinitionsCacheKey(orgId, includeArchived),
          () => mocks.listStatusDefinitions(orgId, includeArchived)
        ),
    },
  };
});

const definition = (name: string): StatusDefinition => ({
  id: `status-${name}`,
  orgId: "org-1",
  key: name,
  name,
  category: "planned",
  color: null,
  description: null,
  position: 0,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
});

function Harness({ onChange }: { onChange: (names: string[]) => void }) {
  const definitions = useCustomStatusDefinitions("org-1");
  useEffect(
    () => onChange(definitions.map((entry) => entry.name)),
    [definitions, onChange]
  );
  return null;
}

describe("useCustomStatusDefinitions resource projection", () => {
  let root: SmokeRoot;

  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCache();
    root = createSmokeRoot();
  });

  afterEach(async () => root.unmount());

  it("loads on a cold mount and refreshes only when its org version changes", async () => {
    const store = createStore();
    const seen: string[][] = [];
    mocks.listStatusDefinitions
      .mockResolvedValueOnce([definition("initial")])
      .mockResolvedValueOnce([definition("remote")]);

    await root.render(
      createElement(
        Provider,
        { store },
        createElement(Harness, {
          onChange: (names) => {
            seen.push(names);
          },
        })
      )
    );
    await act(async () => Promise.resolve());
    expect(seen.at(-1)).toEqual(["initial"]);

    act(() => {
      store.set(projectStatusDefinitionsVersionAtom, { "org-2": 1 });
    });
    expect(mocks.listStatusDefinitions).toHaveBeenCalledTimes(1);

    act(() => {
      invalidateCache("org-1");
      store.set(projectStatusDefinitionsVersionAtom, {
        "org-1": 1,
        "org-2": 1,
      });
    });
    await act(async () => Promise.resolve());
    expect(mocks.listStatusDefinitions).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)).toEqual(["remote"]);
  });
});
