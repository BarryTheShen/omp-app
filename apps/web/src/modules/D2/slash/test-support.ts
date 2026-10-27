import type { AppClient } from "@omp-app/client";
import {
  type ChatSessionEvent,
  ChatSessionPort,
  type CommandRunResult,
  OmpCommandGateway,
} from "@omp-app/contracts";
import realOutputs from "./fixtures/real-command-outputs.json";
import realCatalog from "./fixtures/real-get-available-commands.json";

/** omp's own `get_available_commands` list, captured from the real omp this repo's e2e runs (omp 18.8.3). */
export const REAL_COMMAND_LIST: readonly unknown[] = realCatalog.commands;

/** The text real omp printed for local builtins (`/usage`, `/context`), captured through RPC. */
export const REAL_COMMAND_OUTPUTS = realOutputs;

export interface FakeSlashClient {
  readonly client: AppClient;
  /** The chat host methods the catalog asked, in order. */
  readonly sent: string[];
  /** The commands the gateway was asked to run, in order. */
  readonly runs: string[];
  /** How many times the live event subscription was released. */
  readonly unsubscribed: () => number;
  /** Pushes one of the chat host's events to the live event stream. */
  readonly emitEvent: (event: unknown) => void;
}

export interface FakeSlashClientOptions {
  /** The reply to `get_available_commands`. Defaults to omp's real captured list. */
  readonly commands?: () => Promise<unknown>;
  /** The gateway's reply to a command. Defaults to a completed command with no agent turn. */
  readonly run?: (command: string) => Promise<CommandRunResult>;
}

export function fakeSlashClient(options: FakeSlashClientOptions = {}): FakeSlashClient {
  const sent: string[] = [];
  const runs: string[] = [];
  const listeners = new Set<(payload: ChatSessionEvent) => void>();
  let released = 0;
  const session = {
    request: async (args: { readonly method: string }) => {
      sent.push(args.method);
      if (args.method !== "get_available_commands") throw new Error("unexpected request");
      return options.commands ? await options.commands() : { commands: REAL_COMMAND_LIST };
    },
  };
  const gateway = {
    run: async (args: { readonly command: string }) => {
      runs.push(args.command);
      return options.run ? await options.run(args.command) : completedRun(args.command);
    },
  };
  const client = {
    port: (port: unknown) => {
      if (port === ChatSessionPort) return session;
      if (port === OmpCommandGateway) return gateway;
      throw new Error("the slash tests use only the chat session and the command gateway");
    },
    subscribe: async () => ({
      stream: "A0.chatSession.event",
      lastSeq: 0,
      onEvent(listener: (payload: ChatSessionEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      unsubscribe: async () => {
        released += 1;
      },
    }),
    onConnectionState: () => () => undefined,
    onResync: () => () => undefined,
  } as unknown as AppClient;
  return {
    client,
    sent,
    runs,
    unsubscribed: () => released,
    emitEvent: (event) => {
      for (const listener of [...listeners]) listener({ kind: "event", event } as ChatSessionEvent);
    },
  };
}

/** A command that finished without starting an agent turn, with one line of output. */
export function completedRun(command: string, text = "Done."): CommandRunResult {
  return {
    command,
    status: "completed",
    agentInvoked: false,
    promptSettled: true,
    sessionSettled: true,
    outputs: [{ text }],
    sessionUpdates: [],
    configUpdates: [],
  };
}
