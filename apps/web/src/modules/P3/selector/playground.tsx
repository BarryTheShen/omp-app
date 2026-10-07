import { EntryId as EntryIdSchema, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Section } from "@/components/blocks";
import { renderDialogRequest } from "@/modules/U4/dialogs/renderer";
import { DialogHostController } from "@/modules/U4/host";
import { OverlayHost, useStableOverlayHost } from "@/overlay";
import type { BranchMessage, BranchMessageSelectorPort } from "../contract";
import type { P3EditSelection } from "../edit";
import { P3EditComposerHandoff } from "../edit";
import { useP3PreviousMessageSelectorController } from "./controller";
import { PreviousMessageSelectorView } from "./view";

// The e2e checks pick fixtures with the query string: `?message=long` is a 170-character message
// without a break point, and `?list=fail-once` makes the first list request fail.
const query = new URLSearchParams(window.location.search);
const threadId = ThreadIdSchema.parse("p3-selector-playground-thread");
const entryId = EntryIdSchema.parse("p3-selector-playground-entry");
const text =
  query.get("message") === "long"
    ? `https://example.com/${"segment".repeat(22).slice(0, 150)}`
    : "Use the attached notes to explain how caching improves response time.";
const message: BranchMessage = { entryId, text };
const image = {
  type: "image",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmPAAAAAASUVORK5CYII=",
};
const selection: P3EditSelection = {
  message,
  editSource: {
    threadId,
    entryId,
    parentId: null,
    originalText: message.text,
    originalImages: [image],
    sourceHeadId: "playground-head",
  },
  composerSource: {
    text: message.text,
    images: [image],
    attachmentRefs: [{ id: "playground-notes", name: "notes.txt", mediaType: "text/plain" }],
    sourceMessageId: String(entryId),
  },
};
let listCalls = 0;
const branchMessages: BranchMessageSelectorPort = {
  list: async () => {
    listCalls += 1;
    if (query.get("list") === "fail-once" && listCalls === 1) {
      throw new Error("The first list request failed.");
    }
    return [message];
  },
};

function SelectorPlayground() {
  const overlay = useStableOverlayHost();
  const hostRef = useRef<DialogHostController | null>(null);
  if (hostRef.current === null) {
    hostRef.current = new DialogHostController({
      overlay,
      answerExtensionUi: async () => undefined,
      render: renderDialogRequest,
    });
  }
  const dialogs = hostRef.current;
  useEffect(() => () => dialogs.dispose(), [dialogs]);

  const [selected, setSelected] = useState<P3EditSelection | null>(null);
  const [lastReplacement, setLastReplacement] = useState<string | null>(null);
  const controller = useP3PreviousMessageSelectorController({
    available: true,
    branchMessages,
    dialogs,
    threadId,
    onCurrentBranch: (candidate) => candidate === entryId,
    resolveSource: async (candidate) => (candidate.entryId === entryId ? selection : null),
    onSelect: setSelected,
  });

  return (
    <main
      className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8"
      data-testid="p3-3-selector-playground"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <Section heading="Earlier messages" description="Pick a message to edit it.">
          <PreviousMessageSelectorView {...controller} />
        </Section>
        {selected ? (
          <Section
            heading="Edit message"
            description="The original text and attachments stay available."
          >
            <P3EditComposerHandoff
              selection={selected}
              onSubmitReplacement={(submission) => setLastReplacement(submission.replacement.text)}
              onCancel={() => setSelected(null)}
              restoreFocus={controller.actions.restoreFocus}
            />
          </Section>
        ) : null}
        {lastReplacement ? (
          <p className="text-muted-foreground text-sm" role="status">
            Replacement ready: {lastReplacement}
          </p>
        ) : null}
      </div>
    </main>
  );
}

const root = document.getElementById("p3-3-selector-root");
if (!root) throw new Error("The previous-message selector preview could not be opened.");
createRoot(root).render(
  <OverlayHost>
    <SelectorPlayground />
  </OverlayHost>,
);
