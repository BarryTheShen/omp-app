import { type MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { ChevronRightIcon } from "lucide-react";
import {
  Children,
  Fragment,
  isValidElement,
  type ReactNode,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { reasoningGroupBy } from "../reasoning";

/**
 * One omp turn is one message, and an agent loop can be thousands of steps long (a real chat has a
 * turn of 1,472). Mounting every step costs about twenty DOM nodes each, which froze the page. A
 * turn longer than this keeps its latest steps on screen and folds every step before them behind
 * one disclosure, which mounts nothing until it is opened.
 */
export const KEEP_LAST_STEPS = 20;
/** Folding fewer steps than this is not worth a disclosure. */
export const MIN_EARLIER_STEPS = 20;
/** One click on "Show more" mounts this many folded steps. */
export const EARLIER_STEPS_PAGE = 50;

export type EarlierStepsGroupPart = MessagePrimitive.GroupedParts.GroupPart<"group-earlier">;
type Part = Parameters<typeof reasoningGroupBy>[0];
type GroupContext = Parameters<typeof reasoningGroupBy>[1];
export type TurnGroupKey = "group-earlier" | "group-reasoning";
export type TurnGroupBy = (part: Part, context: GroupContext) => readonly TurnGroupKey[] | null;

/** Narrows a rendered node to one of the turn's group kinds (the library types a group by its key). */
export function isTurnGroup<Key extends TurnGroupKey>(
  part: { readonly type: string },
  key: Key,
): part is MessagePrimitive.GroupedParts.GroupPart<Key> {
  return part.type === key;
}

/** How many leading parts of a turn fold away (0 when the turn is short enough to show whole). */
export function earlierStepsEnd(partCount: number): number {
  return partCount >= KEEP_LAST_STEPS + MIN_EARLIER_STEPS ? partCount - KEEP_LAST_STEPS : 0;
}

/**
 * Groups the first `end` parts into one "earlier steps" group, and keeps reasoning grouped inside
 * and after it. The library calls `groupBy` per part without a position, so the position comes from
 * the part's place in `parts` (the same array the library groups).
 */
export function earlierStepsGroupBy(parts: readonly Part[], end: number): TurnGroupBy {
  if (end === 0) return reasoningGroupBy;
  const positions = new Map<Part, number>();
  parts.forEach((part, index) => {
    positions.set(part, index);
  });
  return (part, context) => {
    const inner = reasoningGroupBy(part, context);
    const position = positions.get(part);
    if (position === undefined || position >= end) return inner;
    return ["group-earlier", ...(inner ?? [])];
  };
}

/**
 * The `groupBy` for the message being rendered; stable while its parts and fold point are. It reads
 * the parts from the store the library groups, so each part is the same object in both places.
 */
export function useTurnGroupBy(enabled: boolean): TurnGroupBy {
  const parts = useAuiState((state) => state.message.parts);
  const end = enabled ? earlierStepsEnd(parts.length) : 0;
  return useMemo(() => earlierStepsGroupBy(parts, end), [parts, end]);
}

function isReactNode(value: unknown): value is ReactNode {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    isValidElement(value) ||
    (typeof value === "object" && Symbol.iterator in value)
  );
}

/**
 * The folded steps, one node each. The library renders a group's subtree as one fragment of
 * elements; unmounted elements cost nothing, so only the page that is shown gets mounted.
 */
function stepNodes(children: ReactNode): readonly ReactNode[] {
  if (isValidElement(children) && children.type === Fragment) {
    const inner: unknown = Object.getOwnPropertyDescriptor(children.props, "children")?.value;
    if (isReactNode(inner)) return Children.toArray(inner);
  }
  return Children.toArray(children);
}

export function EarlierSteps({
  group,
  children,
}: {
  readonly group: Pick<EarlierStepsGroupPart, "indices">;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(EARLIER_STEPS_PAGE);
  const bodyId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const restRef = useRef<HTMLButtonElement>(null);
  const total = group.indices.length;
  // Nothing is built while the disclosure is closed.
  const steps = useMemo(() => (open ? stepNodes(children) : []), [children, open]);
  const remaining = Math.max(0, steps.length - shown);
  // A button that leaves the row takes the keyboard focus with it, and focus then falls to the page body. So a
  // press that removes its own button moves focus first: "Show 50 more" to the rest button, which stays while any
  // remain; "Show all" or "Show the last" to the toggle, which stays while the block is open.
  const showPage = () => {
    if (steps.length - shown - EARLIER_STEPS_PAGE <= EARLIER_STEPS_PAGE) restRef.current?.focus();
    setShown((value) => value + EARLIER_STEPS_PAGE);
  };
  const showRest = () => {
    toggleRef.current?.focus();
    setShown(steps.length);
  };
  return (
    <div className="mb-3" data-open={open ? "true" : "false"} data-slot="u1-earlier-steps">
      <button
        aria-controls={bodyId}
        aria-expanded={open}
        ref={toggleRef}
        className="text-muted-foreground hover:text-foreground flex items-center gap-2 py-1.5 text-sm transition-colors"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 transition-transform duration-(--duration-base) motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span className="tabular-nums">{total.toLocaleString("en-US")} earlier steps</span>
      </button>
      {open && (
        <div className="border-border ms-2 border-s ps-4" id={bodyId}>
          {steps.slice(0, shown)}
          {remaining > 0 && (
            <div className="flex flex-wrap items-center gap-2 py-2">
              {remaining > EARLIER_STEPS_PAGE && (
                <Button onClick={showPage} size="sm" type="button" variant="outline">
                  Show {EARLIER_STEPS_PAGE} more steps
                </Button>
              )}
              <Button ref={restRef} onClick={showRest} size="sm" type="button" variant="outline">
                {remaining > EARLIER_STEPS_PAGE
                  ? `Show all ${remaining.toLocaleString("en-US")} remaining`
                  : `Show the last ${remaining.toLocaleString("en-US")}`}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
