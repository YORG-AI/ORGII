// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type SmokeRoot, createSmokeRoot } from "@src/test/reactSmokeHarness";

import { useWorkItemRevisionConflict } from "../useWorkItemRevisionConflict";

const messageMocks = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@src/components/Message", () => ({ default: messageMocks }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

interface Attempt {
  name?: string;
  spec?: string;
}

interface RecordSnapshot {
  title: string;
  body: string;
  revision: number;
}

type ConflictApi = ReturnType<
  typeof useWorkItemRevisionConflict<Attempt, RecordSnapshot>
>;

let api: ConflictApi;
const readLatest =
  vi.fn<(attempt: Attempt) => Promise<RecordSnapshot | null>>();
const retry =
  vi.fn<(attempt: Attempt, revision: number) => Promise<RecordSnapshot>>();
const acceptRecord = vi.fn<(record: RecordSnapshot) => void>();

function Harness({
  identityKey = "item-1",
  onReady,
}: {
  identityKey?: string;
  onReady: (nextApi: ConflictApi) => void;
}) {
  const nextApi = useWorkItemRevisionConflict({
    identityKey,
    readLatest,
    retry,
    acceptRecord,
    recordTitle: (record) => record.title,
    recordDescription: (record) => record.body,
    recordRevision: (record) => record.revision,
  });
  useEffect(() => onReady(nextApi), [nextApi, onReady]);
  return null;
}

const captureApi = (nextApi: ConflictApi) => {
  api = nextApi;
};

describe("useWorkItemRevisionConflict", () => {
  let root: SmokeRoot;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = createSmokeRoot();
    await root.render(createElement(Harness, { onReady: captureApi }));
  });

  afterEach(async () => {
    await root.unmount();
  });

  it("owns reload, conflict projection, and keep-mine CAS retry", async () => {
    const latest = { title: "theirs", body: "body", revision: 4 };
    const retried = { title: "mine", body: "body", revision: 5 };
    readLatest.mockResolvedValueOnce(latest);
    retry.mockResolvedValueOnce(retried);

    await act(async () => {
      await expect(
        api.handleRevisionConflict(
          new Error("PM_ERR:REVISION_CONFLICT:expected=2:actual=4"),
          { name: "mine" }
        )
      ).resolves.toBe(true);
    });

    expect(acceptRecord).toHaveBeenLastCalledWith(latest);
    expect(api.revisionConflict).toEqual({
      field: "title",
      mine: "mine",
      latest: "theirs",
      expectedRevision: 2,
      actualRevision: 4,
    });

    await act(async () => {
      await api.keepMineRevisionConflict();
    });
    expect(retry).toHaveBeenCalledWith({ name: "mine" }, 4);
    expect(acceptRecord).toHaveBeenLastCalledWith(retried);
    expect(api.revisionConflict).toBeNull();
  });

  it("reloads the latest row again when keep-mine loses a second CAS", async () => {
    readLatest
      .mockResolvedValueOnce({ title: "v2", body: "body", revision: 2 })
      .mockResolvedValueOnce({ title: "v3", body: "body", revision: 3 });
    retry.mockRejectedValueOnce(
      new Error("PM_ERR:REVISION_CONFLICT:expected=2:actual=3")
    );

    await act(async () => {
      await api.handleRevisionConflict(
        new Error("PM_ERR:REVISION_CONFLICT:expected=1:actual=2"),
        { name: "mine" }
      );
    });
    await act(async () => {
      await api.keepMineRevisionConflict();
    });

    expect(acceptRecord).toHaveBeenLastCalledWith({
      title: "v3",
      body: "body",
      revision: 3,
    });
    expect(api.revisionConflict).toMatchObject({
      latest: "v3",
      expectedRevision: 2,
      actualRevision: 3,
    });
    expect(messageMocks.warning).toHaveBeenCalledWith(
      "workItems.revisionConflict.retryFailed",
      5000
    );
  });

  it("clears a pending conflict across an A to B to A identity cycle", async () => {
    readLatest.mockResolvedValueOnce({
      title: "theirs",
      body: "body",
      revision: 2,
    });
    await act(async () => {
      await api.handleRevisionConflict(
        new Error("PM_ERR:REVISION_CONFLICT:expected=1:actual=2"),
        { name: "mine" }
      );
    });
    expect(api.revisionConflict).not.toBeNull();

    await root.render(
      createElement(Harness, {
        identityKey: "item-2",
        onReady: captureApi,
      })
    );
    expect(api.revisionConflict).toBeNull();

    await root.render(
      createElement(Harness, {
        identityKey: "item-1",
        onReady: captureApi,
      })
    );
    expect(api.revisionConflict).toBeNull();
  });
});
