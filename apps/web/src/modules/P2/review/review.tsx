import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { MarkdownContent } from "@/modules/U1/markdown";
import type { PanelFocusToken, PanelOpenReason, PanelState } from "@/modules/U5/panel/contract";
import { PanelShell } from "@/modules/U5/panel/shell";
import type { PlanDocument } from "../contract";
import { type PlanHeading, planReviewChunks, planReviewModel } from "./model";

export interface PlanReviewPanelProps {
  readonly document: PlanDocument | null;
  readonly open: boolean;
  readonly lifecycle?: PanelState["lifecycle"];
  readonly error?: PanelState["error"];
  readonly invokingFocus?: PanelFocusToken;
  readonly restoreFocus?: (token: PanelFocusToken) => void;
  readonly onOpenChange?: (open: boolean, reason: PanelOpenReason) => void;
  readonly onCopy?: (markdown: string) => void | Promise<void>;
  readonly onExport?: (format: "markdown" | "json") => void | Promise<void>;
}

interface ActionFeedback {
  readonly documentId: string;
  readonly revision: number;
  readonly kind: "success" | "error";
  readonly message: string;
}

export function PlanReviewPanel({
  document,
  open,
  lifecycle = document === null ? "empty" : "populated",
  error = null,
  invokingFocus,
  restoreFocus,
  onOpenChange,
  onCopy,
  onExport,
}: PlanReviewPanelProps) {
  const anchorPrefix = useId();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [headings, setHeadings] = useState<readonly PlanHeading[]>([]);
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const markdownChunks = useMemo(
    () => (document === null ? [] : planReviewChunks(document, anchorPrefix)),
    [document, anchorPrefix],
  );

  useEffect(() => {
    const markdownRoot = bodyRef.current;
    setHeadings(
      document === null || markdownRoot === null ? [] : planReviewModel(markdownRoot).headings,
    );
    setFeedback(null);
  }, [document]);
  const currentFeedback =
    feedback !== null &&
    document !== null &&
    feedback.documentId === document.id &&
    feedback.revision === document.revision
      ? feedback
      : null;

  const state: PanelState = {
    open,
    lifecycle,
    position: "right",
    title: "Plan review",
    description: "Review this plan's headings.",
    error,
    readOnly: true,
    pendingUpdates: 0,
  };

  const jumpTo = useCallback((headingId: string): void => {
    const target = window.document.getElementById(headingId);
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
  }, []);

  const copyPlan = async (): Promise<void> => {
    const currentDocument = document;
    if (currentDocument === null || onCopy === undefined) return;
    setFeedback(null);
    try {
      await onCopy(currentDocument.markdown);
      setFeedback({
        documentId: currentDocument.id,
        revision: currentDocument.revision,
        kind: "success",
        message: "Plan copied.",
      });
    } catch {
      setFeedback({
        documentId: currentDocument.id,
        revision: currentDocument.revision,
        kind: "error",
        message: "Copy failed. Try again.",
      });
    }
  };

  const exportPlan = async (): Promise<void> => {
    const currentDocument = document;
    if (currentDocument === null || onExport === undefined) return;
    setFeedback(null);
    try {
      await onExport("markdown");
      setFeedback({
        documentId: currentDocument.id,
        revision: currentDocument.revision,
        kind: "success",
        message: "Plan exported.",
      });
    } catch {
      setFeedback({
        documentId: currentDocument.id,
        revision: currentDocument.revision,
        kind: "error",
        message: "Export failed. Try again.",
      });
    }
  };

  const body = useMemo(() => {
    if (document === null) return null;
    return (
      <div className="h-full min-h-0 overflow-y-auto" data-plan-review-scroll>
        <div className="flex min-w-0 flex-col gap-4 p-4" data-plan-review-body>
          {headings.length > 0 && (
            <nav
              aria-label="Plan headings"
              className="border-border bg-muted/20 rounded-md border p-3"
            >
              <p className="text-muted-foreground mb-2 text-xs font-medium">On this plan</p>
              <ol className="flex flex-col gap-1">
                {headings.map((heading) => (
                  <li
                    key={heading.id}
                    style={{ paddingInlineStart: `${Math.max(heading.level - 1, 0) * 0.75}rem` }}
                  >
                    <Button
                      className="h-auto justify-start px-1 py-0.5 text-start text-xs"
                      size="sm"
                      type="button"
                      variant="ghost"
                      onClick={() => jumpTo(heading.id)}
                    >
                      {heading.text}
                    </Button>
                  </li>
                ))}
              </ol>
            </nav>
          )}
          <div ref={bodyRef} className="min-w-0 text-sm" data-plan-markdown>
            {markdownChunks.map((chunk) =>
              chunk.heading === null ? (
                <div className="min-w-0" key={chunk.key}>
                  <MarkdownContent text={chunk.markdown} variant="compact" />
                </div>
              ) : (
                <section
                  aria-label={`Heading: ${chunk.heading.text}`}
                  className="min-w-0"
                  data-plan-heading-anchor={chunk.heading.id}
                  id={chunk.heading.id}
                  key={chunk.key}
                  tabIndex={-1}
                >
                  <MarkdownContent text={chunk.markdown} variant="compact" />
                </section>
              ),
            )}
          </div>
        </div>
      </div>
    );
  }, [document, headings, jumpTo, markdownChunks]);

  return (
    <PanelShell
      state={state}
      invokingFocus={invokingFocus}
      restoreFocus={restoreFocus}
      onOpenChange={onOpenChange}
      toolbar={
        <div className="flex items-center gap-1">
          {document && onCopy && (
            <Button size="sm" type="button" variant="ghost" onClick={() => void copyPlan()}>
              Copy plan
            </Button>
          )}
          {document && onExport && (
            <Button size="sm" type="button" variant="ghost" onClick={() => void exportPlan()}>
              Export plan
            </Button>
          )}
        </div>
      }
      footer={
        currentFeedback ? (
          <p role={currentFeedback.kind === "success" ? "status" : "alert"}>
            {currentFeedback.message}
          </p>
        ) : undefined
      }
      body={body}
    />
  );
}
