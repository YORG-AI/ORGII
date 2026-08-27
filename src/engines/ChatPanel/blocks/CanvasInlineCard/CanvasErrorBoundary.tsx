/**
 * CanvasErrorBoundary — isolates render failures inside CanvasInlineCard.
 *
 * Agent-generated HTML/A2UI content can produce malformed input that causes
 * canvasBuilder helpers to throw. This boundary catches those errors and
 * renders a compact "Preview failed" fallback so the surrounding chat
 * history is not torn down.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

import { Placeholder } from "@src/components/Placeholder";
import { createLogger } from "@src/hooks/logger";

const log = createLogger("CanvasInlineCard");

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class CanvasErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    log.error("[CanvasInlineCard] render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <Placeholder
          variant="error"
          placement="detail-panel"
          title="Preview failed"
          subtitle={this.state.error.message}
        />
      );
    }
    return this.props.children;
  }
}
