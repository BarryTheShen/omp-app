import { ChevronDownIcon } from "lucide-react";
import { useId, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { MarkdownContent } from "../markdown";

/**
 * The `customType` omp gives a `/skill:<name>` run (`SKILL_PROMPT_MESSAGE_TYPE`), as a real omp 18.8.9 run records it.
 * Its `content` is the full generated prompt the model receives; its `details` are the skill's facts.
 */
export const SKILL_PROMPT_CUSTOM_TYPE = "skill-prompt";

/** What one skill run shows: its facts from omp's `details`, and the prompt it generated. */
interface SkillPromptView {
  /** The skill's name, or undefined when omp recorded none. */
  readonly name: string | undefined;
  /** What the user typed after the skill name, or undefined when there was none. */
  readonly args: string | undefined;
  /** The SKILL.md file the skill was loaded from, or undefined when omp recorded none. */
  readonly source: string | undefined;
  /** The full generated prompt; empty when omp sent none. */
  readonly prompt: string;
}

/** A non-empty string field of omp's `details`, or undefined. Other shapes are never trusted. */
function textField(details: unknown, key: string): string | undefined {
  if (typeof details !== "object" || details === null || !(key in details)) return undefined;
  const value: unknown = Reflect.get(details, key);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The skill card's facts, read from the `details` a real omp 18.8.9 run records (`name`, `path`, `args`, `prompt`,
 * `lineCount`): this reads `name`, `args` and `path`. A message whose details lack them still shows its prompt.
 */
export function describeSkillPrompt(details: unknown, prompt: string): SkillPromptView {
  return {
    name: textField(details, "name"),
    args: textField(details, "args"),
    source: textField(details, "path"),
    prompt: prompt.trim(),
  };
}

/**
 * One skill run in the chat: a single line with the skill's name and a control, its arguments and source,
 * and the generated prompt. The prompt is not on the page until the control opens it.
 */
export function SkillPromptCard({ view }: { readonly view: SkillPromptView }) {
  const [open, setOpen] = useState(false);
  const promptId = useId();
  return (
    <Collapsible
      className="flex min-w-0 flex-col gap-1"
      data-slot="u1-skill-card"
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger
        aria-controls={promptId}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-start text-sm outline-none hover:bg-background/60 focus-visible:ring-3 focus-visible:ring-ring/50"
        data-slot="u1-skill-card-trigger"
      >
        <span className="shrink-0 text-xs font-medium text-muted-foreground">Skill</span>
        {view.name !== undefined && (
          <span className="min-w-0 truncate font-medium text-foreground">{view.name}</span>
        )}
        <span className="ms-auto shrink-0 text-xs text-muted-foreground">
          {open ? "Hide prompt" : "Show prompt"}
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Arguments</dt>
        <dd className="min-w-0 break-words text-foreground">{view.args ?? "None"}</dd>
        <dt className="text-muted-foreground">From</dt>
        <dd className="min-w-0 break-all text-foreground">{view.source ?? "Not recorded"}</dd>
      </dl>
      <CollapsibleContent data-slot="u1-skill-card-prompt" id={promptId}>
        <div className="bg-background mt-1 max-h-80 min-w-0 overflow-auto rounded-md px-3 py-2">
          {view.prompt === "" ? (
            <p className="text-xs text-muted-foreground">No prompt was recorded.</p>
          ) : (
            <MarkdownContent text={view.prompt} variant="compact" />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
