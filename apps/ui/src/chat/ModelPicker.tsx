import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
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
import type { ChatController } from "./controller";
import type { ChatModel } from "./store";

type ModelList =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly models: readonly ChatModel[] };

const sameModel = (a: ChatModel | null, b: ChatModel): boolean =>
  a !== null && a.provider === b.provider && a.id === b.id;

/** The chat's model as a chip; it opens omp's model list, searchable, grouped by provider. */
export function ModelPicker({
  controller,
  model,
  disabled,
  onError,
}: {
  readonly controller: ChatController;
  readonly model: ChatModel | null;
  readonly disabled: boolean;
  readonly onError: (failure: unknown) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ModelList>({ kind: "loading" });

  const onOpenChange = (next: boolean): void => {
    setOpen(next);
    if (!next) return;
    controller
      .models()
      .then((models) => setList({ kind: "ready", models }))
      .catch((failure: unknown) =>
        setList({
          kind: "failed",
          message: failure instanceof Error ? failure.message : String(failure),
        }),
      );
  };

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
            type="button"
            variant="ghost"
            size="sm"
            className="max-w-56 gap-1 text-t2 hover:text-t1"
            aria-label={`Model: ${model?.name ?? "none"}`}
            disabled={disabled}
          />
        }
      >
        <span className="truncate">{model?.name ?? "Choose a model"}</span>
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
                      setOpen(false);
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
