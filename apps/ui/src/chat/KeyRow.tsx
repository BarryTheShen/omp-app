import { ArrowDown, ArrowUp, ChevronDown, Keyboard, Zap } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { Button } from "@/components/ui/button";

/**
 * The phone's key row, under the message box and so right above the keyboard (Termius's keyboard add-on), shown while
 * the keyboard or the quick panel is up (#2837): the quick panel's key (⚡, in the keyboard's place; ⌨ brings the
 * keyboard back), then the keys a phone's keyboard lacks: `/` for omp's commands, `@` for files, `!` for the shell, the
 * messages sent before with ↑ and ↓, and ⌄ to put the keyboard away. One line of equal keys, nothing scrolls sideways:
 * the box's settings and Pause are behind ＋ (`PlusMenu`). A key keeps the focus where it is, so the keyboard stays up
 * while one is pressed.
 */
export function KeyRow({
  keyboardUp,
  panelOpen,
  onPanel,
  onInsert,
  onHistory,
  onHideKeyboard,
}: {
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
      data-tour="phone-keys"
      role="toolbar"
      aria-label="Keys"
      className="flex items-center gap-1.5 px-0.5 pt-1.5 [&_button]:min-h-11 [&_button]:min-w-0 [&_button]:flex-1 [&_button]:rounded-lg [&_button]:bg-secondary [&_button]:text-t1"
      // The box keeps the focus: a key pressed while typing leaves the keyboard up. A phone's tap sends a mouse press
      // after its pointer one; the tap that brings the row up under the box sends it here, over a key it never touched,
      // so a mouse press is cancelled too (#2837).
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      <Key
        tour="quick-prompts-key"
        label={panelOpen ? "Keyboard" : "Quick prompts"}
        expanded={panelOpen}
        onPress={onPanel}
      >
        {panelOpen ? <Keyboard /> : <Zap />}
      </Key>
      <Key label="Commands" onPress={() => onInsert("/")}>
        /
      </Key>
      <Key label="Files" onPress={() => onInsert("@")}>
        @
      </Key>
      <Key label="Shell" onPress={() => onInsert("!")}>
        !
      </Key>
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
  tour,
}: {
  readonly label: string;
  /** For a key that opens something: whether it is open. */
  readonly expanded?: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
  /** The key's name for a tour step. */
  readonly tour?: string;
}): ReactNode {
  /**
   * Whether a pointer went down on this key. The row comes up under the box when a tap gives the box the focus and
   * moves it up, so that tap's click can end over a key it never touched: only a press that began here, or a
   * keyboard's click, presses the key.
   */
  const pressed = useRef(false);
  return (
    <Button
      data-tour={tour}
      type="button"
      variant="secondary"
      size="sm"
      aria-label={label}
      aria-expanded={expanded}
      className="font-mono text-base"
      onPointerDown={() => {
        pressed.current = true;
      }}
      onPointerCancel={() => {
        pressed.current = false;
      }}
      onClick={(event) => {
        // A keyboard's click has no pointer behind it (`detail` 0).
        const fromPointer = event.detail !== 0;
        if (fromPointer && !pressed.current) return;
        pressed.current = false;
        onPress();
      }}
    >
      {children}
    </Button>
  );
}
