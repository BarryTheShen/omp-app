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
