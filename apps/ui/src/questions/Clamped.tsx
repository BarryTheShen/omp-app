import { cn } from "cn";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Text that shows its start in a card (`clamp`): longer than about 12 lines, or with a table, it fades out and offers
 * Read all, which shows the whole of it elsewhere (`onReadAll`). Unclamped, it is the text as it is.
 */
export function Clamped({
  clamp,
  onReadAll,
  label,
  className,
  children,
}: {
  readonly clamp: boolean;
  readonly onReadAll: () => void;
  /** A name for the text's region ("The plan"); none, and it is no region. */
  readonly label?: string;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactNode {
  const box = useRef<HTMLElement>(null);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null || !clamp) {
      setLong(false);
      return;
    }
    const check = (): void =>
      setLong(
        element.scrollHeight > element.clientHeight + 1 || element.querySelector("table") !== null,
      );
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [clamp]);
  return (
    <>
      <section
        ref={box}
        aria-label={label}
        className={cn(
          className,
          clamp && "max-h-[12lh] overflow-hidden",
          clamp && long && "[mask-image:linear-gradient(to_bottom,black_75%,transparent)]",
        )}
      >
        {children}
      </section>
      {clamp && long && (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="self-start px-0"
          onClick={onReadAll}
        >
          Read all
        </Button>
      )}
    </>
  );
}
