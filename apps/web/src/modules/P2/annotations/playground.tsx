import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { PlanDocument, PlanDocumentInput } from "../contract";
import { AnnotationEditor } from "./editor";

const initialDocument: PlanDocument = {
  id: "plan-annotation-playground",
  threadId: "thread-annotation-playground" as PlanDocument["threadId"],
  markdown: "# Plan\n",
  sections: [{ id: "section-plan", heading: "Plan", start: 0, end: 1 }],
  annotations: [
    {
      id: "annotation-1",
      sectionId: "section-plan",
      text: "Check the external API boundary.",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  status: "review",
  revision: 3,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function Playground() {
  const [document, setDocument] = useState(initialDocument);
  const [message, setMessage] = useState("");
  return (
    <main
      className="bg-background text-foreground min-h-screen p-6"
      data-testid="p2-4-annotations-playground"
    >
      <h1 className="mb-2 text-xl font-semibold">Plan annotations</h1>
      <p className="text-muted-foreground mb-6 text-sm">
        Annotate a plan section, refine it, or undo a deletion.
      </p>
      <AnnotationEditor
        document={document}
        annotation={document.annotations[0]}
        sectionId="section-plan"
        expectedRevision={document.revision}
        externalEditor={{ open: async (text) => `${text} (refined)` }}
        onSave={async (next: PlanDocumentInput) => {
          setDocument({ ...document, ...next, revision: document.revision + 1 });
          setMessage("Annotation saved.");
        }}
        onError={setMessage}
        clock={() => ({ id: "annotation-playground", now: "2026-01-02T00:00:00.000Z" })}
      />
      {message ? <p role="status">{message}</p> : null}
    </main>
  );
}

const root = document.getElementById("p2-4-annotations-root");
if (!root) throw new Error("P2.4 annotation playground root is missing.");
createRoot(root).render(<Playground />);
