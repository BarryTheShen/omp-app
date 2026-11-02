import type { HostDialogRequest, InputDialog } from "@omp-app/contracts/chat-host";
import { type ReactNode, useId, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ChatController } from "../chat/controller";
import { SignInPage } from "../chat/SignInPage";

const words = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

type SignInQuestion = Extract<HostDialogRequest, { readonly method: "ui.input" }> & {
  readonly params: InputDialog & { readonly signIn: NonNullable<InputDialog["signIn"]> };
};

/** The chat's question a sign-in waits on, when it asks one: it carries the sign-in's page. */
function isSignInQuestion(request: HostDialogRequest): request is SignInQuestion {
  return request.method === "ui.input" && request.params.signIn !== undefined;
}

/**
 * A sign-in started from Settings, while it runs (#2784): its page to open or copy, omp's question answered here as well
 * as in the chat (it is the chat's own question, behind Settings), and Cancel, which stops it in omp.
 */
export function SignInProgress({
  controller,
  name,
}: {
  readonly controller: ChatController;
  readonly name: string;
}): ReactNode {
  const { signIn, requests } = useSyncExternalStore(
    controller.store.subscribe,
    controller.store.getSnapshot,
  );
  const question = requests.find(isSignInQuestion);
  const [cancelling, setCancelling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <fieldset className="mt-2 flex min-w-0 flex-col gap-2">
      <legend className="sr-only">Signing in to {name}</legend>
      {signIn === null ? (
        <p role="status" className="text-sm text-t2">
          Starting the sign-in to {name}…
        </p>
      ) : (
        <SignInPage link={{ url: signIn.url, name }} instructions={signIn.instructions} />
      )}
      {question !== undefined && (
        <SignInAnswer key={question.id} controller={controller} question={question} />
      )}
      <div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={cancelling}
          onClick={() => {
            setCancelling(true);
            setProblem(null);
            controller
              .cancelSignIn()
              .catch((failure: unknown) => setProblem(`Not cancelled: ${words(failure)}`))
              .finally(() => setCancelling(false));
          }}
        >
          Cancel sign-in
        </Button>
      </div>
      {problem !== null && <p className="text-xs text-bad-ink">{problem}</p>}
    </fieldset>
  );
}

/** omp's question, as the chat shows it: what it asks, a box, and Finish sign-in. */
function SignInAnswer({
  controller,
  question,
}: {
  readonly controller: ChatController;
  readonly question: SignInQuestion;
}): ReactNode {
  const id = useId();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        setSending(true);
        setProblem(null);
        controller
          .answer(question.id, { value: text.trim() })
          .catch((failure: unknown) => setProblem(`Not sent: ${words(failure)}`))
          .finally(() => setSending(false));
      }}
    >
      <label htmlFor={id} className="text-sm text-t1">
        {question.params.title}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          autoComplete="off"
          placeholder={question.params.placeholder}
          className="min-w-64 flex-1"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={sending || text.trim() === ""}>
          Finish sign-in
        </Button>
      </div>
      {problem !== null && <p className="text-xs text-bad-ink">{problem}</p>}
    </form>
  );
}
