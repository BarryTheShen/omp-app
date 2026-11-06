import { Paperclip, Pause, Play, Plus, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * The phone's ＋ beside the message box (#2837): one sheet for what the box does besides typing, so nothing comes up
 * between the box and the keyboard. Pause or Resume while omp works or the chat is paused, Photo or file (the
 * device's picker: the photo library, the camera, Files), the quick prompts, then the box's settings (model, thinking,
 * plan mode, goal), whose own menus open over it. Its open state is the box's: the model menu opened from elsewhere
 * opens the sheet, where the model's chip is.
 */
export function PlusMenu({
  open,
  onOpenChange,
  settings,
  closed,
  onAttach,
  onQuickPrompts,
  pause,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The box's setting chips, as the box draws them on a desktop. */
  readonly settings: ReactNode;
  /** The chat could not be opened: nothing can be attached. */
  readonly closed: boolean;
  /** Opens the device's picker; within the tap, as iOS asks. */
  readonly onAttach: () => void;
  /** Opens the quick panel in the keyboard's place. */
  readonly onQuickPrompts: () => void;
  /** Pause or Resume: shown while omp works or the chat is paused. */
  readonly pause?: { readonly paused: boolean; readonly onPress: () => void };
}): ReactNode {
  /** A row's action closes the sheet first: what it opens takes the screen. */
  const act = (run: () => void) => () => {
    onOpenChange(false);
    run();
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 text-t2"
            aria-label="More"
            data-tour="plus"
          />
        }
      >
        <Plus />
      </PopoverTrigger>
      <PopoverContent data-tour="plus-sheet" side="top" align="start" className="gap-0 p-1.5">
        {pause !== undefined && (
          <Row
            label={pause.paused ? "Resume" : "Pause"}
            icon={pause.paused ? <Play /> : <Pause />}
            onPress={act(pause.onPress)}
          />
        )}
        <Row
          label="Photo or file"
          icon={<Paperclip />}
          tour="attach-files"
          disabled={closed}
          onPress={act(onAttach)}
        />
        <Row label="Quick prompts" icon={<Zap />} onPress={act(onQuickPrompts)} />
        <fieldset
          aria-label="This chat"
          className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5 border-t border-l2 px-1 pt-2 [&_button]:min-h-11"
        >
          {settings}
        </fieldset>
      </PopoverContent>
    </Popover>
  );
}

function Row({
  label,
  icon,
  tour,
  disabled,
  onPress,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  /** The row's name for a tour step. */
  readonly tour?: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}): ReactNode {
  return (
    <Button
      type="button"
      variant="ghost"
      className="h-11 w-full justify-start gap-3 px-3 text-base text-t1"
      data-tour={tour}
      disabled={disabled}
      onClick={onPress}
    >
      {icon}
      {label}
    </Button>
  );
}
