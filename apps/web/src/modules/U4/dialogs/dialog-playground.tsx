import type { CapabilityMap, ThreadId, UiRequestId } from "@omp-app/contracts";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { OverlayHost, useOverlayHost } from "@/overlay";
import type { DialogRequest } from "../contract";
import { DialogHostController } from "../host";
import { renderDialogRequest } from "./renderer";

const capabilities: CapabilityMap = { "omp.ui": { state: "available", via: "rpc" } };
const threadId = "u4-3-playground" as ThreadId;

function DialogPlayground() {
  const overlay = useOverlayHost();
  const hostRef = useRef<DialogHostController | null>(null);
  const [lastAnswer, setLastAnswer] = useState("No answer yet");
  if (hostRef.current === null) {
    hostRef.current = new DialogHostController({
      overlay,
      capabilities,
      answerDialog: async (id, answer) => setLastAnswer(JSON.stringify({ id, answer })),
      render: renderDialogRequest,
    });
  }
  const host = hostRef.current;
  useEffect(() => () => host.dispose(), [host]);

  const open = (request: DialogRequest) => {
    const pending = host.open(request, { threadId });
    void pending.then(
      (result) => setLastAnswer(JSON.stringify(result)),
      (error: unknown) => setLastAnswer(error instanceof Error ? error.message : "Dialog failed"),
    );
  };

  return (
    <main className="min-h-screen bg-background text-foreground" data-testid="u4-3-playground">
      <header className="border-border bg-card flex items-center justify-between border-b px-6 py-4">
        <div>
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            omp / U4
          </p>
          <h1 className="text-xl font-semibold">Dialog renderer playground</h1>
        </div>
        <p className="text-muted-foreground max-w-xs text-end text-xs" data-testid="last-answer">
          {lastAnswer}
        </p>
      </header>
      <section className="mx-auto flex min-h-[70vh] w-full max-w-3xl flex-col justify-center gap-5 px-6 py-12">
        <div className="border-border bg-card rounded-xl border p-6 shadow-sm">
          <p className="text-muted-foreground text-sm">One host, five dialog grammars</p>
          <p className="mt-2 text-base">Use the keyboard to answer or cancel each request.</p>
        </div>
        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">Dialog examples</legend>
          <Button
            id="open-select"
            type="button"
            onClick={() =>
              open({
                kind: "select",
                id: "u4-3-select" as UiRequestId,
                title: "Choose a color",
                options: ["Azure", "Beryl", "Crimson"],
                optionDetails: [
                  { description: "Blue" },
                  { description: "Green" },
                  { description: "Red" },
                ],
              })
            }
          >
            Select
          </Button>
          <Button
            id="open-confirm"
            type="button"
            variant="outline"
            onClick={() =>
              open({
                kind: "confirm",
                id: "u4-3-confirm" as UiRequestId,
                title: "Delete workspace?",
                message: "This destructive action cannot be undone.",
              })
            }
          >
            Confirm
          </Button>
          <Button
            id="open-input"
            type="button"
            variant="outline"
            onClick={() =>
              open({
                kind: "input",
                id: "u4-3-input" as UiRequestId,
                title: "Project name",
                placeholder: "Enter a name",
              })
            }
          >
            Input
          </Button>
          <Button
            id="open-editor"
            type="button"
            variant="outline"
            onClick={() =>
              open({
                kind: "editor",
                id: "u4-3-editor" as UiRequestId,
                title: "Edit notes",
                prefill: "Initial notes",
              })
            }
          >
            Editor
          </Button>
          <Button
            id="open-ask"
            type="button"
            variant="outline"
            onClick={() =>
              open({
                kind: "ask",
                id: "u4-3-ask" as UiRequestId,
                questions: [
                  {
                    id: "mode",
                    question: "Which mode should run?",
                    header: "Mode",
                    options: [
                      { label: "Fast", description: "Lower latency" },
                      { label: "Thorough", description: "More analysis" },
                    ],
                  },
                ],
              })
            }
          >
            Ask
          </Button>
        </fieldset>
      </section>
    </main>
  );
}

const root = document.getElementById("u4-3-playground-root");
if (!root) throw new Error("U4.3 playground root is missing.");
createRoot(root).render(
  <OverlayHost>
    <DialogPlayground />
  </OverlayHost>,
);
