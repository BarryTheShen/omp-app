import { ArrowDown, ArrowUp, ChevronDown, Keyboard, Zap } from "lucide-react";
import { type MouseEvent, type ReactNode, useRef } from "react";
import { Button } from "@/components/ui/button";

/**
 * The phone's key row, under the message box and so right above the keyboard (Termius's keyboard add-on), shown while
 * the keyboard or the quick panel is up (#2837): the keys a phone's keyboard lacks, `/` for omp's commands, `@` for
 * files, `!` for the shell, the messages sent before with ↑ and ↓, and ⌄ to put the keyboard away. One line of equal
 * keys, nothing scrolls sideways: the quick prompts' key sits beside Send (`QuickPromptsKey`), the box's settings and
 * Pause behind ＋ (`PlusMenu`). A key keeps the focus where it is, so the keyboard stays up while one is pressed.
 */
export function KeyRow({
  keyboardUp,
  onInsert,
  onHistory,
  onHideKeyboard,
}: {
  /** Whether the box has the focus, so the keyboard is up. */
  readonly keyboardUp: boolean;
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

/**
 * A key's own press: it acts only on a press that began on it, or on a keyboard's click (`detail` 0, no pointer behind
 * it). The row comes up under the box when a tap gives the box the focus and moves it up, so that tap's click can end
 * over a key it never touched (#2837).
 */
function useOwnPress(onPress: () => void) {
  const pressed = useRef(false);
  return {
    onPointerDown: () => {
      pressed.current = true;
    },
    onPointerCancel: () => {
      pressed.current = false;
    },
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      if (event.detail !== 0 && !pressed.current) return;
      pressed.current = false;
      onPress();
    },
  };
}

function Key({
  label,
  onPress,
  children,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const press = useOwnPress(onPress);
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      aria-label={label}
      className="font-mono text-base"
      {...press}
    >
      {children}
    </Button>
  );
}

/**
 * The quick prompts' key, beside Send in the phone's box (#2837): ⚡ puts the quick panel in the keyboard's place, ⌨
 * brings the keyboard back. As the row's keys do, it leaves the focus where it is and acts only on its own press.
 */
export function QuickPromptsKey({
  open,
  onPress,
}: {
  /** Whether the quick panel is open in the keyboard's place. */
  readonly open: boolean;
  readonly onPress: () => void;
}): ReactNode {
  const press = useOwnPress(onPress);
  return (
    <Button
      data-tour="quick-prompts-key"
      type="button"
      variant="ghost"
      size="icon"
      className="size-11 shrink-0 text-t2"
      aria-label={open ? "Keyboard" : "Quick prompts"}
      aria-expanded={open}
      {...press}
      onPointerDown={(event) => {
        event.preventDefault();
        press.onPointerDown();
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {open ? <Keyboard /> : <Zap />}
    </Button>
  );
}
