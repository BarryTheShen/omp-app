import { z } from "zod";
import { ToolCard } from "../../U3/tool-card/card";
import type { ToolRegistryDescriptor, ToolRenderer } from "../../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../../U3/tool-card/normalize";
import { splitToolResult } from "../../U3/tool-card/result";
import type { AskDialogRequest } from "../contract";
import type { AskAnswerValue } from "../contract/responses";

export function AskResultCard({
  request,
  answers,
}: {
  readonly request: AskDialogRequest;
  readonly answers: readonly AskAnswerValue[];
}) {
  return (
    <article
      className="border-border bg-card flex flex-col gap-3 rounded-xl border p-4 text-sm shadow-sm"
      data-testid="ask-result-card"
    >
      <header>
        <h3 className="font-medium">Answers</h3>
        <p className="text-xs text-muted-foreground">Submitted responses</p>
      </header>
      <dl className="flex flex-col gap-3">
        {request.questions.map((question) => {
          const answer = answers.find((candidate) => candidate.id === question.id);
          return (
            <div key={question.id} className="flex flex-col gap-1">
              <dt className="font-medium">{question.question}</dt>
              <dd className="text-muted-foreground">
                {[...(answer?.selectedOptions ?? []), answer?.customInput ?? ""]
                  .filter(Boolean)
                  .join(", ") || "No answer"}
              </dd>
            </div>
          );
        })}
      </dl>
    </article>
  );
}

/** One answer omp recorded: the question, the chosen labels and any typed text. */
const AskAnswerDetailsSchema = z.looseObject({
  question: z.string().optional(),
  selectedOptions: z.array(z.string()).optional(),
  customInput: z.string().optional(),
});

/**
 * omp's `ask` result (omp v18.6.1 `tools/ask.ts`): one answer in the details themselves, or one
 * per question under `results`, in the order the questions were asked. A call omp skipped has no
 * question, so it has no answer rows; its reason is the card's error line.
 */
const AskResultDetailsSchema = z.looseObject({
  question: z.string().optional(),
  selectedOptions: z.array(z.string()).optional(),
  customInput: z.string().optional(),
  results: z.array(AskAnswerDetailsSchema).optional(),
});

interface AskAnswerRow {
  readonly question: string;
  readonly answers: readonly string[];
}

function askAnswerRows(details: unknown): readonly AskAnswerRow[] {
  const parsed = AskResultDetailsSchema.safeParse(details);
  if (!parsed.success) return [];
  const answers = parsed.data.results ?? [parsed.data];
  return answers.flatMap((answer) => {
    if (answer.question === undefined) return [];
    const typed = answer.customInput?.trim() ?? "";
    return [
      {
        question: answer.question,
        answers: [...(answer.selectedOptions ?? []), ...(typed === "" ? [] : [typed])],
      },
    ];
  });
}

/** The `ask` tool's finished card: the question omp asked and the answer it recorded. */
export const AskToolRenderer: ToolRenderer = (props) => {
  const state = normalizeToolRendererProps(props);
  const split = splitToolResult(props.result ?? state.result ?? state.partialResult);
  const rows = askAnswerRows(split.details);
  const chosen = rows.flatMap((row) => row.answers);
  const summary =
    chosen.length === 0
      ? "No answer returned"
      : chosen.length === 1
        ? (chosen[0] ?? "Answer returned")
        : `${chosen.length} answers returned`;
  return (
    <div data-slot="u4-ask-tool-card" data-testid="u4-ask-tool-card">
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-result']]:hidden"
        rawResult={split.text}
        state={state}
        summary={summary}
      />
      {rows.length > 0 && (
        <dl className="ms-2 flex flex-col gap-3 py-2 text-sm" data-testid="u4-ask-tool-answers">
          {rows.map((row) => (
            <div key={row.question} className="flex flex-col gap-1">
              <dt className="font-medium">{row.question}</dt>
              <dd className="text-muted-foreground">{row.answers.join(", ") || "No answer"}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
};

/** U4's `ask` row, renderer-backed. `registry/index.ts` composes it in place of U4's feature-only row. */
export const ASK_TOOL_DESCRIPTOR = {
  kind: "tool",
  id: "U4.ask",
  owner: "U4",
  title: "Ask tool result",
  covers: ["E2.ask"],
  requires: ["omp.ui"],
  match: { by: "name", name: "ask" },
  renderer: AskToolRenderer,
} as const satisfies ToolRegistryDescriptor;
