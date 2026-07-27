// @vitest-environment jsdom
import type { TFunction } from "i18next";
import { act, createElement, useState } from "react";
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

import CloudOrgRepoScopesSection from "./CloudOrgRepoScopesSection";

const mocks = vi.hoisted(() => ({
  pickerMounted: vi.fn(),
  pickerUnmounted: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === "actions.add") return "Add";
      if (key === "actions.cancel") return "Cancel";
      if (key === "actions.undo") return "Undo";
      if (key === "placeholders.unsavedEdits") return "Unsaved edits";
      return key;
    },
  }),
}));

vi.mock(
  "@src/features/TeamCollaboration/components/RepoScopePicker",
  async () => {
    const React = await import("react");
    function MockRepoScopePicker({
      selectedKeys,
      onChange,
    }: {
      selectedKeys: string[];
      onChange: (keys: string[]) => void;
    }) {
      React.useEffect(() => {
        mocks.pickerMounted();
        return () => mocks.pickerUnmounted();
      }, []);
      return React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "repo-scope-picker-stub",
          onClick: () =>
            onChange([...selectedKeys, "github.com/example/new-repo"]),
        },
        "Choose repository"
      );
    }
    return {
      default: MockRepoScopePicker,
    };
  }
);

const t = ((key: string) => key) as TFunction<"navigation">;
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function RepoScopesHarness({
  initialScopes,
  onSave,
}: {
  initialScopes: string[];
  onSave: (scopes: string[]) => void;
}) {
  const [savedScopes, setSavedScopes] = useState(initialScopes);
  const [draftScopes, setDraftScopes] = useState(initialScopes);
  const scopesDirty =
    savedScopes.length !== draftScopes.length ||
    savedScopes.some((scope, index) => scope !== draftScopes[index]);

  return createElement(CloudOrgRepoScopesSection, {
    t,
    isAdmin: true,
    savedScopes,
    draftScopes,
    setDraftScopes,
    scopesDirty,
    scopeQuota: null,
    savingScopes: false,
    scopesSaved: false,
    scopesError: null,
    onSaveScopes: async () => {
      onSave(draftScopes);
      setSavedScopes(draftScopes);
    },
    openCloudBillingPage: vi.fn(),
  });
}

