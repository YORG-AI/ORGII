import React, { useCallback, useState } from "react";
import { LiveError, LivePreview, LiveProvider } from "react-live";

export interface ReactArtifactError {
  message: string;
  stack?: string;
}

export interface ReactArtifactRunnerProps {
  source: string;
  onError?: (error: ReactArtifactError) => void;
}

export function normalizeReactLiveSource(source: string): string {
  let code = source.replace(
    /^\s*import\s+React(?:\s*,\s*\{[^}]*\})?\s+from\s+["']react["'];?\s*$/gm,
    ""
  );
  code = code.replace(
    /^\s*import\s+\{[^}]*\}\s+from\s+["']react["'];?\s*$/gm,
    ""
  );

  if (/\bexport\s+default\s+function\s+App\s*\(/.test(code)) {
    code = code.replace(
      /\bexport\s+default\s+function\s+App\s*\(/,
      "function App("
    );
    return `${code}\nrender(<App />);`;
  }

  if (/\bexport\s+default\s+function\s*\(/.test(code)) {
    code = code.replace(/\bexport\s+default\s+function\s*\(/, "function App(");
    return `${code}\nrender(<App />);`;
  }

  const namedDefaultMatch = code.match(
    /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/
  );
  if (namedDefaultMatch) {
    code = code.replace(namedDefaultMatch[0], "");
    return `${code}\nrender(<${namedDefaultMatch[1]} />);`;
  }

  if (/\bexport\s+default\s+/.test(code)) {
    code = code.replace(/\bexport\s+default\s+/, "const App = ");
    return `${code}\nrender(<App />);`;
  }

  if (/\bfunction\s+App\s*\(|\bconst\s+App\s*=|\blet\s+App\s*=/.test(code)) {
    return `${code}\nrender(<App />);`;
  }

  return code;
}

const ReactArtifactRunner: React.FC<ReactArtifactRunnerProps> = ({
  source,
  onError,
}) => {
  const [lastError, setLastError] = useState<string | null>(null);

  const handleError = useCallback(
    (message: string) => {
      const normalizedMessage = message || "React artifact error";
      setLastError(normalizedMessage);
      onError?.({ message: normalizedMessage });
    },
    [onError]
  );

  return (
    <LiveProvider
      code={normalizeReactLiveSource(source)}
      noInline
      scope={{ React }}
    >
      <div
        className="h-full min-h-0 w-full overflow-auto overscroll-contain bg-bg-1 p-4 text-text-1 [scrollbar-gutter:stable]"
        data-testid="react-artifact-scroll"
      >
        <LivePreview className="min-h-full min-w-0" />
        <LiveError
          className="hidden"
          onChange={(message: string) => {
            if (message && message !== lastError) {
              handleError(message);
            }
          }}
        />
      </div>
    </LiveProvider>
  );
};

export default ReactArtifactRunner;
