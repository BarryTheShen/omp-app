import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { BINDINGS, chords, type KeyBinding, keycap } from "../keys/table";

const GROUPS: readonly KeyBinding["group"][] = [
  "Panes",
  "Tabs",
  "Message box",
  "Transcript",
  "App",
];

/** Every key of the app, grouped, from the one key table. */
export function KeyList(): ReactNode {
  return (
    <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
      {GROUPS.map((group) => (
        <section key={group} aria-label={group}>
          <h3 className="pb-1.5 text-xs font-medium text-t3">{group}</h3>
          <dl className="flex flex-col gap-1.5 text-[0.8125rem]">
            {BINDINGS.filter((binding) => binding.group === group).map((binding) => (
              <div key={binding.id} className="flex items-start justify-between gap-3">
                <dt className="min-w-0 flex-1 text-t2">{binding.label}</dt>
                {/* The alternatives wrap within the row's right part, each keycap its own height. */}
                <dd className="flex max-w-[55%] flex-wrap items-start justify-end gap-1">
                  {chords(binding).map((chord) => (
                    <kbd
                      key={chord}
                      className="rounded-sm border border-l2 px-1 font-mono text-[11px] whitespace-nowrap text-t1"
                    >
                      {keycap({ hotkey: chord })}
                    </kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

/** The keys sheet (Ctrl+/). */
export function Shortcuts({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-tour="keys" className="max-h-[80vh] overflow-y-auto sm:max-w-3xl">
        <DialogTitle>Keys</DialogTitle>
        <KeyList />
      </DialogContent>
    </Dialog>
  );
}
