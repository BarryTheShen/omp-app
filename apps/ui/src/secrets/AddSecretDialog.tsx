import type { AppClient } from "@omp-app/client";
import { SecretAddArgs, type SecretInfo, SecretStore } from "@omp-app/contracts";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { markSavedHere } from "./secrets";

/** A finger's 44 pt on a phone or tablet. */
const TOUCH = "max-sm:h-11 tablet:h-11";

const words = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/**
 * Saves a secret for omp's Hide Secrets: its name and its value, pasted or typed into a hidden field. The value goes
 * to omp's secrets file on the server and nowhere else; `onSaved` gets the placeholder a chat's AI sees instead.
 */
export function AddSecretDialog({
  client,
  open,
  onOpenChange,
  onSaved,
  intro,
}: {
  readonly client: AppClient;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: (saved: SecretInfo) => void;
  /** What saving does where the dialog opened (the message box: its placeholder goes in at the caret). */
  readonly intro: string;
}): ReactNode {
  const nameId = useId();
  const valueId = useId();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const reset = (): void => {
    setName("");
    setValue("");
    setProblem(null);
  };

  const save = async (): Promise<void> => {
    // The client refuses arguments its contract does not take in general words: the contract's own say what to fix.
    const args = SecretAddArgs.safeParse({ name: name.trim(), value });
    if (!args.success) {
      setProblem(args.error.issues[0]?.message ?? "This is not a secret omp can save.");
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const saved = await client.port(SecretStore).add(args.data);
      markSavedHere(saved.name);
      reset();
      onOpenChange(false);
      onSaved(saved);
    } catch (failure) {
      setProblem(words(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A value typed and then left is not kept for the next time the dialog opens.
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a secret</DialogTitle>
          <DialogDescription className="text-pretty">
            The AI never sees it: a chat gets its placeholder, and omp puts the value in a command
            that uses it. {intro}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="flex flex-col gap-1">
            <label htmlFor={nameId} className="text-xs text-t3">
              Name
            </label>
            <Input
              id={nameId}
              value={name}
              placeholder="API_KEY"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={valueId} className="text-xs text-t3">
              Value
            </label>
            <Input
              id={valueId}
              type="password"
              value={value}
              placeholder="Paste it here"
              autoComplete="new-password"
              spellCheck={false}
              onChange={(event) => setValue(event.target.value)}
            />
            <p className="text-xs text-pretty text-t3">
              Kept in omp's secrets file on this server, readable by you only. One line: save a
              file's contents with omp-app secret add NAME &lt; file.
            </p>
          </div>
          {problem !== null && (
            <p role="alert" className="text-xs text-pretty text-bad-ink">
              {problem}
            </p>
          )}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" className={TOUCH} />}>
              Cancel
            </DialogClose>
            <Button
              type="submit"
              className={TOUCH}
              disabled={saving || name.trim() === "" || value.trim() === ""}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
