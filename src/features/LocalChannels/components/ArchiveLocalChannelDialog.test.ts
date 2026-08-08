// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  LOCAL_CHANNELS_STORAGE_KEY,
  type LocalChannel,
  localChannelsAtom,
} from "@src/store/ui/localChannelsAtom";

import ArchiveLocalChannelDialog from "./ArchiveLocalChannelDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const CHANNEL: LocalChannel = {
  id: "chan-1",
  name: "code-review",
  topic: undefined,
  createdAt: "2026-07-31T00:00:00.000Z",
  updatedAt: "2026-07-31T00:00:00.000Z",
  archivedAt: null,
};

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("ArchiveLocalChannelDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem(LOCAL_CHANNELS_STORAGE_KEY);
    store = createStore();
    store.set(localChannelsAtom, [CHANNEL]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function renderDialog(overrides?: { onClose?: () => void }) {
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(ArchiveLocalChannelDialog, {
            open: true,
            channel: CHANNEL,
            onClose: overrides?.onClose ?? vi.fn(),
          })
        )
      );
    });
  }

  function archiveButton(): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(
      '[data-testid="local-channel-archive-confirm"]'
    );
  }

  it("soft-archives the channel and closes", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });

    act(() => {
      archiveButton()?.click();
    });

    const stored = store.get(localChannelsAtom);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.archivedAt).not.toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces a reducer failure inline without closing", () => {
    // A channel missing from the store (already deleted elsewhere) makes the
    // reducer report "invalid" — the dialog must show the error, not close.
    store.set(localChannelsAtom, []);
    const onClose = vi.fn();
    renderDialog({ onClose });

    act(() => {
      archiveButton()?.click();
    });

    expect(
      document.querySelector('[data-testid="local-channel-archive-error"]')
        ?.textContent
    ).toBe("cloud.channels.archive.error");
    expect(onClose).not.toHaveBeenCalled();
  });
});
