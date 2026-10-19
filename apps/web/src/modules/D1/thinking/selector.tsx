import { Popover } from "@base-ui/react/popover";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { zIndexTokens } from "@/tokens";
import type { ThinkingLevel } from "../contract";
import type { ThinkingLevelsController } from "./thinking";

const ALL_LEVELS: readonly ThinkingLevel[] = [
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function useThinkingSnapshot(controller: ThinkingLevelsController) {
  const subscribe = useCallback(
    (listener: Parameters<ThinkingLevelsController["subscribe"]>[0]) =>
      controller.subscribe(listener),
    [controller],
  );
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The level as the person reads it: `xhigh` is "Extra high", never the raw value. */
export function thinkingLevelLabel(level: ThinkingLevel): string {
  const first = level[0] ?? "";
  return level === "xhigh" ? "Extra high" : first.toUpperCase() + level.slice(1);
}

export function ThinkingSelector({
  controller,
  onApplied,
}: {
  readonly controller: ThinkingLevelsController;
  /** Called after omp has taken the new level (the header reads omp's state again). */
  readonly onApplied?: () => void;
}) {
  const snapshot = useThinkingSnapshot(controller);
  const unavailable = !snapshot.reasoning;
  useEffect(() => {
    if (snapshot.loadState === "idle") void controller.refresh().catch(() => undefined);
  }, [controller, snapshot.loadState]);
  const apply = (level: ThinkingLevel) => {
    if (!snapshot.levels.includes(level)) return;
    void controller
      .apply({ level, scope: "session" })
      .then(() => onApplied?.())
      .catch(() => undefined);
  };
  const currentLabel = snapshot.current
    ? thinkingLevelLabel(snapshot.current)
    : snapshot.loadState === "loading"
      ? "Loading…"
      : "Unavailable";
  return (
    <section
      aria-labelledby="d1-thinking-title"
      className="bg-card text-card-foreground flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 p-4 shadow-sm"
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 id="d1-thinking-title" className="text-base font-semibold">
            Thinking level
          </h2>
          <p className="text-xs text-muted-foreground">Session reasoning depth</p>
        </div>
      </header>
      {unavailable ? (
        <p
          role="status"
          className="border-foreground/10 bg-muted/30 rounded-surface border px-3 py-2 text-sm text-muted-foreground"
        >
          The current model does not support thinking levels.
        </p>
      ) : snapshot.loadState === "error" ? (
        <div role="alert" className="flex flex-col gap-2 text-sm text-destructive">
          <span>{snapshot.error?.message ?? "Thinking levels unavailable."}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-fit"
            onClick={() => void controller.refresh().catch(() => undefined)}
          >
            Retry
          </Button>
        </div>
      ) : (
        <>
          <Popover.Root>
            <Popover.Trigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full justify-between"
                />
              }
            >
              <span>Thinking: {currentLabel}</span>
              {snapshot.configured === "auto" ? (
                <span className="text-xs text-muted-foreground">Model default</span>
              ) : null}
            </Popover.Trigger>
            <Popover.Portal>
              {/* The list opens from inside a modal dialog: the popover layer is above the modal's. */}
              <Popover.Positioner
                sideOffset={6}
                align="start"
                style={{ zIndex: zIndexTokens.popover }}
              >
                <Popover.Popup
                  role="listbox"
                  aria-label="Thinking levels"
                  className="bg-popover text-popover-foreground flex w-64 flex-col gap-1 rounded-surface border border-foreground/10 p-1 shadow-none outline-none"
                >
                  <Popover.Title className="px-2 py-1 text-sm font-medium text-muted-foreground">
                    Thinking levels
                  </Popover.Title>
                  {ALL_LEVELS.map((level) => {
                    const supported = snapshot.levels.includes(level);
                    return (
                      <Button
                        key={level}
                        type="button"
                        role="option"
                        aria-selected={snapshot.current === level}
                        disabled={!supported}
                        variant={snapshot.current === level ? "secondary" : "ghost"}
                        className="flex h-auto items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm text-start hover:bg-muted focus:bg-muted dark:hover:bg-muted dark:focus:bg-muted"
                        title={
                          supported
                            ? `Use ${thinkingLevelLabel(level)}`
                            : level === "inherit"
                              ? "Only available in omp's settings, not for one session"
                              : "Not supported by the current model"
                        }
                        onClick={() => apply(level)}
                      >
                        <span>{thinkingLevelLabel(level)}</span>
                        {!supported ? (
                          <span className="text-xs text-muted-foreground">Unavailable</span>
                        ) : null}
                      </Button>
                    );
                  })}
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
          {snapshot.current ? (
            <p className="text-xs text-muted-foreground">
              Current: {thinkingLevelLabel(snapshot.current)}
              {snapshot.configured === "auto" ? " · Model default" : ""}
            </p>
          ) : null}
        </>
      )}
      {snapshot.error && !unavailable && snapshot.loadState !== "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {snapshot.error.message}
        </p>
      ) : null}
    </section>
  );
}
