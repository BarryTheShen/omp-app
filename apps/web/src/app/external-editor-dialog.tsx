import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useShortcutRegistry, useShortcutScope } from "@/shortcuts";

/** The U2 descriptor id of Ctrl+G (`app.editor.external` in omp). */
export const EXTERNAL_EDITOR_SHORTCUT_ID = "U2.externalEditorShortcut";

/** What the editor dialog says, in plain English. */
export const EXTERNAL_EDITOR_MESSAGES = {
  title: "Edit message",
  description:
    "Make your changes here. Use this text puts them in the message box. Cancel leaves the message box as it was.",
  text: "Message text",
  use: "Use this text",
  cancel: "Cancel",
} as const;

/** One open editor: the text it starts with, and how to hand back what is kept. */
export interface ExternalEditRequest {
  readonly initialText: string;
  readonly resolve: (text: string) => void;
}

function EditorBody({
  request,
  onFinish,
}: {
  readonly request: ExternalEditRequest;
  readonly onFinish: (text: string) => void;
}) {
  const [text, setText] = useState(request.initialText);
  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-sm font-medium">{EXTERNAL_EDITOR_MESSAGES.title}</DialogTitle>
        <DialogDescription>{EXTERNAL_EDITOR_MESSAGES.description}</DialogDescription>
      </DialogHeader>
      <Textarea
        aria-label={EXTERNAL_EDITOR_MESSAGES.text}
        autoFocus
        rows={12}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <DialogFooter>
        <Button variant="outline" onClick={() => onFinish(request.initialText)}>
          {EXTERNAL_EDITOR_MESSAGES.cancel}
        </Button>
        <Button onClick={() => onFinish(text)}>{EXTERNAL_EDITOR_MESSAGES.use}</Button>
      </DialogFooter>
    </>
  );
}

export interface ExternalEditorDialogProps {
  readonly request: ExternalEditRequest | null;
  /** Called with the text to keep: the edited text, or the starting text when the dialog is cancelled. */
  readonly onFinish: (text: string) => void;
}

export function ExternalEditorDialog({ request, onFinish }: ExternalEditorDialogProps) {
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && request !== null) onFinish(request.initialText);
      }}
    >
      <DialogContent className="max-w-2xl rounded-surface border border-foreground/10 shadow-none ring-0">
        {request !== null && <EditorBody request={request} onFinish={onFinish} />}
      </DialogContent>
    </Dialog>
  );
}

export interface ExternalEditorShortcutOptions {
  /** The message box's text as it is now. */
  readonly readDraft: () => string;
  /** Opens the editor on the text, and resolves with the text to keep. */
  readonly edit: (initialText: string) => Promise<string>;
  /** Puts the kept text in the message box. */
  readonly apply: (text: string) => void;
}

/**
 * Keeps Ctrl+G's action registered while the open chat is mounted. The chord acts only while the message box has focus
 * (its descriptor says so), so from another text box, or with focus elsewhere, the browser keeps the key.
 */
export function useExternalEditorShortcut({
  readDraft,
  edit,
  apply,
}: ExternalEditorShortcutOptions): void {
  const registry = useShortcutRegistry();
  useShortcutScope("composer-input");
  // The dialog can stay open for seconds, and the chat's draft can change meanwhile: a new chat that finishes opening
  // replaces the controller the composer shows. The kept text goes to the draft that is current when "Use this text" is
  // pressed, not to the one that was current when Ctrl+G was pressed, so the action reads `apply` through a ref.
  const latestApply = useRef(apply);
  useLayoutEffect(() => {
    latestApply.current = apply;
  }, [apply]);
  useEffect(
    () =>
      registry.registerAction(EXTERNAL_EDITOR_SHORTCUT_ID, async () => {
        const current = readDraft();
        const kept = await edit(current);
        if (kept !== current) latestApply.current(kept);
      }),
    [edit, readDraft, registry],
  );
}
