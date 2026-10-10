import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { signInLabel } from "@/modules/D3/auth/sign-in";
import { useCapabilityStatus } from "@/registry-core";
import {
  MODEL_SCOPE_AP6_CAPABILITY,
  MODEL_SCOPE_AP6_REASON,
  type ModelDescriptor,
  type ModelScope,
  modelScopeAvailability,
} from "../contract";
import { filterModels, type ModelCatalogModel, modelKey, modelRefFromDescriptor } from "./catalog";
import { groupByProvider, orderBySignIn } from "./sign-in-order";

export interface ModelPickerProps {
  readonly catalog: ModelCatalogModel;
  readonly scope: Extract<ModelScope, "reply" | "session">;
  readonly title?: string;
  readonly onApplied?: (model: ModelDescriptor) => void;
  readonly onProviderLogin?: (provider: string) => void;
  /**
   * The list takes whatever height its container gives it. Without it the list stops at 18rem,
   * which suits a picker inside a page but wastes a tall dialog.
   */
  readonly fill?: boolean;
}

function useCatalogSnapshot(catalog: ModelCatalogModel) {
  const subscribe = useCallback(
    (listener: Parameters<ModelCatalogModel["subscribe"]>[0]) => catalog.subscribe(listener),
    [catalog],
  );
  const getSnapshot = useCallback(() => catalog.getSnapshot(), [catalog]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function modelDescription(model: ModelDescriptor): string {
  const context = model.contextWindow
    ? `${Math.round(model.contextWindow / 1_000)}k context`
    : "context unknown";
  const reasoning = model.reasoning ? "reasoning" : "general";
  return `${model.provider} · ${reasoning} · ${context}`;
}

function ModelRow({
  model,
  current,
  active,
  onSelect,
  onProviderLogin,
}: {
  readonly model: ModelDescriptor;
  readonly current: boolean;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly onProviderLogin?: (provider: string) => void;
}) {
  if (model.availability === "locked") {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{model.provider}</div>
          <div className="text-xs text-muted-foreground">Login required to show models</div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onProviderLogin?.(model.loginProvider ?? model.provider)}
          disabled={!onProviderLogin}
        >
          {onProviderLogin ? "Log in" : "Locked"}
        </Button>
      </div>
    );
  }
  return (
    <Button
      type="button"
      role="option"
      aria-selected={current}
      variant={active ? "secondary" : "ghost"}
      className="h-auto w-full justify-start px-3 py-2 text-start"
      onClick={onSelect}
      disabled={model.availability === "unavailable"}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{model.name}</span>
          {model.signIn === undefined ? null : (
            <span className="text-muted-foreground shrink-0 rounded-full border border-border/70 px-1.5 py-0.5 text-[0.7rem]">
              {signInLabel(model.signIn)}
            </span>
          )}
          {current ? (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[0.7rem] text-primary">
              Current
            </span>
          ) : null}
        </span>
        <span className="truncate text-xs font-normal text-muted-foreground">
          {modelKey(modelRefFromDescriptor(model))} · {modelDescription(model)}
        </span>
      </span>
    </Button>
  );
}

