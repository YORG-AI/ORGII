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
  LOCAL_CHANNEL_MAX_ACTIVE,
  type LocalChannel,
  localChannelsAtom,
} from "@src/store/ui/localChannelsAtom";

import CreateLocalChannelDialog from "./CreateLocalChannelDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const NOW = "2026-07-31T00:00:00.000Z";

function makeChannel(overrides: Partial<LocalChannel> = {}): LocalChannel {
  return {
    id: "ch-1",
    name: "general",
    topic: undefined,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("CreateLocalChannelDialog", () => {
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
          createElement(CreateLocalChannelDialog, {
            open: true,
            onClose: overrides?.onClose ?? vi.fn(),
          })
        )
      );
    });
  }

  function nameInput(): HTMLInputElement {
    const element = document.querySelector<HTMLInputElement>(
      '[data-testid="local-channel-create-name"]'
    );
    expect(element).not.toBeNull();
    return element as HTMLInputElement;
  }

  function typeName(value: string): HTMLInputElement {
    const element = nameInput();
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
          '[data-testid="local-channel-create-submit"]'
        )
        ?.click();
    });
  }

  function errorText(): string | undefined {
    return (
      document.querySelector('[data-testid="local-channel-create-error"]')
        ?.textContent ?? undefined
    );
  }

  it("live-normalizes like the cloud dialog and persists the created channel", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });

    // Slack behavior: leading '#' stripped, lowercased, spaces → hyphens.
    const input = typeName("#Code Review");
    expect(input.value).toBe("code-review");

    clickSubmit();

    const stored = store.get(localChannelsAtom);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe("code-review");
    expect(stored[0]?.archivedAt).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    // Success clears the draft for the next open.
    expect(nameInput().value).toBe("");
  });

  it("surfaces name-taken inline and preserves the form", () => {
    store.set(localChannelsAtom, [makeChannel({ name: "code-review" })]);
    const onClose = vi.fn();
    renderDialog({ onClose });

    // Case-insensitive collision with the stored (already-normalized) name.
    typeName("Code Review");
    clickSubmit();

    expect(errorText()).toBe("cloud.channels.create.nameTaken");
    // Failure must NEVER clear the form, and nothing may be written.
    expect(nameInput().value).toBe("code-review");
    expect(store.get(localChannelsAtom)).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("surfaces the device quota error at the active-channel cap", () => {
    store.set(
      localChannelsAtom,
      Array.from({ length: LOCAL_CHANNEL_MAX_ACTIVE }, (_, index) =>
        makeChannel({ id: `ch-${index}`, name: `channel-${index}` })
      )
    );
    renderDialog();

    typeName("one-more");
    clickSubmit();

    expect(errorText()).toBe("cloud.channels.local.quotaExceeded");
    expect(store.get(localChannelsAtom)).toHaveLength(LOCAL_CHANNEL_MAX_ACTIVE);
  });
});
