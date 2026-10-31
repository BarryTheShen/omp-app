import { ArrowDown, ArrowUp, ChevronDown, Keyboard, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * The phone's key row, under the message box and so right above the keyboard (Termius's keyboard add-on): the quick
 * panel's key (⚡, in the keyboard's place; ⌨ brings the keyboard back), the box's settings (model, thinking, plan mode,
 * goal), then the keys a phone's keyboard lacks: `/` for omp's commands, `@` for files, `!` for the shell, the messages
 * sent before with ↑ and ↓, and ⌄ to put the keyboard away. A key keeps the focus where it is, so the keyboard stays up
 * while one is pressed; the row scrolls sideways where the phone is narrow.
 */
export function KeyRow({
  settings,
  keyboardUp,
  panelOpen,
  onPanel,
  onInsert,
  onHistory,
  onHideKeyboard,
}: {
  /** The box's setting chips, as the box draws them on a desktop. */
  readonly settings: ReactNode;
  /** Whether the box has the focus, so the keyboard is up. */
  readonly keyboardUp: boolean;
  /** Whether the quick panel is open in the keyboard's place. */
  readonly panelOpen: boolean;
  /** Opens the quick panel, or closes it and brings the keyboard back. */
  readonly onPanel: () => void;
  /** Puts the character at the caret, as typing it would. */
  readonly onInsert: (character: string) => void;
  /** Goes back (-1) or forward (1) through the messages sent before. */
  readonly onHistory: (step: -1 | 1) => void;
  readonly onHideKeyboard: () => void;
}): ReactNode {
  return (
    <div
      role="toolbar"
      aria-label="Keys"
      // Every button in the row looks like a key, the settings' chips too.
      className="flex items-center gap-1.5 overflow-x-auto px-0.5 pt-2 [scrollbar-width:none] [&_button]:min-h-11 [&_button]:shrink-0 [&_button]:rounded-lg [&_button]:bg-secondary [&_button]:text-t1 [&::-webkit-scrollbar]:hidden"
      // The box keeps the focus: a key pressed while typing leaves the keyboard up.
      onPointerDown={(event) => event.preventDefault()}
    >
      <Key label={panelOpen ? "Keyboard" : "Quick prompts"} expanded={panelOpen} onPress={onPanel}>
        {panelOpen ? <Keyboard /> : <Zap />}
      </Key>
      {settings}
      <span aria-hidden="true" className="mx-0.5 h-6 w-px shrink-0 bg-l2" />
      <Key label="Commands" onPress={() => onInsert("/")}>
        /
      </Key>
      <Key label="Files" onPress={() => onInsert("@")}>
        @
      </Key>
      <Key label="Shell" onPress={() => onInsert("!")}>
        !
      </Key>
      <span aria-hidden="true" className="mx-0.5 h-6 w-px shrink-0 bg-l2" />
      <Key label="Earlier message" onPress={() => onHistory(-1)}>
        <ArrowUp />
      </Key>
      <Key label="Later message" onPress={() => onHistory(1)}>
        <ArrowDown />
      </Key>
      {keyboardUp && (
        <Key label="Hide the keyboard" onPress={onHideKeyboard}>
          <ChevronDown />
        </Key>
      )}
    </div>
  );
}

function Key({
  label,
  expanded,
  onPress,
  children,
}: {
  readonly label: string;
  /** For a key that opens something: whether it is open. */
  readonly expanded?: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      aria-label={label}
      aria-expanded={expanded}
      className="min-w-11 font-mono text-base"
      onClick={onPress}
    >
      {children}
    </Button>
  );
}
