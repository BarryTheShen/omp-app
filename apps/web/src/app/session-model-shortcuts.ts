import type { AppClient } from "@omp-app/client";
import type { CapabilityMap, ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { useEffect, useRef } from "react";
import {
  createR0LiveModelState,
  createRpcModelCatalogSource,
  ModelCatalogModel,
} from "@/modules/D1/model";
import { registerD1ShortcutActions } from "@/modules/D1/shortcuts";
import { createRpcThinkingSource, ThinkingLevelsController } from "@/modules/D1/thinking";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { useShortcutRegistry } from "@/shortcuts";
import type { ShortcutRegistry } from "@/shortcuts/registry";
import { composerInput } from "./composer-input";
import { liveThinking, refreshSessionState } from "./session-controls";

export interface SessionModelShortcutOptions {
  readonly client: AppClient;
  readonly store: OmpRuntimeStore;
  readonly threadId: ThreadId;
  readonly capabilities: CapabilityMap;
  /** Opens the chat's model and thinking dialog, the one the header's model button opens. */
  readonly openDialog: (restoreFocus?: HTMLElement) => void;
  /** Shows a failed change in the composer's status line. */
  readonly fail: (message: string) => void;
}

function failureText(error: unknown, fallback: string): string {
  if (error instanceof AppFailure) return error.appError.message;
  return error instanceof Error ? error.message : fallback;
}

/**
 * Registers D1's model and thinking chords for the open chat, reading the chat as it is when a key is pressed.
 * Each chord changes omp's state through the RPC the header and the dialog already use. The returned function
 * removes the chords.
 */
export function registerSessionModelShortcuts(
  registry: ShortcutRegistry,
  current: () => SessionModelShortcutOptions,
): () => void {
  // Both model chords open the chat's dialog: its model picks apply to this chat, and roles are saved apart.
  const openModelDialog = () => {
    const { openDialog } = current();
    openDialog(composerInput() ?? undefined);
  };
  return registerD1ShortcutActions(registry, {
    cycleModelForward: async () => {
      const options = current();
      const catalog = new ModelCatalogModel({
        source: createRpcModelCatalogSource(options.client, options.threadId),
        capabilities: options.capabilities,
        liveState: createR0LiveModelState({
          getSnapshot: () => ({ model: options.store.getSnapshot().session.model }),
          subscribe: (listener) => options.store.subscribe(() => listener()),
        }),
      });
      try {
        await catalog.cycle();
      } catch (error: unknown) {
        options.fail(failureText(error, "The model could not be changed. Try again."));
        return;
      } finally {
        catalog.dispose();
      }
      refreshSessionState(options.client, options.store, options.threadId);
    },
    selectModel: openModelDialog,
    selectTemporaryModel: openModelDialog,
    cycleThinking: async () => {
      const options = current();
      const thinking = new ThinkingLevelsController({
        source: createRpcThinkingSource(options.client, options.threadId),
        capabilities: options.capabilities,
        live: liveThinking(options.store),
      });
      try {
        await thinking.refresh();
        await thinking.cycle("forward");
      } catch (error: unknown) {
        options.fail(failureText(error, "The thinking level could not be changed. Try again."));
        return;
      } finally {
        thinking.dispose();
      }
      refreshSessionState(options.client, options.store, options.threadId);
    },
  });
}

/** Keeps the open chat's model and thinking chords registered for as long as the chat is open. */
export function useSessionModelShortcuts(options: SessionModelShortcutOptions): void {
  const registry = useShortcutRegistry();
  // The chords read the chat as it is when a key is pressed, so the registration is made once per registry.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  useEffect(() => registerSessionModelShortcuts(registry, () => latest.current), [registry]);
}
