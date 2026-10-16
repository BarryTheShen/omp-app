import type { AppClient } from "@omp-app/client";
import { AppFailure, type CapabilityMap, type ThreadId } from "@omp-app/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { openDestructiveCommandConfirm } from "@/modules/U4/dialogs/confirm-destructive-command";
import type { OverlayHostApi } from "@/overlay";
import { useStableOverlayHost } from "@/overlay";
import type { D74Command, D74CommandClient, D74CommandSurface } from "./commands";
import { idleCommandSurface, runD74Command, unknownAfterReconnect } from "./commands";

const COMMAND_CAPABILITY = "host.command-gateway";
const CONNECTING_MESSAGE = "The app is connecting to omp. Commands are paused.";
const RECONNECTING_MESSAGE = "The app is reconnecting. Commands are paused.";
const CLOSED_MESSAGE = "The app connection is closed. Reopen it before running commands.";
const CAPABILITY_MESSAGE = "Commands are not available in this chat.";

export interface UseD74CommandOptions {
  readonly client: AppClient;
  readonly commandClient: D74CommandClient;
  readonly threadId: ThreadId;
  readonly capabilities: CapabilityMap;
}

export interface D74CommandActions {
  readonly run: (command: D74Command) => void;
  readonly retry: () => void;
}

export interface D74CommandController {
  readonly surface: D74CommandSurface;
  readonly actions: D74CommandActions;
  readonly canRun: boolean;
}

function hasCommandCapability(capabilities: CapabilityMap): boolean {
  const state = capabilities[COMMAND_CAPABILITY]?.state;
  return state === "available" || state === "fallback";
}

function unavailableSurface(message: string): D74CommandSurface {
  return { state: "unavailable", message };
}

type ShakeCommand = Extract<D74Command, `/shake ${string}`>;

function isShake(command: D74Command): command is ShakeCommand {
  return command.startsWith("/shake ");
}

function shakeDescription(command: ShakeCommand): string {
  switch (command) {
    case "/shake elide":
      return "tool results and large blocks";
    case "/shake images":
      return "images";
    case "/shake thinking":
      return "thinking";
  }
}

function confirmShake(
  overlay: OverlayHostApi,
  signal: AbortSignal,
  command: ShakeCommand,
): Promise<boolean> {
  let overlayId: string | undefined;
  const confirmation = openDestructiveCommandConfirm(
    {
      open: (options) => {
        const opened = overlay.open(options);
        overlayId = opened.id;
        return opened;
      },
    },
    {
      label: "Remove context",
      title: "Remove content from this chat?",
      description: `omp will remove ${shakeDescription(command)} from the context it can use.`,
      confirmLabel: "Remove content",
    },
  );
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(confirmed);
    };
    const onAbort = (): void => {
      if (overlayId !== undefined) overlay.close(overlayId);
      finish(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void confirmation.then(finish, () => finish(false));
    if (signal.aborted) onAbort();
  });
}

function requestFailure(error: unknown): D74CommandSurface {
  return {
    state: "error",
    message:
      error instanceof AppFailure
        ? error.appError.message
        : "The app could not reach omp. Try again.",
  };
}

