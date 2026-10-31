import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLongPress } from "../longPress";
import { useQuickPrompts } from "./quickPrompts";

/**
 * The phone's quick panel, in the keyboard's place (Termius's side panel on an iPhone): this phone's prompts (Settings
 * → App), sent with one tap or put in the box with a long press to be changed first, and the messages sent before in
 * this chat, put in the box with a tap.
 */
export function QuickPanel({
  history,
  disabled,
  onSend,
  onPut,
}: {
  /** What was sent in this chat, oldest first. */
  readonly history: readonly string[];
  /** The chat is not ready for a prompt yet (opening, or sending one). */
  readonly disabled: boolean;
  /** Sends the text at once (a steer while omp works). */
  readonly onSend: (text: string) => void;
  /** Puts the text in the box, with the keyboard up. */
  readonly onPut: (text: string) => void;
}): ReactNode {
  const [tab, setTab] = useState<"prompts" | "sent">("prompts");
  const prompts = useQuickPrompts();
  return (
    <section
      data-tour="quick-panel"
      aria-label="Quick prompts"
      className="mt-2 flex h-[min(42dvh,320px)] flex-col rounded-xl border border-l2 bg-card"
    >
      <div role="tablist" aria-label="Quick prompts" className="flex gap-1 border-b border-l2 p-1">
        <PanelTab selected={tab === "prompts"} onSelect={() => setTab("prompts")}>
          Prompts
        </PanelTab>
        <PanelTab selected={tab === "sent"} onSelect={() => setTab("sent")}>
          Sent
        </PanelTab>
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {tab === "prompts" ? (
          <ul className="grid grid-cols-2 gap-2">
            {prompts.map((prompt) => (
              <li key={prompt}>
                <PromptButton text={prompt} disabled={disabled} onSend={onSend} onPut={onPut} />
              </li>
            ))}
          </ul>
        ) : history.length === 0 ? (
          <p className="p-3 text-sm text-t3">Nothing sent in this chat yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {history
              .map((text, index) => ({ text, index }))
              .reverse()
              .map(({ text, index }) => (
                <li key={index}>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11 w-full justify-start font-normal text-t1"
                    onClick={() => onPut(text)}
                  >
                    <span className="truncate">{text}</span>
                  </Button>
                </li>
              ))}
          </ul>
        )}
      </div>
      <p className="px-3 pb-2 text-xs text-t3">
        {tab === "prompts"
          ? "Tap to send · hold to change it first · Settings → App changes the list"
          : "Tap to put it in the box"}
      </p>
    </section>
  );
}

function PanelTab({
  selected,
  onSelect,
  children,
}: {
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <Button
      type="button"
      role="tab"
      aria-selected={selected}
      variant={selected ? "secondary" : "ghost"}
      size="sm"
      className="min-h-11 flex-1"
      onClick={onSelect}
    >
      {children}
    </Button>
  );
}

/**
 * A prompt: a tap sends it; a touch-and-hold puts it in the box once the finger lifts (a phone brings its keyboard up
 * only for a focus given within a touch).
 */
function PromptButton({
  text,
  disabled,
  onSend,
  onPut,
}: {
  readonly text: string;
  readonly disabled: boolean;
  readonly onSend: (text: string) => void;
  readonly onPut: (text: string) => void;
}): ReactNode {
  const { endsHold, ...hold } = useLongPress(() => onPut(text));
  return (
    <Button
      type="button"
      variant="secondary"
      disabled={disabled}
      className="min-h-11 w-full justify-start whitespace-normal text-left font-normal text-t1 select-none [-webkit-touch-callout:none]"
      {...hold}
      onClick={() => {
        if (!endsHold()) onSend(text);
      }}
    >
      {text}
    </Button>
  );
}
