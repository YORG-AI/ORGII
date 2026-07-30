/**
 * Flow Awareness Test Component
 *
 * Interactive test interface to verify Flow Awareness system functionality.
 * Tests activity recording, intent inference, and context generation.
 */
import { useCallback, useState } from "react";

import { useFlowAwareness } from "@src/hooks/flowAwareness";
import type { FlowSummary } from "@src/hooks/flowAwareness/types";

interface FlowAwarenessTestProps {
  sessionId?: string;
}

export function FlowAwarenessTest({
  sessionId = "test-session-001",
}: FlowAwarenessTestProps) {
  const [output, setOutput] = useState<string>("");
  const [summary, setSummary] = useState<FlowSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const {
    recordFileEdit,
    recordFileOpen,
    recordTerminalCommand,
    recordSearch,
    recordGitOperation,
    recordError,
    recordDebug,
    getContext,
    getSummary,
    clearSession,
  } = useFlowAwareness({ sessionId });

  const log = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setOutput((prev) => `${prev}[${timestamp}] ${message}\n`);
  }, []);

  // Test different activity types
  const testFileEdit = useCallback(() => {
    log("📝 Recording file edit...");
    recordFileEdit("src/components/TestComponent.tsx", "modify", 25);
    log("✅ File edit recorded");
  }, [recordFileEdit, log]);

  const testFileOpen = useCallback(() => {
    log("📂 Recording file open...");
    recordFileOpen("src/utils/helpers.ts");
    log("✅ File open recorded");
  }, [recordFileOpen, log]);

  const testTerminalCommand = useCallback(() => {
    log("💻 Recording terminal command...");
    recordTerminalCommand("npm test", "/project", 0);
    log("✅ Terminal command recorded");
  }, [recordTerminalCommand, log]);

  const testSearch = useCallback(() => {
    log("🔍 Recording search...");
    recordSearch("useFlowAwareness", "codebase", 5);
    log("✅ Search recorded");
  }, [recordSearch, log]);

  const testError = useCallback(() => {
    log("❌ Recording error...");
    recordError("lint", "Cannot find name 'foo'", "src/api/client.ts", 42);
    log("✅ Error recorded");
  }, [recordError, log]);

  const testGitOperation = useCallback(() => {
    log("📦 Recording git operation...");
    recordGitOperation("commit", "feat: add flow awareness test");
    log("✅ Git operation recorded");
  }, [recordGitOperation, log]);

  // Test pattern: debugging scenario
  const testDebuggingScenario = useCallback(async () => {
    log("🔧 Testing debugging scenario...");

    // Simulate debugging workflow
    recordFileOpen("src/components/Button.tsx");
    recordError(
      "type_check",
      "Property 'onClick' does not exist",
      "src/components/Button.tsx",
      15
    );
    recordFileEdit("src/components/Button.tsx", "modify", 3);
    recordTerminalCommand("npm run type-check", "/project", 1);
    recordDebug("set_breakpoint", "src/components/Button.tsx", 15);
    recordFileEdit("src/components/Button.tsx", "modify", 2);
    recordTerminalCommand("npm run type-check", "/project", 0);

    log("✅ Debugging scenario completed");
  }, [
    recordFileOpen,
    recordError,
    recordFileEdit,
    recordTerminalCommand,
    recordDebug,
    log,
  ]);

  // Test pattern: refactoring scenario
  const testRefactoringScenario = useCallback(() => {
    log("🔧 Testing refactoring scenario...");

    // Simulate refactoring workflow
    recordSearch("useAuth", "codebase", 8);
    recordFileOpen("src/hooks/useAuth.ts");
    recordFileOpen("src/components/LoginForm.tsx");
    recordFileOpen("src/pages/Dashboard.tsx");
    recordFileEdit("src/hooks/useAuth.ts", "modify", 15);
    recordFileEdit("src/components/LoginForm.tsx", "modify", 8);
    recordFileEdit("src/pages/Dashboard.tsx", "modify", 3);
    recordTerminalCommand("npm run test -- auth", "/project", 0);

    log("✅ Refactoring scenario completed");
  }, [
    recordSearch,
    recordFileOpen,
    recordFileEdit,
    recordTerminalCommand,
    log,
  ]);

  // Get context and summary
  const testGetContext = useCallback(async () => {
    setIsLoading(true);
    log("📊 Getting flow context...");

    try {
      const context = await getContext();
      log("📋 Flow Context:");
      log(context || "(No context available)");

      const flowSummary = await getSummary();
      setSummary(flowSummary);
      log("📈 Flow Summary retrieved (see below)");
    } catch (err) {
      log(`❌ Error getting context: ${err}`);
    } finally {
      setIsLoading(false);
    }
  }, [getContext, getSummary, log]);

  const testClearSession = useCallback(async () => {
    log("🗑️ Clearing session...");
    try {
      await clearSession();
      setSummary(null);
      log("✅ Session cleared");
    } catch (err) {
      log(`❌ Error clearing session: ${err}`);
    }
  }, [clearSession, log]);

  const clearOutput = useCallback(() => {
    setOutput("");
    setSummary(null);
  }, []);

  return (
    <div className="flow-awareness-test mx-auto max-w-4xl p-6">
      <h1 className="mb-6 text-2xl font-bold">Flow Awareness Test Interface</h1>

      <div className="mb-6">
        <p className="mb-2 text-gray-600">
          Session ID:{" "}
          <code className="rounded bg-gray-100 px-2 py-1">{sessionId}</code>
        </p>
      </div>

      {/* Individual Tests */}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        <button
          onClick={testFileEdit}
          className="rounded bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600"
        >
          📝 File Edit
        </button>
        <button
          onClick={testFileOpen}
          className="rounded bg-green-500 px-4 py-2 text-sm text-white hover:bg-green-600"
        >
          📂 File Open
        </button>
        <button
          onClick={testTerminalCommand}
          className="rounded bg-purple-500 px-4 py-2 text-sm text-white hover:bg-purple-600"
        >
          💻 Terminal
        </button>
        <button
          onClick={testSearch}
          className="rounded bg-yellow-500 px-4 py-2 text-sm text-white hover:bg-yellow-600"
        >
          🔍 Search
        </button>
        <button
          onClick={testError}
          className="rounded bg-red-500 px-4 py-2 text-sm text-white hover:bg-red-600"
        >
          ❌ Error
        </button>
        <button
          onClick={testGitOperation}
          className="rounded bg-indigo-500 px-4 py-2 text-sm text-white hover:bg-indigo-600"
        >
          📦 Git Op
        </button>
      </div>

      {/* Scenario Tests */}
      <div className="mb-6 flex gap-3">
        <button
          onClick={testDebuggingScenario}
          className="rounded bg-orange-500 px-6 py-2 text-white hover:bg-orange-600"
        >
          🔧 Test Debugging Flow
        </button>
        <button
          onClick={testRefactoringScenario}
          className="rounded bg-teal-500 px-6 py-2 text-white hover:bg-teal-600"
        >
          🔄 Test Refactoring Flow
        </button>
      </div>

      {/* Analysis */}
      <div className="mb-6 flex gap-3">
        <button
          onClick={testGetContext}
          disabled={isLoading}
          className="rounded bg-gray-700 px-6 py-2 text-white hover:bg-gray-800 disabled:bg-gray-400"
        >
          {isLoading ? "⏳ Loading..." : "📊 Get Context & Summary"}
        </button>
        <button
          onClick={testClearSession}
          className="rounded bg-red-600 px-6 py-2 text-white hover:bg-red-700"
        >
          🗑️ Clear Session
        </button>
        <button
          onClick={clearOutput}
          className="rounded bg-gray-500 px-4 py-2 text-white hover:bg-gray-600"
        >
          Clear Output
        </button>
      </div>

      {/* Output Log */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-3 text-lg font-semibold">Activity Log</h3>
          <pre className="h-80 overflow-y-auto whitespace-pre-wrap rounded bg-gray-100 p-4 font-mono text-sm">
            {output || "No activity logged yet. Click buttons above to test!"}
          </pre>
        </div>

        <div>
          <h3 className="mb-3 text-lg font-semibold">Flow Summary</h3>
          <div className="h-80 overflow-y-auto rounded bg-gray-100 p-4">
            {summary ? (
              <div className="space-y-3 text-sm">
                <div>
                  <strong>Intent:</strong> {summary.intent || "Unknown"}
                </div>
                <div>
                  <strong>Recent Edits:</strong>
                  <ul className="mt-1 list-inside list-disc">
                    {summary.recentEdits?.map((file, idx) => (
                      <li key={idx} className="text-gray-600">
                        {file}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <strong>Recent Opens:</strong>
                  <ul className="mt-1 list-inside list-disc">
                    {summary.recentOpens?.map((file, idx) => (
                      <li key={idx} className="text-gray-600">
                        {file}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <strong>Recent Commands:</strong>
                  <ul className="mt-1 list-inside list-disc">
                    {summary.recentCommands?.map((cmd, idx) => (
                      <li key={idx} className="font-mono text-xs text-gray-600">
                        {cmd}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <strong>Current Errors:</strong>
                  <ul className="mt-1 list-inside list-disc">
                    {summary.currentErrors?.map((errorMsg, idx) => (
                      <li key={idx} className="text-xs text-red-600">
                        {errorMsg}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <strong>Idle Seconds:</strong> {summary.idleSeconds ?? "—"}
                </div>
              </div>
            ) : (
              <p className="text-gray-500">
                No summary available. Click &ldquo;Get Context &amp;
                Summary&rdquo; after recording some activities.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Instructions */}
      <div className="mt-6 rounded bg-blue-50 p-4">
        <h4 className="mb-2 font-semibold text-blue-900">测试说明:</h4>
        <ol className="space-y-1 text-sm text-blue-800">
          <li>1. 点击单个活动按钮测试基础功能</li>
          <li>
            2. 尝试&ldquo;调试流程&rdquo;和&ldquo;重构流程&rdquo;测试意图推理
          </li>
          <li>
            3. 点击&ldquo;Get Context &amp; Summary&rdquo;查看系统生成的上下文
          </li>
          <li>4. 观察右侧摘要中的推断意图是否正确</li>
          <li>5. 使用&ldquo;Clear Session&rdquo;清空数据重新测试</li>
        </ol>
      </div>
    </div>
  );
}

export default FlowAwarenessTest;
