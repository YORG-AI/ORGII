import React, { Component, type ReactNode } from "react";

import { createLogger } from "@src/hooks/logger";

import { DetailPanePlaceholder } from "./DetailPaneLayout";

const log = createLogger("DetailPaneErrorBoundary");

interface DetailPaneErrorBoundaryProps {
  children: ReactNode;
  /** Names the failing region in the placeholder so a blank pane is locatable. */
  label: string;
  onRetry?: () => void;
}

interface DetailPaneErrorBoundaryState {
  error: Error | null;
}

/**
 * Keeps a failed detail region inside the detail pane.
 *
 * Without a boundary here the nearest ancestor is the application root, which
 * replaces the whole window with the global error page — and a region that
 * merely unmounts leaves a silent blank pane with no way to tell a load
 * failure from a layout collapse. Rendering the shared placeholder instead
 * keeps the surrounding chrome usable and puts the actual message on screen.
 */
export default class DetailPaneErrorBoundary extends Component<
  DetailPaneErrorBoundaryProps,
  DetailPaneErrorBoundaryState
> {
  constructor(props: DetailPaneErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): DetailPaneErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    log.error(
      `Detail pane region "${this.props.label}" failed to render`,
      error,
      errorInfo.componentStack
    );
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <DetailPanePlaceholder
        variant="error"
        title={this.props.label}
        subtitle={error.message || String(error)}
        onRetry={
          this.props.onRetry
            ? () => {
                this.setState({ error: null });
                this.props.onRetry?.();
              }
            : () => this.setState({ error: null })
        }
      />
    );
  }
}
