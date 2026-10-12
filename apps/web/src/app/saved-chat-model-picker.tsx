import type { AppClient } from "@omp-app/client";
import { AppFailure, AppPort, type ModelChoice, type UsableModel } from "@omp-app/contracts";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import type { OverlayHostApi } from "@/overlay";

/**
 * Opens the picker for a chat whose saved model omp could not restore. It lists the models omp can use now, from
 * the server (no omp runs for the chat yet). Typing narrows the list; the model picked is the one the chat opens with.
 * `lead` is the picker's first line: the sentence when the picker opens over an open chat (the empty screen shows the
 * sentence itself, and its picker opens with a line about picking).
 */
export function openSavedChatModelPicker({
  overlay,
  client,
  lead,
  onPick,
}: {
  readonly overlay: OverlayHostApi;
  readonly client: AppClient;
  readonly lead: string;
  readonly onPick: (model: ModelChoice) => void;
}): void {
  overlay.open({
    kind: "modal",
    label: "Pick a model",
    className:
      "h-[min(calc(100dvh-1rem),36rem)] w-[min(calc(100vw-1rem),32rem)] max-h-none max-w-none grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]",
    content: ({ close }) => (
      <div className="flex min-h-0 min-w-0 flex-col gap-3">
        <p className="text-muted-foreground text-sm">{lead}</p>
        <SavedChatModelList
          client={client}
          onPick={(model) => {
            close();
            onPick(model);
          }}
        />
      </div>
    ),
  });
}

type ModelsState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly models: readonly UsableModel[] }
  | { readonly status: "failed"; readonly message: string };

function failureText(error: unknown): string {
  return error instanceof AppFailure
    ? error.appError.message
    : "The models could not be listed. Try again.";
}

/** Whether a model's name or `provider/modelId` contains what was typed, ignoring case. */
function matches(model: UsableModel, query: string): boolean {
  const text = `${model.name} ${model.provider}/${model.modelId}`.toLowerCase();
  return text.includes(query.trim().toLowerCase());
}

function SavedChatModelList({
  client,
  onPick,
}: {
  readonly client: AppClient;
  readonly onPick: (model: ModelChoice) => void;
}) {
  const [state, setState] = useState<ModelsState>({ status: "loading" });
  const [query, setQuery] = useState("");
  useEffect(() => {
    let current = true;
    client
      .port(AppPort)
      .usableModels({})
      .then(
        (result) => {
          if (current) setState({ status: "ready", models: result.models });
        },
        (error: unknown) => {
          if (current) setState({ status: "failed", message: failureText(error) });
        },
      );
    return () => {
      current = false;
    };
  }, [client]);

  if (state.status === "loading") return <p className="text-sm">Loading the models…</p>;
  if (state.status === "failed") {
    return (
      <p className="text-destructive text-sm" role="alert">
        {state.message}
      </p>
    );
  }
  if (state.models.length === 0) {
    return (
      <p className="text-sm">
        omp has no model set up. Set an API key environment variable, or sign in to a provider: run{" "}
        <code>omp</code> in a terminal and use <code>/login</code>.
      </p>
    );
  }
  const shown = state.models.filter((model) => matches(model, query));
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <Input
        aria-label="Filter models"
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter models"
        type="search"
        value={query}
      />
      {shown.length === 0 ? (
        <p className="text-sm">No model matches “{query.trim()}”.</p>
      ) : (
        <ul aria-label="Models" className="flex min-h-0 flex-col gap-2 overflow-y-auto">
          {shown.map((model) => (
            <li key={`${model.provider}/${model.modelId}`}>
              <button
                className="hover:bg-muted flex w-full flex-col rounded-md border px-3 py-2 text-left"
                onClick={() => onPick({ provider: model.provider, modelId: model.modelId })}
                type="button"
              >
                <span className="text-sm font-medium">{model.name}</span>
                <span className="text-muted-foreground text-xs">
                  {model.provider}/{model.modelId}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
