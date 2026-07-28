import { describe, expect, it } from "vitest";

import { extractTodoData } from "../propsDataExtractors";
import { makeUniversalProps } from "./fixtures";

// ============================================
// extractTodoData
// ============================================

describe("extractTodoData", () => {
  describe("from result.observation as Python dict string", () => {
    it("parses Python dict with success.todos", () => {
      const props = makeUniversalProps({
        result: {
          observation:
            "{'success': {'todos': [{'id': 'todo-1', 'content': 'Implement feature', 'status': 'in_progress'}, {'id': 'todo-2', 'content': 'Write tests', 'status': 'pending'}], 'wasMerge': True}}",
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(2);
      expect(data.todos[0]).toEqual({
        id: "todo-1",
        content: "Implement feature",
        status: "in_progress",
      });
      expect(data.todos[1]).toEqual({
        id: "todo-2",
        content: "Write tests",
        status: "pending",
      });
      expect(data.wasMerge).toBe(true);
    });

    it("parses Python dict with direct todos (no success wrapper)", () => {
      const props = makeUniversalProps({
        result: {
          observation:
            "{'todos': [{'id': 't1', 'content': 'Task A', 'status': 'completed'}]}",
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].id).toBe("t1");
    });
  });

  describe("from result.observation as object", () => {
    it("extracts from observation object with success.todos", () => {
      const props = makeUniversalProps({
        result: {
          observation: {
            success: {
              todos: [
                { id: "obj-1", content: "Object task", status: "pending" },
              ],
              wasMerge: true,
            },
          },
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].content).toBe("Object task");
      expect(data.wasMerge).toBe(true);
    });

    it("extracts from observation object with direct todos", () => {
      const props = makeUniversalProps({
        result: {
          observation: {
            todos: [
              { id: "direct-1", content: "Direct task", status: "pending" },
            ],
          },
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].content).toBe("Direct task");
    });
  });

  describe("from args.todos (running events)", () => {
    it("extracts todos from args", () => {
      const props = makeUniversalProps({
        args: {
          todos: [
            { id: "a1", content: "Args task one", status: "in_progress" },
            { id: "a2", content: "Args task two", status: "pending" },
          ],
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(2);
      expect(data.todos[0].content).toBe("Args task one");
      expect(data.todos[1].content).toBe("Args task two");
    });
  });

  describe("from result.output.success.todos", () => {
    it("extracts from nested output success", () => {
      const props = makeUniversalProps({
        result: {
          output: {
            success: {
              todos: [
                { id: "s1", content: "Success task", status: "completed" },
              ],
            },
          },
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].status).toBe("completed");
    });
  });

  describe("from result.todos (direct)", () => {
    it("extracts from result.todos directly", () => {
      const props = makeUniversalProps({
        result: {
          todos: [{ id: "r1", content: "Result task", status: "pending" }],
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].id).toBe("r1");
    });
  });

  describe("wasMerge flag", () => {
    it("extracts wasMerge from success data in observation", () => {
      const props = makeUniversalProps({
        result: {
          observation: {
            success: {
              todos: [{ id: "m1", content: "task", status: "pending" }],
              wasMerge: true,
            },
          },
        },
      });
      expect(extractTodoData(props).wasMerge).toBe(true);
    });

    it("extracts wasMerge from result.output.success", () => {
      const props = makeUniversalProps({
        result: {
          output: {
            success: {
              todos: [{ id: "m2", content: "task", status: "pending" }],
              wasMerge: true,
            },
          },
        },
      });
      expect(extractTodoData(props).wasMerge).toBe(true);
    });

    it("extracts wasMerge from result.success", () => {
      const props = makeUniversalProps({
        result: {
          success: {
            todos: [{ id: "m3", content: "task", status: "pending" }],
            wasMerge: true,
          },
        },
      });
      expect(extractTodoData(props).wasMerge).toBe(true);
    });

    it("extracts wasMerge from result directly", () => {
      const props = makeUniversalProps({
        result: {
          todos: [{ id: "m4", content: "task", status: "pending" }],
          wasMerge: true,
        },
      });
      expect(extractTodoData(props).wasMerge).toBe(true);
    });

    it("defaults to false when wasMerge not present", () => {
      const props = makeUniversalProps({
        result: {
          todos: [{ id: "m5", content: "task", status: "pending" }],
        },
      });
      expect(extractTodoData(props).wasMerge).toBe(false);
    });
  });

  describe("JSON string todos", () => {
    it("parses todos from JSON string", () => {
      const todosJson = JSON.stringify([
        { id: "j1", content: "JSON task", status: "pending" },
      ]);
      const props = makeUniversalProps({
        result: { todos: todosJson },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].content).toBe("JSON task");
    });

    it("returns empty array for invalid JSON string", () => {
      const props = makeUniversalProps({
        result: { todos: "not valid json {{{" },
      });
      expect(extractTodoData(props).todos).toEqual([]);
    });
  });

  describe("Gemini format (description field)", () => {
    it("maps description to content", () => {
      const props = makeUniversalProps({
        result: {
          output: {
            success: {
              todos: [
                { id: "g1", description: "Gemini task one", status: "pending" },
                {
                  id: "g2",
                  description: "Gemini task two",
                  status: "completed",
                },
              ],
            },
          },
        },
      });
      const data = extractTodoData(props);
      expect(data.todos[0].content).toBe("Gemini task one");
      expect(data.todos[1].content).toBe("Gemini task two");
    });

    it("prefers content over description when both present", () => {
      const props = makeUniversalProps({
        result: {
          todos: [
            {
              id: "g3",
              content: "preferred",
              description: "fallback",
              status: "pending",
            },
          ],
        },
      });
      expect(extractTodoData(props).todos[0].content).toBe("preferred");
    });
  });

  describe("empty/invalid cases", () => {
    it("returns empty array for empty result", () => {
      const props = makeUniversalProps({ args: {}, result: {} });
      expect(extractTodoData(props).todos).toEqual([]);
    });

    it("returns empty array when todos is not an array", () => {
      const props = makeUniversalProps({
        result: { todos: { not: "array" } },
      });
      expect(extractTodoData(props).todos).toEqual([]);
    });

    it("returns empty array when todos is null", () => {
      const props = makeUniversalProps({
        result: { todos: null },
      });
      expect(extractTodoData(props).todos).toEqual([]);
    });

    it("defaults missing fields in todo items", () => {
      const props = makeUniversalProps({
        result: {
          todos: [{ id: "partial" }],
        },
      });
      const data = extractTodoData(props);
      expect(data.todos[0]).toEqual({
        id: "partial",
        content: "",
        status: "pending",
      });
    });

    it("defaults id to empty string when missing", () => {
      const props = makeUniversalProps({
        result: {
          todos: [{ content: "no id", status: "completed" }],
        },
      });
      expect(extractTodoData(props).todos[0].id).toBe("");
    });
  });

  describe("observation priority over fallback sources", () => {
    it("observation todos take priority over args.todos", () => {
      const props = makeUniversalProps({
        args: {
          todos: [{ id: "args-1", content: "from args", status: "pending" }],
        },
        result: {
          observation: {
            success: {
              todos: [
                { id: "obs-1", content: "from observation", status: "pending" },
              ],
            },
          },
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].content).toBe("from observation");
    });
  });

  describe("native ORGII content-text snapshot (regression: simulator '0 items')", () => {
    const nativeContent = [
      "Updated todo #1 — 2 todos (1 remaining)",
      JSON.stringify(
        [
          {
            activeForm: "Fixing bug",
            content: "Fix bug",
            index: 0,
            priority: "high",
            status: "completed",
          },
          {
            activeForm: null,
            blockedBy: [0],
            content: "Write tests",
            index: 1,
            priority: "medium",
            status: "in_progress",
          },
        ],
        null,
        2
      ),
      "",
      "Ensure that you continue to use the todo list to track your progress.",
    ].join("\n");

    it("parses todos from result.content text for update events (no args.todos)", () => {
      const props = makeUniversalProps({
        args: { action: "update", index: 1, status: "in_progress" },
        result: { content: nativeContent },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(2);
      expect(data.todos[0].id).toBe("0");
      expect(data.todos[0].content).toBe("Fix bug");
      expect(data.todos[0].activeForm).toBe("Fixing bug");
      expect(data.todos[1].status).toBe("in_progress");
      expect(data.todos[1].blockedBy).toEqual([0]);
      expect(data.todos[1].activeForm).toBeUndefined();
    });

    it("returns empty for 'No todos for this session.' text", () => {
      const props = makeUniversalProps({
        args: { action: "read" },
        result: { content: "No todos for this session." },
      });
      expect(extractTodoData(props).todos).toEqual([]);
    });
  });

  describe("structured uiMetadata (dual-track response)", () => {
    it("prefers uiMetadata.data.todos over text parsing", () => {
      const props = makeUniversalProps({
        args: { action: "update", index: 0 },
        result: {
          content: "garbled text without parseable snapshot",
          uiMetadata: {
            display_type: "todo_list",
            data: {
              todos: [
                {
                  index: 0,
                  content: "Ship feature",
                  status: "in_progress",
                  activeForm: "Shipping feature",
                },
              ],
            },
            summary: "Updated todo #0 — 1 todos (1 remaining)",
          },
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].id).toBe("0");
      expect(data.todos[0].content).toBe("Ship feature");
      expect(data.todos[0].activeForm).toBe("Shipping feature");
    });

    it("ignores uiMetadata with a different display_type", () => {
      const props = makeUniversalProps({
        result: {
          uiMetadata: { display_type: "search_results", data: { todos: [] } },
          todos: [{ id: "r1", content: "Result task", status: "pending" }],
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].id).toBe("r1");
    });
  });

  describe("rustExtracted short-circuit", () => {
    it("uses non-empty rustExtracted todos directly", () => {
      const props = makeUniversalProps({
        result: { content: "ignored" },
        rustExtracted: {
          kind: "todo",
          todos: [{ id: "rx-1", content: "Rust row", status: "pending" }],
          wasMerge: true,
        },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].id).toBe("rx-1");
      expect(data.wasMerge).toBe(true);
    });

    it("EMPTY rustExtracted does NOT short-circuit — falls through to content text", () => {
      const props = makeUniversalProps({
        args: { action: "update", index: 0 },
        result: {
          content:
            'Updated todo #0 — 1 todos (1 remaining)\n[\n  {\n    "content": "Recovered row",\n    "index": 0,\n    "status": "pending"\n  }\n]',
        },
        rustExtracted: { kind: "todo", todos: [], wasMerge: false },
      });
      const data = extractTodoData(props);
      expect(data.todos).toHaveLength(1);
      expect(data.todos[0].content).toBe("Recovered row");
    });
  });
});
