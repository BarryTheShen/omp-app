import { Keyboard, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * The quick prompts' key, beside Send in the phone's box (#2837): ⚡ puts the quick panel in the keyboard's place, ⌨ in
 * its place brings the keyboard back.
 */
export function QuickPromptsKey({
  open,
  onPress,
}: {
  /** Whether the quick panel is open in the keyboard's place. */
  readonly open: boolean;
  readonly onPress: () => void;
}): ReactNode {
  return (
    <Button
      data-tour="quick-prompts-key"
      type="button"
      variant="ghost"
      size="icon"
      className="size-11 shrink-0 text-t2"
      aria-label={open ? "Keyboard" : "Quick prompts"}
      aria-expanded={open}
      onClick={onPress}
    >
      {open ? <Keyboard /> : <Zap />}
    </Button>
  );
}
