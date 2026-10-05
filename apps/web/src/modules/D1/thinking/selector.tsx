import { Popover } from "@base-ui/react/popover";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
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

function label(level: ThinkingLevel): string {
  const first = level[0] ?? "";
  return level === "xhigh"
    ? "Xhigh"
    : level === "max"
      ? "Max"
      : first.toUpperCase() + level.slice(1);
}

export function ThinkingSelector({
  controller,
}: {
  readonly controller: ThinkingLevelsController;
}) {
  const snapshot = useThinkingSnapshot(controller);
  const unavailable = !snapshot.reasoning;
  useEffect(() => {
    if (snapshot.loadState === "idle") void controller.refresh().catch(() => undefined);
  }, [controller, snapshot.loadState]);
  const apply = (level: ThinkingLevel) => {
    if (!snapshot.levels.includes(level)) return;
    void controller.apply({ level, scope: "session" }).catch(() => undefined);
  };
  const currentLabel = snapshot.current
    ? label(snapshot.current)
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
        <span className="rounded-full border border-border/70 px-2 py-1 text-xs text-muted-foreground">
          session
        </span>
      </header>
      {unavailable ? (
        <p
          role="status"
          className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
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
              <Popover.Positioner sideOffset={6} align="start">
                <Popover.Popup
                  role="listbox"
                  aria-label="Thinking levels"
                  className="bg-popover text-popover-foreground flex w-64 flex-col gap-1 rounded-xl border border-border p-2 shadow-lg outline-none"
                >
                  <Popover.Title className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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
                        className="h-auto justify-between px-2 py-1.5 text-start"
                        title={
                          supported
                            ? `Use ${label(level)}`
                            : level === "inherit"
                              ? "Configured only; not a live session level"
                              : "Not supported by the current model"
                        }
                        onClick={() => apply(level)}
                      >
                        <span>{label(level)}</span>
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
              Current: {label(snapshot.current)}
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
