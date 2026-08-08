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

import LocalChannelSettingsDialog from "./LocalChannelSettingsDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const NOW = "2026-07-31T00:00:00.000Z";

const TARGET: LocalChannel = {
  id: "ch-a",
  name: "general",
  topic: "hello",
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};

/** Archived sibling: its name stays reserved (cloud 0014 semantics). */
const RESERVED: LocalChannel = {
  id: "ch-b",
  name: "reserved",
  topic: undefined,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: NOW,
};

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("LocalChannelSettingsDialog", () => {
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
    store.set(localChannelsAtom, [TARGET, RESERVED]);
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
          createElement(LocalChannelSettingsDialog, {
            open: true,
            channel: TARGET,
            onClose: overrides?.onClose ?? vi.fn(),
          })
        )
      );
    });
  }

  function input(testId: string): HTMLInputElement {
    const element = document.querySelector<HTMLInputElement>(
      `[data-testid="${testId}"]`
    );
    expect(element).not.toBeNull();
    return element as HTMLInputElement;
  }

  function typeInto(testId: string, value: string): HTMLInputElement {
    const element = input(testId);
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      valueSetter?.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return element;
  }

  function clickSubmit(): void {
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="local-channel-settings-submit"]'
        )
        ?.click();
    });
  }

  it("seeds from the channel and persists a normalized rename via the write atom", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });

    expect(input("local-channel-settings-name").value).toBe("general");
    expect(input("local-channel-settings-topic").value).toBe("hello");

    const nameInput = typeInto("local-channel-settings-name", "#New  Name");
    expect(nameInput.value).toBe("new-name");
    clickSubmit();

    const stored = store.get(localChannelsAtom);
    const renamed = stored.find((channel) => channel.id === "ch-a");
    expect(renamed?.name).toBe("new-name");
    expect(renamed?.topic).toBe("hello");
    // The sibling row is untouched.
    expect(stored.find((channel) => channel.id === "ch-b")?.name).toBe(
      "reserved"
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces a collision with an archived name inline and keeps the form", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });

    typeInto("local-channel-settings-name", "Reserved");
    clickSubmit();

    expect(
      document.querySelector('[data-testid="local-channel-settings-error"]')
        ?.textContent
    ).toBe("cloud.channels.create.nameTaken");
    // Failure must NEVER clear the form, and nothing may be written.
    expect(input("local-channel-settings-name").value).toBe("reserved");
    expect(
      store.get(localChannelsAtom).find((channel) => channel.id === "ch-a")
        ?.name
    ).toBe("general");
    expect(onClose).not.toHaveBeenCalled();
  });
});
