import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  promptsFrom,
  STARTING_PROMPTS,
  setQuickPrompts,
  useQuickPrompts,
} from "../chat/quickPrompts";

/** The prompts ⚡ offers above a phone's keyboard, one a line, kept on this phone. */
export function QuickPromptsSection(): ReactNode {
  const prompts = useQuickPrompts();
  const [text, setText] = useState(() => prompts.join("\n"));
  const typed = promptsFrom(text.split("\n"));
  const saved = typed.join("\n") === prompts.join("\n");
  const starting = saved && prompts.join("\n") === STARTING_PROMPTS.join("\n");
  return (
    <>
      <h3 className="mt-6 text-xs font-medium text-t3">Quick prompts</h3>
      <div className="border-b border-l1 py-3">
        <p className="text-sm text-t1">What ⚡ offers above the keyboard</p>
        <p className="mt-0.5 text-xs text-t3">
          One prompt a line, kept on this phone. A tap there sends one as it is.
        </p>
        <textarea
          aria-label="Quick prompts"
          value={text}
          rows={8}
          onChange={(event) => setText(event.target.value)}
          className="mt-2 block w-full resize-y rounded-md border border-l2 bg-transparent px-3 py-2 text-base leading-snug text-t1 outline-none focus:border-l4"
        />
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            disabled={saved || typed.length === 0}
            onClick={() => {
              setQuickPrompts(typed);
              setText(typed.join("\n"));
            }}
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={starting}
            onClick={() => {
              setQuickPrompts(null);
              setText(STARTING_PROMPTS.join("\n"));
            }}
          >
            Use the starting set
          </Button>
        </div>
      </div>
    </>
  );
}
