import { ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { lastSeen } from "../lastSeen";
import type { ChatController } from "./controller";
import type { ChatModel } from "./store";

type ModelList =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly models: readonly ChatModel[] };

const isModel = (value: unknown): value is ChatModel =>
  typeof value === "object" &&
  value !== null &&
  ["provider", "id", "name"].every(
    (key) => typeof (value as Record<string, unknown>)[key] === "string",
  );

/** omp's models as the menu listed them last, also after a reload. */
const lastModels = lastSeen<readonly ChatModel[]>("models", (stored) =>
  Array.isArray(stored) && stored.every(isModel) ? stored : undefined,
);

const sameModel = (a: ChatModel | null, b: ChatModel): boolean =>
  a !== null && a.provider === b.provider && a.id === b.id;

/**
 * The chat's model as a chip; it opens omp's model list, searchable, grouped by provider. Its open state is the pane's,
 * so a failed request's "Switch model" opens it too. A model that is a role's other than `default` (Ctrl+P switches
 * between them) is shown with the role: "slow · Claude Opus".
 */
export function ModelPicker({
  controller,
  model,
  role,
  disabled,
  open,
  onOpenChange,
  onError,
}: {
  readonly controller: ChatController;
  readonly model: ChatModel | null;
  readonly role: string | null;
  readonly disabled: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onError: (failure: unknown) => void;
}): ReactNode {
  const [list, setList] = useState<ModelList>(() => {
    const kept = lastModels.get();
    return kept === undefined ? { kind: "loading" } : { kind: "ready", models: kept };
  });
  const named = model !== null && role !== null && role !== "default" ? role : null;

  // The list is read each time it opens: omp refreshes its models in the background. Until the read answers, the menu
  // shows the list it showed last; a read that fails leaves that list.
  useEffect(() => {
    if (!open) return;
    let active = true;
    controller
      .models()
      .then((models) => {
        lastModels.set(models);
        if (active) setList({ kind: "ready", models });
      })
      .catch((failure: unknown) => {
        if (active)
          setList((shown) =>
            shown.kind === "ready"
              ? shown
              : {
                  kind: "failed",
                  message: failure instanceof Error ? failure.message : String(failure),
                },
          );
      });
    return () => {
      active = false;
    };
  }, [open, controller]);

  const groups = new Map<string, ChatModel[]>();
  if (list.kind === "ready") {
    for (const item of list.models) {
      const group = groups.get(item.provider);
      if (group === undefined) groups.set(item.provider, [item]);
      else group.push(item);
    }
  }
  // The chat's own provider first; the rest in omp's order.
  const ordered = [...groups].sort(([a], [b]) =>
    a === model?.provider ? -1 : b === model?.provider ? 1 : 0,
  );

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            data-tour="model"
            type="button"
            variant="ghost"
            size="sm"
            // The chip gives way first on a narrow box, so Send stays in it.
            className="max-w-56 min-w-0 shrink gap-1 text-t2 hover:text-t1"
            aria-label={`Model: ${model?.name ?? "none"}${named === null ? "" : ` (${named})`}`}
            disabled={disabled}
          />
        }
      >
        <span className="truncate">
          {named === null ? "" : `${named} · `}
          {model?.name ?? "Choose a model"}
        </span>
        <ChevronDown />
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 p-0">
        <Command>
          <CommandInput placeholder="Find a model" />
          <CommandList>
            <CommandEmpty>
              {list.kind === "loading"
                ? "Loading models…"
                : list.kind === "failed"
                  ? `Could not list the models: ${list.message}`
                  : "No model matches."}
            </CommandEmpty>
            {ordered.map(([provider, models]) => (
              <CommandGroup key={provider} heading={provider}>
                {models.map((item) => (
                  <CommandItem
                    key={`${item.provider}/${item.id}`}
                    value={`${item.provider}/${item.id} ${item.name}`}
                    data-checked={sameModel(model, item)}
                    onSelect={() => {
                      onOpenChange(false);
                      void controller.setModel(item).catch(onError);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    <span className="max-w-36 shrink-0 truncate font-mono text-[11px] text-t3 group-data-selected/command-item:text-t2">
                      {item.id}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
