import { beforeEach, describe, expect, it, vi } from "vitest";

import { invalidateCache } from "../cache";
import type { PropertyDefinition } from "../types";
import {
  archivePropertyDefinition,
  listPropertyDefinitions,
  upsertPropertyDefinition,
} from "./workItemProperties";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const definition = (id: string, orgId = "org-1"): PropertyDefinition => ({
  id,
  orgId,
  name: id,
  propertyType: "text",
  config: { options: [] },
  position: 0,
  archivedAt: null,
  createdAt: "2026-09-03T00:00:00Z",
  updatedAt: "2026-09-03T00:00:00Z",
});

describe("property definition catalog cache", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invalidateCache();
  });

  it("single-flights reads and keeps active/all catalogs separate", async () => {
    invokeMock.mockResolvedValueOnce([definition("active")]);
    const first = listPropertyDefinitions("org-1");
    const concurrent = listPropertyDefinitions("org-1");
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      [definition("active")],
      [definition("active")],
    ]);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    invokeMock.mockResolvedValueOnce([definition("archived")]);
    await expect(listPropertyDefinitions("org-1", true)).resolves.toEqual([
      definition("archived"),
    ]);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates the owning org after definition writes", async () => {
    invokeMock.mockResolvedValueOnce([definition("before")]);
    await listPropertyDefinitions("org-1");

    invokeMock.mockResolvedValueOnce(definition("created"));
    await upsertPropertyDefinition({
      orgId: "org-1",
      name: "created",
      propertyType: "text",
    });
    invokeMock.mockResolvedValueOnce([definition("after-create")]);
    await expect(listPropertyDefinitions("org-1")).resolves.toEqual([
      definition("after-create"),
    ]);

    invokeMock.mockResolvedValueOnce(definition("archived"));
    await archivePropertyDefinition("archived", "org-1");
    invokeMock.mockResolvedValueOnce([]);
    await expect(listPropertyDefinitions("org-1")).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenCalledTimes(5);
  });
});
