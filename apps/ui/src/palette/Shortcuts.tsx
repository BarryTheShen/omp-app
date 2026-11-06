import { cn } from "cn";
import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { desktopBridge } from "../desktop/bridge";
import {
  BINDINGS,
  browserKeeps,
  chords,
  inAppWindow,
  type KeyBinding,
  keycap,
} from "../keys/table";

const GROUPS: readonly KeyBinding["group"][] = [
  "Windows",
  "Workspaces",
  "Message box",
  "Transcript",
  "App",
];

/**
 * Every key of the app, grouped, from the one key table. In a browser tab, the keys the browser keeps for its own tabs
 * show dimmed with a star, and a note says where they work (#2831); an app window's own keys (Ctrl+1…9) are left out.
 */
export function KeyList(): ReactNode {
  const desktop = desktopBridge() !== null;
  const appWindow = inAppWindow();
  const shown = BINDINGS.filter(
    (binding) =>
      (binding.desktopOnly !== true || desktop) && (binding.appWindowOnly !== true || appWindow),
  );
  return (
    <div className="flex flex-col gap-5">
      {!appWindow && (
        <p data-browser-keeps="" className="text-xs text-t3">
          <span aria-hidden="true">* </span>A browser tab keeps these keys for its own tabs. They
          reach the app in the desktop app, in the app installed from Chrome or Edge, and in Chrome
          or Edge in full screen (F11).
        </p>
      )}
      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
        {GROUPS.map((group) => (
          <section key={group} aria-label={group}>
            <h3 className="pb-1.5 text-xs font-medium text-t3">{group}</h3>
            <dl className="flex flex-col gap-1.5 text-[0.8125rem]">
              {shown
                .filter((binding) => binding.group === group)
                .map((binding) => (
                  <div key={binding.id} className="flex items-start justify-between gap-3">
                    <dt className="min-w-0 flex-1 text-t2">{binding.label}</dt>
                    {/* The alternatives wrap within the row's right part, each keycap its own height. */}
                    <dd className="flex max-w-[55%] flex-wrap items-start justify-end gap-1">
                      {chords(binding).map((chord) => {
                        const kept = !appWindow && browserKeeps(chord);
                        return (
                          <kbd
                            key={chord}
                            data-browser-kept={kept ? "" : undefined}
                            className={cn(
                              "rounded-sm border border-l2 px-1 font-mono text-[11px] whitespace-nowrap text-t1",
                              kept && "border-dashed text-t3",
                            )}
                          >
                            {keycap({ hotkey: chord })}
                            {kept && (
                              <>
                                <span aria-hidden="true">*</span>
                                <span className="sr-only"> (the browser keeps it in a tab)</span>
                              </>
                            )}
                          </kbd>
                        );
                      })}
                    </dd>
                  </div>
                ))}
            </dl>
          </section>
        ))}
      </div>
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
