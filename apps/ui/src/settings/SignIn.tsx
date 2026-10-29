import type { LoginProvider } from "@omp-app/contracts/chat-host";
import { type ReactNode, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ChatController } from "../chat/controller";

const words = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/**
 * Sign-in to omp's providers, at the top of the Providers tab. omp signs in inside a chat, so this goes through the
 * focused chat: its page to open shows here, and a code it asks for comes as one of the chat's questions.
 */
export function SignIn({ controller }: { readonly controller: ChatController | null }): ReactNode {
  return (
    <section aria-label="Sign-in" className="mt-6">
      <h3 className="text-xs font-medium text-t3">Sign-in</h3>
      {controller === null ? (
        <p className="mt-2 text-sm text-t3">Open a chat to sign in: omp signs in inside a chat.</p>
      ) : (
        <Providers controller={controller} />
      )}
    </section>
  );
}

function Providers({ controller }: { readonly controller: ChatController }): ReactNode {
  const { signIn } = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
  const [providers, setProviders] = useState<readonly LoginProvider[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** The provider being signed in to. */
  const [busy, setBusy] = useState<LoginProvider | null>(null);
  /** The provider chosen to sign in to next. */
  const [choice, setChoice] = useState<string | null>(null);
  const read = useCallback(
    () =>
      controller.loginProviders().then(setProviders, (failure: unknown) => {
        setProviders([]);
        setProblem(`omp could not list its providers: ${words(failure)}`);
      }),
    [controller],
  );
  useEffect(() => {
    void read();
  }, [read]);
  const login = (provider: LoginProvider): void => {
    setBusy(provider);
    setProblem(null);
    controller
      .login(provider.id)
      .then(read)
      .catch((failure: unknown) =>
        setProblem(`Could not sign in to ${provider.name}: ${words(failure)}`),
      )
      .finally(() => setBusy(null));
  };
  if (providers === null) return <p className="mt-2 text-sm text-t3">Reading omp's providers…</p>;
  // omp lists dozens of providers: those signed in are shown, the rest are one choice away.
  const signedIn = providers.filter((provider) => provider.authenticated);
  const others = providers.filter((provider) => !provider.authenticated && provider.available);
  const chosen = others.find((provider) => provider.id === choice) ?? null;
  return (
    <>
      <ul className="mt-1">
        {signedIn.map((provider) => (
          <li
            key={provider.id}
            className="flex items-center justify-between gap-4 border-b border-l1 py-2.5 text-sm"
          >
            <span className="min-w-0 truncate text-t1">{provider.name}</span>
            <span className="text-xs text-ok-ink">Signed in</span>
          </li>
        ))}
      </ul>
      {signedIn.length === 0 && <p className="mt-2 text-sm text-t3">No provider is signed in.</p>}
      {others.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Select
            items={others.map((provider) => ({ value: provider.id, label: provider.name }))}
            value={choice}
            disabled={busy !== null}
            onValueChange={(next) => {
              if (typeof next === "string") setChoice(next);
            }}
          >
            <SelectTrigger
              aria-label="Provider to sign in to"
              size="sm"
              className="min-w-56 justify-between dark:bg-transparent"
            >
              <SelectValue placeholder="Sign in to another provider" />
            </SelectTrigger>
            <SelectContent>
              {others.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            disabled={chosen === null || busy !== null}
            onClick={() => {
              if (chosen !== null) login(chosen);
            }}
          >
            {busy === null ? "Sign in" : "Waiting…"}
          </Button>
        </div>
      )}
      {busy !== null && (
        <p role="status" className="mt-2 text-sm text-t2">
          {signIn === null ? (
            `Starting the sign-in to ${busy.name}…`
          ) : (
            <>
              Open{" "}
              <a
                href={signIn.launchUrl ?? signIn.url}
                target="_blank"
                rel="noreferrer"
                className="text-accent-ink underline underline-offset-2"
              >
                {busy.name}'s sign-in page
              </a>
              {signIn.instructions === undefined ? "." : `. ${signIn.instructions}`}
            </>
          )}
        </p>
      )}
      {problem !== null && (
        <p role="alert" className="mt-2 text-xs text-bad-ink">
          {problem}
        </p>
      )}
    </>
  );
}
