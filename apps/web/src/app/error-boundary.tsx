import { Component, type ErrorInfo, type ReactNode } from "react";
import { InlineError } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { knownLogFile } from "@/launch";
import { reportClientError } from "./client-errors";

export interface AppErrorBoundaryProps {
  readonly children: ReactNode;
  /** Reloads the page; the default is the browser's reload. */
  readonly onReload?: () => void;
  /** Puts text on the clipboard; the default is the browser's clipboard. */
  readonly copyText?: (text: string) => Promise<void>;
}

interface AppErrorBoundaryState {
  readonly error: Error | undefined;
  readonly componentStack: string | undefined;
  readonly copy: "idle" | "copied" | "failed";
}

const MAX_DETAIL_LINES = 30;

function firstLines(text: string | undefined, count: number): string {
  return (text ?? "").split("\n").slice(0, count).join("\n");
}

/**
 * What the person can paste into a bug report. The address leaves out everything after the path:
 * the launch link carries the access token in its fragment, and that must never be copied.
 */
function detailsText(error: Error, componentStack: string | undefined): string {
  const stack = firstLines(error.stack, MAX_DETAIL_LINES);
  // Chrome's stack starts with "Error: message"; Firefox's does not.
  const heading = stack.includes(error.message) ? "" : `${error.name}: ${error.message}`;
  return [
    "omp app page error",
    new Date().toISOString(),
    heading,
    stack,
    componentStack ? `Component stack:\n${firstLines(componentStack, MAX_DETAIL_LINES)}` : "",
    `Page: ${window.location.origin}${window.location.pathname}`,
    `Browser: ${window.navigator.userAgent}`,
    `omp app log: ${knownLogFile()} (run "omp-app debug-report" and attach the file)`,
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

/**
 * Without a boundary, one exception thrown while rendering unmounts the whole app and leaves a
 * blank page. This keeps a message on screen, a way to reload, and the details to attach.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  public override state: AppErrorBoundaryState = {
    error: undefined,
    componentStack: undefined,
    copy: "idle",
  };

  public static getDerivedStateFromError(error: Error): Partial<AppErrorBoundaryState> {
    return { error };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? undefined });
    // The debug log gets it too, with the component stack that says which part of the page failed.
    reportClientError({
      kind: "render",
      message: `${error.name}: ${error.message}`,
      stack: `${error.stack ?? ""}\nComponent stack:${info.componentStack ?? ""}`,
    });
    console.error("[omp-app] the page failed while rendering", error);
  }

  private readonly reload = (): void => {
    if (this.props.onReload) this.props.onReload();
    else window.location.reload();
  };

  private readonly copyDetails = async (): Promise<void> => {
    const { error, componentStack } = this.state;
    if (!error) return;
    const copy = this.props.copyText ?? ((text: string) => navigator.clipboard.writeText(text));
    try {
      await copy(detailsText(error, componentStack));
      this.setState({ copy: "copied" });
    } catch {
      this.setState({ copy: "failed" });
    }
  };

  public override render(): ReactNode {
    const { error, componentStack, copy } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        className="bg-background text-foreground flex h-dvh items-center justify-center overflow-y-auto p-6"
        data-app-error="true"
      >
        <div className="flex w-full max-w-xl flex-col gap-3">
          <InlineError
            heading="Something went wrong in the page"
            message="Reload to carry on. Your chats are kept by omp and are not affected."
            onRetry={this.reload}
            retryLabel="Reload"
          />
          <div className="flex flex-wrap items-center gap-2 px-4">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void this.copyDetails()}
            >
              Copy details
            </Button>
            {copy === "copied" ? (
              <span className="text-muted-foreground text-sm" role="status">
                Copied. Paste it into your bug report.
              </span>
            ) : null}
            {copy === "failed" ? (
              <span className="text-destructive text-sm" role="status">
                Couldn't copy. Select the technical details below and copy them by hand.
              </span>
            ) : null}
          </div>
          <p className="text-muted-foreground px-4 text-sm" data-log-hint="true">
            The app keeps a debug log. To attach it to a bug report, run{" "}
            <code>omp-app debug-report</code> in a terminal: it saves one file. The log is here:
            <code className="mt-1 block text-xs [overflow-wrap:anywhere]">{knownLogFile()}</code>
          </p>
          <details className="text-muted-foreground px-4 text-xs">
            <summary className="cursor-pointer text-sm">Technical details</summary>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words">
              {detailsText(error, componentStack)}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
