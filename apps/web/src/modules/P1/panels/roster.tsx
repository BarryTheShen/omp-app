import type { KeyboardEvent } from "react";
import { useRef } from "react";
import { ListRow, Section } from "@/components/blocks";
import type { HubSection } from "./model";
import { StatusChip } from "./status-chip";

export interface RosterListProps {
  readonly sections: readonly HubSection[];
  readonly onSelect: (key: string) => void;
}

const OPTION_SELECTOR = '[role="option"]';

/** The worker rows, grouped by section. Arrow keys move focus; a passive update never moves it. */
export function RosterList({ sections, onSelect }: RosterListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const rows = sections.flatMap((section) => section.rows);
  // Exactly one row sits in the tab order: the selected worker, or the first one.
  const tabStopKey = (rows.find((row) => row.selected) ?? rows[0])?.key;

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const options = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>(OPTION_SELECTOR) ?? [],
    );
    const step = event.key === "ArrowDown" ? 1 : -1;
    options[options.indexOf(event.currentTarget) + step]?.focus();
  }

  return (
    <div className="flex flex-col gap-4" ref={listRef}>
      {sections.map((section) => (
        <Section heading={section.heading} headingLevel={3} key={section.key} variant="plain">
          <div aria-label={section.heading} className="flex flex-col gap-0.5" role="listbox">
            {section.rows.map((row) => (
              <ListRow
                detail={row.summary}
                key={row.key}
                leading={
                  // A fixed column, wide enough for "Cancelled", so every title starts at one x.
                  <span className="flex w-24 shrink-0">
                    <StatusChip presentation={row.status} />
                  </span>
                }
                onKeyDown={moveFocus}
                onSelect={() => onSelect(row.key)}
                selected={row.selected}
                tabIndex={row.key === tabStopKey ? 0 : -1}
                title={row.title}
              />
            ))}
          </div>
        </Section>
      ))}
    </div>
  );
}
