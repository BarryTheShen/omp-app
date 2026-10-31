import type {
  LoginProvider,
  ProviderAccount,
  ProviderAccounts,
  ProviderAuthSource,
} from "@omp-app/contracts/chat-host";
import { type ReactNode, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ChatController } from "../chat/controller";
import { lastSeen } from "../lastSeen";

const words = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/** omp's providers and who is signed in, as this page listed them last. */
const lastProviders = lastSeen<readonly LoginProvider[]>("login-providers");

/** Where a provider's sign-in comes from when it is no stored account, and where to sign out of it. */
function sourceWords(source: ProviderAuthSource): string {
  switch (source.kind) {
    case "env":
      return source.envVar === undefined
        ? "Signed in through an environment variable: unset it to sign out."
        : `Signed in through the environment variable ${source.envVar}: unset it to sign out.`;
    case "config":
      return "Signed in through a key in omp's models.yml: remove it there to sign out.";
    case "runtime":
      return "Signed in through the key omp was started with (--api-key).";
  }
}

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
  const [providers, setProviders] = useState<readonly LoginProvider[] | null>(
    () => lastProviders.get() ?? null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  /** The provider being signed in to. */
  const [busy, setBusy] = useState<LoginProvider | null>(null);
  /** The provider chosen to sign in to next. */
  const [choice, setChoice] = useState<string | null>(null);
  /** Counts the sign-ins and sign-outs, so each signed-in provider reads its accounts again after one. */
  const [changes, setChanges] = useState(0);
  // Until the read answers, the list shown last; a read that fails keeps it, and says so.
  const read = useCallback(
    () =>
      controller.loginProviders().then(
        (listed) => {
          lastProviders.set(listed);
          setProviders(listed);
        },
        (failure: unknown) => {
          setProviders((shown) => shown ?? []);
          setProblem(`omp could not list its providers: ${words(failure)}`);
        },
      ),
    [controller],
  );
  useEffect(() => {
    void read();
  }, [read]);
  const changed = useCallback(() => {
    setChanges((count) => count + 1);
    void read();
  }, [read]);
  const login = (provider: LoginProvider): void => {
    setBusy(provider);
    setProblem(null);
    controller
      .login(provider.id)
      .then(changed)
      .catch((failure: unknown) =>
        setProblem(`Could not sign in to ${provider.name}: ${words(failure)}`),
      )
      .finally(() => setBusy(null));
  };
  if (providers === null) return <p className="mt-2 text-sm text-t3">Reading omp's providers…</p>;
  // omp lists dozens of providers: those signed in are shown with their accounts, any is one choice away.
  const signedIn = providers.filter((provider) => provider.authenticated);
  const choices = providers.filter((provider) => provider.available);
  const chosen = choices.find((provider) => provider.id === choice) ?? null;
  return (
    <>
      <ul className="mt-1" data-tour="provider-accounts">
        {signedIn.map((provider) => (
          <ProviderAccountsRow
            key={provider.id}
            provider={provider}
            controller={controller}
            changes={changes}
            onAdd={busy === null ? () => login(provider) : null}
            onChanged={changed}
          />
        ))}
      </ul>
      {signedIn.length === 0 && <p className="mt-2 text-sm text-t3">No provider is signed in.</p>}
      {choices.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2" data-tour="provider-sign-in">
          <Select
            items={choices.map((provider) => ({ value: provider.id, label: provider.name }))}
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
              <SelectValue placeholder="Sign in to a provider" />
            </SelectTrigger>
            <SelectContent>
              {choices.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.name}
                  {provider.authenticated && <span className="text-t3"> · signed in</span>}
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

/**
 * A signed-in provider and the accounts omp stores for it, as omp's `/logout` lists them: each can be signed out,
 * another one added. A provider signed in some other way (an environment variable, models.yml) says where.
 */
function ProviderAccountsRow({
  provider,
  controller,
  changes,
  onAdd,
  onChanged,
}: {
  readonly provider: LoginProvider;
  readonly controller: ChatController;
  /** Bumped after every sign-in and sign-out: the accounts are read again. */
  readonly changes: number;
  /** Signs in to another account of this provider; null while a sign-in runs. */
  readonly onAdd: (() => void) | null;
  /** A sign-out happened: the provider list is read again. */
  readonly onChanged: () => void;
}): ReactNode {
  const [accounts, setAccounts] = useState<ProviderAccounts | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** The account the sign-out question is about, while it is open. */
  const [leaving, setLeaving] = useState<ProviderAccount | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    // `changes` is the reason to read again: after a sign-in or a sign-out.
    void changes;
    let current = true;
    controller.providerAccounts(provider.id).then(
      (read) => {
        if (!current) return;
        setAccounts(read);
        setProblem(null);
      },
      (failure: unknown) => {
        if (current) setProblem(`omp could not list the accounts: ${words(failure)}`);
      },
    );
    return () => {
      current = false;
    };
  }, [controller, provider.id, changes]);

  const signOut = (account: ProviderAccount): void => {
    setSigningOut(true);
    setProblem(null);
    controller
      .logoutAccount(provider.id, account.credentialId)
      .then((after) => {
        setAccounts(after);
        if (!after.removed) setProblem(`${account.label} was signed out already.`);
        onChanged();
      })
      .catch((failure: unknown) =>
        setProblem(`Could not sign ${account.label} out: ${words(failure)}`),
      )
      .finally(() => setSigningOut(false));
  };

  return (
    <li className="border-b border-l1 py-2.5" aria-label={provider.name}>
      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="min-w-0 truncate font-medium text-t1">{provider.name}</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={onAdd === null}
          onClick={() => onAdd?.()}
          data-tour="provider-add-account"
        >
          Add another account
        </Button>
      </div>
      {accounts === null && problem === null && (
        <p className="mt-1 text-xs text-t3">Reading its accounts…</p>
      )}
      {accounts !== null && (
        <ul className="mt-1 flex flex-col">
          {accounts.accounts.map((account) => (
            <li key={account.credentialId} className="flex items-center gap-3 py-1 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-t1">{account.label}</span>
                <span className="block truncate text-xs text-t3">{account.detail}</span>
              </span>
              {account.active && (
                <span className="shrink-0 text-xs text-ok-ink">Used by this chat</span>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={signingOut}
                aria-label={`Sign out ${account.label}`}
                onClick={() => setLeaving(account)}
              >
                Sign out
              </Button>
            </li>
          ))}
          {accounts.accounts.length === 0 && (
            <li className="py-1 text-xs text-pretty text-t2">
              {accounts.otherSource === undefined
                ? "Signed in."
                : sourceWords(accounts.otherSource)}
            </li>
          )}
          {accounts.accounts.length > 0 && accounts.otherSource !== undefined && (
            <li className="py-1 text-xs text-pretty text-t3">
              {sourceWords(accounts.otherSource)}
            </li>
          )}
        </ul>
      )}
      {problem !== null && (
        <p role="alert" className="mt-1 text-xs text-bad-ink">
          {problem}
        </p>
      )}
      <AlertDialog
        open={leaving !== null}
        onOpenChange={(open) => {
          if (!open) setLeaving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out {leaving?.label ?? ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              omp stops using this {provider.name} account in every chat. You can sign in to it
              again here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (leaving === null) return;
                setLeaving(null);
                signOut(leaving);
              }}
            >
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