describe("CloudOrgRepoScopesSection", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("shows the repository picker only after the localized Add action", async () => {
    const setDraftScopes = vi.fn();
    await act(async () => {
      root.render(
        createElement(CloudOrgRepoScopesSection, {
          t,
          isAdmin: true,
          savedScopes: ["github.com/example/existing"],
          draftScopes: ["github.com/example/existing"],
          setDraftScopes,
          scopesDirty: false,
          scopeQuota: null,
          savingScopes: false,
          scopesSaved: false,
          scopesError: null,
          onSaveScopes: vi.fn().mockResolvedValue(undefined),
          openCloudBillingPage: vi.fn(),
        })
      );
    });

    const addButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="cloud-org-add-repo-scope"]'
    );
    expect(addButton?.textContent).toBe("Add");
    expect(
      container.querySelector('[data-testid="cloud-org-cancel-repo-scopes"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="cloud-org-save-repo-scopes"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="repo-scope-picker-stub"]')
    ).toBeNull();
    const settingsCard = container.querySelector(
      '[data-testid="cloud-org-repo-scope"]'
    );
    const note = container.querySelector(
      '[data-testid="cloud-org-repo-scopes-note"]'
    );
    expect(note).not.toBeNull();
    expect(settingsCard?.contains(note)).toBe(false);
    expect(mocks.pickerMounted).not.toHaveBeenCalled();

    await act(async () => addButton?.click());
    expect(
      container.querySelector('[data-testid="cloud-org-add-repo-scope"]')
    ).toBeNull();
    const picker = container.querySelector<HTMLButtonElement>(
      '[data-testid="repo-scope-picker-stub"]'
    );
    expect(picker).not.toBeNull();
    expect(mocks.pickerMounted).toHaveBeenCalledTimes(1);
    const cancelAddButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="cloud-org-cancel-add-repo-scope"]'
    );
    expect(cancelAddButton?.textContent).toBe("Cancel");

    await act(async () => cancelAddButton?.click());
    expect(setDraftScopes).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="repo-scope-picker-stub"]')
    ).toBeNull();
    expect(mocks.pickerUnmounted).toHaveBeenCalledTimes(1);

    const reopenedAddButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="cloud-org-add-repo-scope"]'
    );
    expect(reopenedAddButton?.textContent).toBe("Add");
    await act(async () => reopenedAddButton?.click());
    expect(mocks.pickerMounted).toHaveBeenCalledTimes(2);

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="repo-scope-picker-stub"]'
        )
        ?.click()
    );
    expect(setDraftScopes).toHaveBeenCalledWith([
      "github.com/example/existing",
      "github.com/example/new-repo",
    ]);
    expect(
      container.querySelector('[data-testid="repo-scope-picker-stub"]')
    ).toBeNull();
    const addButtonAfterSelection = container.querySelector<HTMLButtonElement>(
      '[data-testid="cloud-org-add-repo-scope"]'
    );
    expect(addButtonAfterSelection?.textContent).toBe("Add");
    expect(mocks.pickerUnmounted).toHaveBeenCalledTimes(2);

    await act(async () => addButtonAfterSelection?.click());
    expect(mocks.pickerMounted).toHaveBeenCalledTimes(3);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="repo-scope-picker-stub"]'
        )
        ?.click()
    );
    expect(mocks.pickerUnmounted).toHaveBeenCalledTimes(3);
    expect(
      container.querySelector('[data-testid="repo-scope-picker-stub"]')
    ).toBeNull();
  });

  it("stages an addition until Save is pressed", async () => {
    const onSave = vi.fn();
    await act(async () => {
      root.render(
        createElement(RepoScopesHarness, {
          initialScopes: ["github.com/example/existing"],
          onSave,
        })
      );
    });

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="cloud-org-add-repo-scope"]'
        )
        ?.click()
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="repo-scope-picker-stub"]'
        )
        ?.click()
    );

    expect(onSave).not.toHaveBeenCalled();
    expect(
      container.querySelector('[title="github.com/example/new-repo"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="cloud-org-repo-scopes-unsaved"]')
        ?.textContent
    ).toBe("Unsaved edits");
    const rowUnsavedLabel = container.querySelector<HTMLElement>(
      '[data-testid="cloud-org-repo-scope-row-unsaved"]'
    );
    const cancelAdditionButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="cloud-org-cancel-repo-scope-addition"]'
    );
    expect(rowUnsavedLabel?.classList).toContain("text-warning-6");
    expect(cancelAdditionButton?.textContent).toBe("Cancel");
    expect(
      rowUnsavedLabel?.compareDocumentPosition(cancelAdditionButton as Node)
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const saveButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="cloud-org-save-repo-scopes"]'
    );
    expect(saveButton?.disabled).toBe(false);
    const cancelButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="cloud-org-cancel-repo-scopes"]'
    );
    const addButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="cloud-org-add-repo-scope"]'
    );
    expect(cancelButton?.textContent).toBe("Cancel");
    expect(addButton?.closest(".section-layout-row")).toBe(
      saveButton?.closest(".section-layout-row")
    );
    expect(cancelButton?.compareDocumentPosition(saveButton as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(cancelButton?.parentElement?.classList).toContain("ml-auto");
    expect(cancelButton?.parentElement?.classList).toContain("justify-end");

    await act(async () => cancelButton?.click());
    expect(onSave).not.toHaveBeenCalled();
    expect(
      container.querySelector('[title="github.com/example/new-repo"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="cloud-org-save-repo-scopes"]')
    ).toBeNull();

    await act(async () => addButton?.click());
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="repo-scope-picker-stub"]'
        )
        ?.click()
    );

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="cloud-org-save-repo-scopes"]'
        )
        ?.click()
    );
    expect(onSave).toHaveBeenCalledWith([
      "github.com/example/existing",
      "github.com/example/new-repo",
    ]);
    expect(
      container.querySelector('[data-testid="cloud-org-repo-scopes-unsaved"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="cloud-org-save-repo-scopes"]')
    ).toBeNull();
  });

  it("stages a removal and keeps it undoable until Save is pressed", async () => {
    const onSave = vi.fn();
    await act(async () => {
      root.render(
        createElement(RepoScopesHarness, {
          initialScopes: [
            "github.com/example/existing",
            "github.com/example/second",
          ],
          onSave,
        })
      );
    });

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="cloud-org-remove-repo-scope"]'
        )
        ?.click()
    );

    expect(onSave).not.toHaveBeenCalled();
    expect(
      container.querySelector('[title="github.com/example/existing"]')
        ?.classList
    ).toContain("line-through");
    expect(
      container.querySelector(
        '[data-testid="cloud-org-undo-repo-scope-removal"]'
      )
    ).not.toBeNull();
    const removalUnsavedLabel = container.querySelector<HTMLElement>(
      '[data-testid="cloud-org-repo-scope-row-unsaved"]'
    );
    const undoRemovalButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="cloud-org-undo-repo-scope-removal"]'
    );
    expect(removalUnsavedLabel?.classList).toContain("text-warning-6");
    expect(
      removalUnsavedLabel?.compareDocumentPosition(undoRemovalButton as Node)
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const initialSaveButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="cloud-org-save-repo-scopes"]'
    );
    expect(initialSaveButton?.disabled).toBe(false);

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="cloud-org-undo-repo-scope-removal"]'
        )
        ?.click()
    );
    expect(
      container.querySelector('[data-testid="cloud-org-save-repo-scopes"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="cloud-org-repo-scopes-unsaved"]')
    ).toBeNull();

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="cloud-org-remove-repo-scope"]'
        )
        ?.click()
    );

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="cloud-org-save-repo-scopes"]'
        )
        ?.click()
    );
    expect(onSave).toHaveBeenCalledWith(["github.com/example/second"]);
    expect(
      container.querySelector('[title="github.com/example/existing"]')
    ).toBeNull();
  });
});