export function ModelPicker({
  catalog,
  scope,
  title = scope === "reply" ? "This reply" : "This session",
  onApplied,
  onProviderLogin,
  fill = false,
}: ModelPickerProps) {
  const snapshot = useCatalogSnapshot(catalog);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const ap6Status = useCapabilityStatus(MODEL_SCOPE_AP6_CAPABILITY);
  const availability =
    scope === "reply"
      ? ap6Status?.state === "available" || ap6Status?.state === "fallback"
        ? { state: "available" as const, scope, capability: MODEL_SCOPE_AP6_CAPABILITY }
        : {
            state: "unavailable" as const,
            scope,
            capability: MODEL_SCOPE_AP6_CAPABILITY,
            reason:
              ap6Status?.via === "upstream"
                ? MODEL_SCOPE_AP6_REASON
                : (ap6Status?.detail ?? MODEL_SCOPE_AP6_REASON),
          }
      : modelScopeAvailability(scope, snapshot.capabilities);
  const visibleModels = useMemo(
    () =>
      orderBySignIn(
        filterModels(
          snapshot.models.filter((model) => model.availability !== "unavailable"),
          query,
        ),
      ),
    [query, snapshot.models],
  );
  const available = availability.state === "available";

  const apply = async (model: ModelDescriptor) => {
    setError(null);
    setApplying(true);
    try {
      await catalog.apply({ model: modelRefFromDescriptor(model), scope });
      onApplied?.(model);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "The model could not be applied.");
    } finally {
      setApplying(false);
    }
  };

  const move = (direction: -1 | 1) => {
    if (visibleModels.length === 0) return;
    setActiveIndex((index) => (index + direction + visibleModels.length) % visibleModels.length);
  };

  if (scope === "reply" && !available) {
    return (
      <section
        aria-label={`${title} model picker`}
        className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/70 p-3"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{title}</h2>
            <p className="text-xs text-muted-foreground">
              This choice is unavailable in the current omp.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled
            aria-describedby="d1-model-reply-unavailable-reason"
            title={availability.reason}
          >
            {title}: not available
          </Button>
        </div>
        <p
          id="d1-model-reply-unavailable-reason"
          role="status"
          className="text-xs text-muted-foreground"
        >
          {availability.reason}
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label={`${title} model picker`}
      className={cn("flex min-w-0 flex-col gap-3", fill && "min-h-0 flex-1")}
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground">
            {scope === "reply"
              ? "Changes only this reply"
              : "Changes future prompts in this session"}
          </p>
        </div>
      </header>
      {!available ? (
        <div
          role="status"
          className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
        >
          <div className="font-medium text-foreground">{title} unavailable</div>
          <div>{availability.reason}</div>
        </div>
      ) : null}
      <Input
        aria-label={`Search ${title.toLocaleLowerCase()}`}
        placeholder="Search models or providers"
        value={query}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          setActiveIndex(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            move(1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            move(-1);
          } else if (event.key === "Enter") {
            event.preventDefault();
            const selected = visibleModels[activeIndex];
            if (available && selected) void apply(selected);
          }
        }}
        disabled={!available || snapshot.loadState === "loading" || applying}
      />
      <div
        role="listbox"
        aria-label={`${title} models`}
        className={cn(
          "flex min-h-16 flex-col gap-1 overflow-y-auto rounded-lg border border-border/70 p-1",
          fill ? "flex-1" : "max-h-72",
        )}
      >
        {snapshot.loadState === "loading" ? (
          <p role="status" className="px-3 py-4 text-sm text-muted-foreground">
            Loading models…
          </p>
        ) : snapshot.loadState === "error" ? (
          <p role="alert" className="px-3 py-4 text-sm text-destructive">
            {snapshot.error?.message ?? "Model discovery failed."}
          </p>
        ) : visibleModels.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">No matching models.</p>
        ) : (
          groupByProvider(visibleModels).map((group) => (
            <fieldset className="flex min-w-0 flex-col gap-1" key={group.provider}>
              <legend className="sr-only">{group.provider}</legend>
              {group.models.map((model) => (
                <ModelRow
                  key={modelKey(modelRefFromDescriptor(model))}
                  model={model}
                  current={
                    snapshot.current?.provider === model.provider &&
                    snapshot.current.modelId === model.id
                  }
                  active={visibleModels.indexOf(model) === activeIndex}
                  onSelect={() => void apply(model)}
                  onProviderLogin={onProviderLogin}
                />
              ))}
            </fieldset>
          ))
        )}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {snapshot.current ? (
        <p className="text-xs text-muted-foreground">Active: {modelKey(snapshot.current)}</p>
      ) : null}
    </section>
  );
}
