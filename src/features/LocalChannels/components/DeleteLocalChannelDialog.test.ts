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

import DeleteLocalChannelDialog from "./DeleteLocalChannelDialog";

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

describe("DeleteLocalChannelDialog", () => {
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
          createElement(DeleteLocalChannelDialog, {
            open: true,
            channel: CHANNEL,
            onClose: overrides?.onClose ?? vi.fn(),
          })
        )
      );
    });
  }

  function deleteButton(): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(
      '[data-testid="local-channel-delete-confirm"]'
    );
  }

  function toggleAcknowledge() {
    const label = document.querySelector<HTMLLabelElement>(
      '[data-testid="local-channel-delete-acknowledge"] label'
    );
    expect(label).not.toBeNull();
    act(() => {
      label?.click();
    });
  }

  it("keeps the danger action disabled until the acknowledgement is checked", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });

    expect(deleteButton()?.disabled).toBe(true);

    // Clicking delete while disabled must be a no-op.
    act(() => {
      deleteButton()?.click();
    });
    expect(store.get(localChannelsAtom)).toHaveLength(1);

    toggleAcknowledge();
    expect(deleteButton()?.disabled).toBe(false);

    act(() => {
      deleteButton()?.click();
    });

    // Hard delete: the row is gone from the persisted store.
    expect(store.get(localChannelsAtom)).toEqual([]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("unchecking the acknowledgement disables the action again", () => {
    renderDialog();

    toggleAcknowledge();
    expect(deleteButton()?.disabled).toBe(false);
    toggleAcknowledge();
    expect(deleteButton()?.disabled).toBe(true);
  });

  it("surfaces a reducer failure inline without closing", () => {
    // A channel missing from the store (already removed elsewhere) makes the
    // reducer report "invalid" — the dialog must show the error, not close.
    store.set(localChannelsAtom, []);
    const onClose = vi.fn();
    renderDialog({ onClose });

    toggleAcknowledge();
    act(() => {
      deleteButton()?.click();
    });

    expect(
      document.querySelector('[data-testid="local-channel-delete-error"]')
        ?.textContent
    ).toBe("cloud.channels.delete.error");
    expect(onClose).not.toHaveBeenCalled();
  });
});
