import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] caught error:", error, info);
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-6">
          <div className="max-w-lg w-full bg-card border border-destructive/30 rounded-lg p-6 space-y-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="text-destructive" size={24} />
              <h2 className="text-lg font-semibold">頁面發生錯誤</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              呢個 page 載入嘅時候出現問題。請試下 hard refresh (Ctrl+Shift+R / Cmd+Shift+R)。如果問題持續，截圖呢段 error 俾 Alex。
            </p>
            <pre className="text-xs bg-muted p-3 rounded overflow-auto max-h-48">
              {this.state.error?.message || String(this.state.error)}
              {this.state.error?.stack ? `\n\n${this.state.error.stack.split("\n").slice(0, 5).join("\n")}` : ""}
            </pre>
            <div className="flex gap-2">
              <button
                onClick={this.reset}
                className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:opacity-90"
              >
                重試
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-3 py-1.5 text-sm rounded border border-border hover:bg-muted"
              >
                重新載入
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
