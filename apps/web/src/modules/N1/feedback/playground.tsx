import { ThreadId } from "@omp-app/contracts";
import { OmpRuntimeStore } from "../../R0/store";
import { NotificationProjector } from "../notifications";
import { NotificationFeedback } from "./feedback";
import { ExtensionWidgets, type WidgetPlacement } from "./status";

const threadId = ThreadId.parse("n1-3-feedback-playground");
const projector = new NotificationProjector({ source: new OmpRuntimeStore({ threadId }) });

/**
 * What the page's test drives. Each call goes through the same handoff the app's extension bridge uses,
 * so nothing the test does takes focus from the composer.
 */
export interface FeedbackPlaygroundHooks {
  readonly notify: (message: string, notifyType: "info" | "warning" | "error") => void;
  readonly setWidget: (
    widgetKey: string,
    placement: WidgetPlacement,
    lines: readonly string[],
  ) => void;
  readonly setStatus: (statusKey: string, statusText: string) => void;
}

declare global {
  interface Window {
    n1FeedbackPlayground?: FeedbackPlaygroundHooks;
  }
}

const hooks: FeedbackPlaygroundHooks = {
  notify: (message, notifyType) =>
    projector.present({ kind: "notify", message, notifyType }, { threadId }),
  setWidget: (widgetKey, placement, lines) =>
    projector.present(
      { kind: "setWidget", widgetKey, widgetPlacement: placement, widgetLines: [...lines] },
      { threadId },
    ),
  setStatus: (statusKey, statusText) =>
    projector.present({ kind: "setStatus", statusKey, statusText }, { threadId }),
};
window.n1FeedbackPlayground = hooks;

/**
 * A composer-shaped box between a widget above it and one below, and the strip under it, as the
 * status bar and the composer sit in the app.
 */
export function N1FeedbackPlayground() {
  return (
    <main
      className="mx-auto flex min-h-screen w-full max-w-3xl min-w-0 flex-col gap-3 bg-background p-4 text-foreground"
      data-testid="n1-3-feedback-playground"
    >
      <ExtensionWidgets placement="aboveEditor" projector={projector} />
      <div className="rounded-xl border border-border p-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted-foreground">Message</span>
          <textarea
            aria-label="Message input"
            className="min-h-20 rounded-md border border-border bg-background p-2 text-sm"
            rows={3}
          />
        </label>
      </div>
      <ExtensionWidgets placement="belowEditor" projector={projector} />
      <NotificationFeedback projector={projector} widgets="none" />
    </main>
  );
}