export function useD74Command({
  client,
  commandClient,
  threadId,
  capabilities,
}: UseD74CommandOptions): D74CommandController {
  const overlay = useStableOverlayHost();
  const [surface, setSurface] = useState<D74CommandSurface>(() => idleCommandSurface());
  const [connectionState, setConnectionState] = useState(client.connectionState);
  const activeRun = useRef<{ readonly id: number; readonly abort: AbortController } | null>(null);
  const runId = useRef(0);
  const lastCommand = useRef<D74Command | undefined>(undefined);
  const capabilitiesRef = useRef(capabilities);
  const clientRef = useRef(client);
  const commandClientRef = useRef(commandClient);
  const threadIdRef = useRef(threadId);
  capabilitiesRef.current = capabilities;
  clientRef.current = client;
  commandClientRef.current = commandClient;
  threadIdRef.current = threadId;

  useEffect(() => {
    let wasConnected = client.connectionState === "open";
    let reconnectPending = client.connectionState === "reconnecting";
    setConnectionState(client.connectionState);
    activeRun.current?.abort.abort();
    activeRun.current = null;
    runId.current += 1;
    lastCommand.current = undefined;
    setSurface(idleCommandSurface());
    const unsubscribe = client.onConnectionState(({ state }) => {
      setConnectionState(state);
      if (state === "reconnecting" || state === "closed") {
        if (wasConnected) reconnectPending = true;
        activeRun.current?.abort.abort();
        activeRun.current = null;
        runId.current += 1;
        setSurface(
          unavailableSurface(state === "reconnecting" ? RECONNECTING_MESSAGE : CLOSED_MESSAGE),
        );
      } else if (state === "open") {
        if (reconnectPending) {
          setSurface(
            lastCommand.current ? unknownAfterReconnect(lastCommand.current) : idleCommandSurface(),
          );
        } else {
          setSurface((current) =>
            current.state === "unavailable" ? idleCommandSurface() : current,
          );
        }
        wasConnected = true;
        reconnectPending = false;
      }
    });
    return () => {
      unsubscribe();
      activeRun.current?.abort.abort();
      activeRun.current = null;
      runId.current += 1;
    };
  }, [client]);

  useEffect(() => {
    threadIdRef.current = threadId;
    activeRun.current?.abort.abort();
    activeRun.current = null;
    runId.current += 1;
    lastCommand.current = undefined;
    setSurface(idleCommandSurface());
    return () => {
      activeRun.current?.abort.abort();
      activeRun.current = null;
      runId.current += 1;
    };
  }, [threadId]);

  const capabilityAvailable = hasCommandCapability(capabilities);
  useEffect(() => {
    activeRun.current?.abort.abort();
    activeRun.current = null;
    runId.current += 1;
    setSurface(capabilityAvailable ? idleCommandSurface() : unavailableSurface(CAPABILITY_MESSAGE));
  }, [capabilityAvailable]);

  const run = useCallback(
    (command: D74Command) => {
      if (
        activeRun.current !== null ||
        !hasCommandCapability(capabilitiesRef.current) ||
        clientRef.current.connectionState !== "open"
      ) {
        return;
      }
      const id = ++runId.current;
      const abort = new AbortController();
      activeRun.current = { id, abort };
      setSurface({ state: isShake(command) ? "confirming" : "requested", command });
      void (async () => {
        try {
          if (isShake(command)) {
            const confirmed = await confirmShake(overlay, abort.signal, command);
            if (!confirmed) {
              if (activeRun.current?.id === id) {
                activeRun.current = null;
                setSurface(idleCommandSurface());
              }
              return;
            }
          }
          if (abort.signal.aborted || id !== runId.current) return;
          lastCommand.current = command;
          setSurface({ state: "requested", command });
          const result = await runD74Command(
            commandClientRef.current,
            threadIdRef.current,
            command,
            { signal: abort.signal },
          );
          if (!abort.signal.aborted && id === runId.current) setSurface(result);
        } catch (error) {
          if (!abort.signal.aborted && id === runId.current) setSurface(requestFailure(error));
        } finally {
          if (activeRun.current?.id === id) activeRun.current = null;
        }
      })();
    },
    [overlay],
  );

  const retry = useCallback(() => {
    const command = lastCommand.current;
    if (command !== undefined) run(command);
  }, [run]);

  let displayedSurface = surface;
  if (!capabilityAvailable) displayedSurface = unavailableSurface(CAPABILITY_MESSAGE);
  else if (connectionState === "connecting")
    displayedSurface = unavailableSurface(CONNECTING_MESSAGE);
  else if (connectionState === "reconnecting")
    displayedSurface = unavailableSurface(RECONNECTING_MESSAGE);
  else if (connectionState === "closed") displayedSurface = unavailableSurface(CLOSED_MESSAGE);
  const canRun =
    capabilityAvailable &&
    connectionState === "open" &&
    surface.state !== "requested" &&
    surface.state !== "confirming";
  return { surface: displayedSurface, actions: { run, retry }, canRun };
}
