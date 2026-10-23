import type { AppClient } from "@omp-app/client";
import type { CapabilityMap, FolderPath, ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { useEffect, useRef } from "react";
import { readRoleCycleSettings } from "@/modules/D1/hub";
import {
  createR0LiveModelState,
  createRpcModelCatalogSource,
  cycleRoleModel,
  ModelCatalogModel,
  type RoleCycleDirection,
} from "@/modules/D1/model";
import { registerD1ShortcutActions } from "@/modules/D1/shortcuts";
import { createRpcThinkingSource, ThinkingLevelsController } from "@/modules/D1/thinking";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { useShortcutRegistry } from "@/shortcuts";
import type { ShortcutRegistry } from "@/shortcuts/registry";
import { composerInput } from "./composer-input";
import { liveThinking, readSessionState, refreshSessionState } from "./session-controls";

export interface SessionModelShortcutOptions {
  readonly client: AppClient;
  readonly store: OmpRuntimeStore;
  readonly threadId: ThreadId;
  /** The workspace folder the chat runs in: its project's roles are the ones a role step moves through. */
  readonly folder: FolderPath | null;
  readonly capabilities: CapabilityMap;
  /** Opens the chat's model and thinking dialog, the one the header's model button opens. */
  readonly openDialog: (restoreFocus?: HTMLElement) => void;
  /** Says why a key did nothing, in plain English: the composer's status line. */
  readonly notify: (message: string) => void;
  /** Shows a failed change in the composer's error line. */
  readonly fail: (message: string) => void;
}

function failureText(error: unknown, fallback: string): string {
  if (error instanceof AppFailure) return error.appError.message;
  return error instanceof Error ? error.message : fallback;
}

/**
 * One step through the chat's role models (omp's cycleRoleModel), over the chat's own catalog, roles and thinking
 * state. A step with fewer than two role models says so; a failed one is named in the error line. Returns the role the
 * step applied, or null when it applied none.
 */
async function stepRoleModel(
  options: SessionModelShortcutOptions,
  direction: RoleCycleDirection,
  lastRole: string | null,
): Promise<string | null> {
  const catalog = new ModelCatalogModel({
    source: createRpcModelCatalogSource(options.client, options.threadId),
    capabilities: options.capabilities,
    liveState: createR0LiveModelState({
      getSnapshot: () => ({ model: options.store.getSnapshot().session.model }),
      subscribe: (listener) => options.store.subscribe(() => listener()),
    }),
  });
  const thinking = new ThinkingLevelsController({
    source: createRpcThinkingSource(options.client, options.threadId),
    capabilities: options.capabilities,
    live: liveThinking(options.store),
  });
  try {
    const outcome = await cycleRoleModel(
      {
        catalog,
        readSettings: () => readRoleCycleSettings(options.client, options.folder),
        readSession: () => readSessionState(options.client, options.store, options.threadId),
        setThinkingLevel: async (level) => {
          await thinking.refresh();
          await thinking.apply({ level, scope: "session" });
        },
        lastRole,
      },
      direction,
    );
    if (outcome.kind === "single") {
      options.notify("Only one role model available");
      return null;
    }
    if (outcome.thinkingError !== null) options.fail(outcome.thinkingError);
    return outcome.role;
  } catch (error: unknown) {
    options.fail(failureText(error, "The model could not be changed. Try again."));
    return null;
  } finally {
    catalog.dispose();
    thinking.dispose();
  }
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
  // A press waits for the one before it: each step starts from the model the step before it set.
  let previousStep: Promise<void> = Promise.resolve();
  // The role each chat's last step applied, as omp records it (model-controls.ts:369-382 at v18.12.5).
  const lastRoles = new Map<ThreadId, string>();
  const roleStep = (direction: RoleCycleDirection) => () => {
    // A step that somehow rejects must not stop the presses after it, so the queue runs on either way.
    const step = async () => {
      const options = current();
      const role = await stepRoleModel(options, direction, lastRoles.get(options.threadId) ?? null);
      if (role !== null) lastRoles.set(options.threadId, role);
    };
    previousStep = previousStep.then(step, step);
    return previousStep;
  };
  return registerD1ShortcutActions(registry, {
    cycleModelForward: roleStep("forward"),
    cycleModelBackward: roleStep("backward"),
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
