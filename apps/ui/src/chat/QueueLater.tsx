import type { TaskWhen } from "@omp-app/contracts";
import { Clock } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { fromLocalInput, localInput } from "./taskTime";

const ROW = "flex items-center gap-2 text-[0.8125rem] text-t1";

/**
 * Queue for later (#14), beside Send once something is typed: the message becomes a task for this chat, sent as soon
 * as the chat is free, after its provider's 5-hour window resets, or at a time; till then it waits on the dashboard's
 * Tasks. Not a form of its own: the message box around it is one.
 */
export function QueueLater({
  phone,
  disabled,
  onQueue,
}: {
  readonly phone: boolean;
  readonly disabled: boolean;
  readonly onQueue: (when: TaskWhen) => Promise<void>;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState<TaskWhen["kind"]>("free");
  const [at, setAt] = useState(() => localInput(Date.now() + 60 * 60_000));
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const row = `${ROW} ${phone ? "min-h-11" : "min-h-9 tablet:min-h-11"}`;

  const queue = async (): Promise<void> => {
    let goes: TaskWhen = { kind: "free" };
    if (when === "at") {
      const ms = fromLocalInput(at);
      if (ms === null) {
        setProblem("Pick the time it goes.");
        return;
      }
      goes = { kind: "at", at: ms };
    } else if (when === "reset") {
      goes = { kind: "reset" };
    }
    setSaving(true);
    setProblem(null);
    try {
      await onQueue(goes);
      setOpen(false);
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setProblem(null);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size={phone ? "icon" : "icon-sm"}
            className={phone ? "size-11 shrink-0" : "tablet:size-11"}
            aria-label="Queue for later"
            data-tour="queue-later"
            disabled={disabled}
          />
        }
      >
        <Clock />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        aria-label="Queue for later"
        className="flex w-72 max-w-[calc(100vw-1rem)] flex-col gap-2"
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          void queue();
        }}
      >
        <p className="text-[0.8125rem] font-medium text-t1">Queue this message for later</p>
        <RadioGroup
          aria-label="It goes"
          className="gap-0"
          value={when}
          onValueChange={(next) => {
            if (next === "free" || next === "reset" || next === "at") setWhen(next);
          }}
        >
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control */}
          <label className={row}>
            <RadioGroupItem value="free" aria-label="When this chat is free" />
            When this chat is free
          </label>
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control */}
          <label className={row}>
            <RadioGroupItem value="reset" aria-label="After its window resets" />
            After its window resets
          </label>
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control */}
          <label className={row}>
            <RadioGroupItem value="at" aria-label="At a time" />
            At a time
          </label>
        </RadioGroup>
        {when === "at" && (
          <Input
            aria-label="Time"
            type="datetime-local"
            className={`dark:bg-transparent ${phone ? "h-11" : "tablet:h-11"}`}
            value={at}
            onChange={(event) => setAt(event.target.value)}
          />
        )}
        <p className="text-xs text-pretty text-t3">
          It waits on the dashboard's Tasks and goes only while this chat is free: no turn running,
          not paused.
        </p>
        {problem !== null && (
          <p role="alert" className="text-xs text-bad-ink">
            {problem}
          </p>
        )}
        <Button
          type="button"
          className={`self-start ${phone ? "h-11" : ""}`}
          disabled={saving}
          onClick={() => void queue()}
        >
          Queue it
        </Button>
      </PopoverContent>
    </Popover>
  );
}
