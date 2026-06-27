import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Per-widget (and per-page) error boundary: a failure is contained to one box
 * instead of crashing the shell. This is the fail-safe layer the spec requires.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`widget error in ${this.props.label}:`, error, info);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="kos-widget-error" role="alert">
          <strong>{this.props.label}</strong> failed to render: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}
