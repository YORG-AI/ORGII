// @vitest-environment jsdom
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { SqlQueryEditor } from ".";

interface MockCodeMirrorProps {
  value: string;
  onChange: (value: string) => void;
}

const testState = vi.hoisted(() => {
  let releaseImport!: () => void;
  let markImportStarted!: () => void;

  return {
    codeMirrorProps: null as MockCodeMirrorProps | null,
    format: vi.fn((source: string) => `FORMATTED: ${source}`),
    importGate: new Promise<void>((resolve) => {
      releaseImport = resolve;
    }),
    importStarted: new Promise<void>((resolve) => {
      markImportStarted = resolve;
    }),
    releaseImport: () => releaseImport(),
    markImportStarted: () => markImportStarted(),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@uiw/react-codemirror", async () => {
  const ReactModule = await import("react");
  return {
    default: (props: MockCodeMirrorProps) => {
      testState.codeMirrorProps = props;
      return ReactModule.createElement("textarea", {
        "data-testid": "sql-code-mirror",
        value: props.value,
        readOnly: true,
      });
    },
  };
});

vi.mock("@codemirror/lang-sql", () => ({
  SQLite: {},
  sql: () => ({}),
}));

vi.mock("@codemirror/view", () => ({
  EditorView: { lineWrapping: {} },
  keymap: { of: () => ({}) },
}));

vi.mock("../config", () => ({
  BASIC_SETUP_SQL_CONFIG: {},
  codeMirrorCspNonceExtension: {},
  createCodeMirrorTheme: () => ({}),
  editorHistoryKeymapExtension: () => ({}),
  getCodeMirrorTheme: () => undefined,
}));

vi.mock("sql-formatter", async () => {
  testState.markImportStarted();
  await testState.importGate;
  return { format: testState.format };
});

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("SqlQueryEditor formatting", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("does not overwrite an edit made while sql-formatter is loading", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const source = "select * from users";
    const newerInput = "select id from users";
    await act(async () => {
      root.render(
        React.createElement(SqlQueryEditor, {
          defaultValue: source,
          onExecute: vi.fn(),
        })
      );
    });

    const formatButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("sqlEditor.format")
    );
    expect(formatButton).toBeDefined();

    await act(async () => {
      formatButton?.click();
      await testState.importStarted;
    });

    act(() => {
      testState.codeMirrorProps?.onChange(newerInput);
    });
    expect(testState.codeMirrorProps?.value).toBe(newerInput);

    await act(async () => {
      testState.releaseImport();
      await import("sql-formatter");
      await Promise.resolve();
    });

    expect(testState.format).toHaveBeenCalledWith(source, {
      language: "sqlite",
      tabWidth: 2,
      keywordCase: "upper",
    });
    expect(testState.codeMirrorProps?.value).toBe(newerInput);
  });
});
