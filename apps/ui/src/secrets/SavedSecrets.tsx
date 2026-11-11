import type { AppClient } from "@omp-app/client";
import { type SecretInfo, SecretStore } from "@omp-app/contracts";
import { KeyRound, Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
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
import { AddSecretDialog } from "./AddSecretDialog";
import { copyFromServer, copySecret, useSecrets } from "./secrets";

/** A finger's 44 pt on a phone or tablet. */
const TOUCH = "max-sm:h-11 tablet:h-11";

const words = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/**
 * omp's saved secrets in Settings → Providers, above omp's own Hide Secrets switch (Privacy): each by name, with the
 * placeholder a chat's AI sees in its place. A value leaves the server only to this page, to be copied or shown.
 */
export function SavedSecrets({ client }: { readonly client: AppClient }): ReactNode {
  const { list, problem: readProblem } = useSecrets(client);
  const [adding, setAdding] = useState(false);
  const [shown, setShown] = useState<Readonly<Record<string, string>>>({});
  const [removing, setRemoving] = useState<SecretInfo | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const act = async (run: () => Promise<string>): Promise<void> => {
    setProblem(null);
    setDone(null);
    try {
      setDone(await run());
    } catch (failure) {
      setProblem(words(failure));
    }
  };

  const show = (name: string): void =>
    void act(async () => {
      const { value } = await client.port(SecretStore).reveal({ name });
      setShown((open) => ({ ...open, [name]: value }));
      return `${name} is shown here, and nowhere else.`;
    });

  const hide = (name: string): void => setShown(({ [name]: _gone, ...rest }) => rest);

  return (
    <section aria-label="Secrets" className="mt-6" data-tour="secrets">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium text-t3">Secrets</h3>
        <Button
          size="sm"
          variant="outline"
          className={TOUCH}
          data-tour="secrets-add"
          onClick={() => setAdding(true)}
        >
          <Plus />
          Add a secret
        </Button>
      </div>
      <p className="mt-1 text-xs text-pretty text-t3">
        Keys and passwords the AI never sees: a chat gets each one as its placeholder, and omp puts
        the value in a command that uses it. Also in a chat's message box (the key button) and with
        omp-app secret in a terminal.
      </p>
      {list !== null && !list.hidden && (
        <p className="mt-2 text-xs text-pretty text-warn-ink">
          Hide Secrets (under Privacy, below) is off, so chats see secrets as they are. Adding a
          secret turns it on.
        </p>
      )}
      {list === null ? (
        <p className="mt-2 text-sm text-t3">{readProblem ?? "Reading omp's secrets…"}</p>
      ) : list.secrets.length === 0 ? (
        <p className="mt-2 text-sm text-pretty text-t3">No secrets saved yet.</p>
      ) : (
        <ul aria-label="Saved secrets" className="mt-1">
          {list.secrets.map((secret) => (
            <li
              key={secret.name}
              aria-label={secret.name}
              className="flex flex-col gap-1.5 border-b border-l1 py-2.5"
            >
              <div className="flex items-start gap-3">
                <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0 text-t3" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="truncate font-medium text-t1">{secret.name}</span>
                    <span className="text-xs text-t3">{secret.length} characters</span>
                  </p>
                  <p
                    className="truncate font-mono text-xs text-t3"
                    title={secret.placeholder ?? ""}
                  >
                    {secret.placeholder ?? "omp does not hide this value"}
                  </p>
                  {shown[secret.name] !== undefined && (
                    <output
                      aria-label={`${secret.name}'s value`}
                      className="mt-1 block font-mono text-xs break-all text-t1 select-all"
                    >
                      {shown[secret.name]}
                    </output>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1 pl-7">
                <Button
                  size="sm"
                  variant="ghost"
                  className={TOUCH}
                  onClick={() =>
                    void act(async () => {
                      await copySecret(client, secret.name);
                      return `${secret.name} copied.`;
                    })
                  }
                >
                  Copy
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className={TOUCH}
                  onClick={() =>
                    shown[secret.name] === undefined ? show(secret.name) : hide(secret.name)
                  }
                >
                  {shown[secret.name] === undefined ? "Show" : "Hide"}
                </Button>
                {secret.placeholder !== null && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className={TOUCH}
                    onClick={() =>
                      void act(async () => {
                        const placeholder = secret.placeholder ?? "";
                        await copyFromServer(async () => placeholder);
                        return `${secret.name}'s placeholder copied: paste it into a message.`;
                      })
                    }
                  >
                    Copy placeholder
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className={`text-bad-ink ${TOUCH}`}
                  onClick={() => setRemoving(secret)}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {list !== null && list.others > 0 && (
        <p className="mt-2 text-xs text-pretty text-t3">
          {list.others === 1 ? "1 more entry" : `${list.others} more entries`} of {list.path}{" "}
          {list.others === 1 ? "is" : "are"} not listed: patterns, or secrets written there without
          a name.
        </p>
      )}
      {done !== null && (
        <p role="status" className="mt-2 text-sm text-pretty text-t2">
          {done}
        </p>
      )}
      {problem !== null && (
        <p role="alert" className="mt-2 text-xs text-pretty text-bad-ink">
          {problem}
        </p>
      )}
      <AddSecretDialog
        client={client}
        open={adding}
        onOpenChange={setAdding}
        intro="Its placeholder is listed here."
        onSaved={(saved) => {
          setProblem(null);
          setDone(`${saved.name} saved. A chat's AI sees it as ${saved.placeholder}.`);
        }}
      />
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name ?? ""}?</AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              omp drops it from its secrets file: chats see the value as it is again wherever it
              shows, and its placeholder stops working. To have it back, add it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const gone = removing;
                setRemoving(null);
                if (gone === null) return;
                hide(gone.name);
                void act(async () => {
                  await client.port(SecretStore).remove({ name: gone.name });
                  return `${gone.name} removed.`;
                });
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
