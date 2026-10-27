import type { AppClient } from "@omp-app/client";
import type {
  OmpWire,
  RpcSessionClient,
  RpcSessionNotification,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure, RpcSessionPort } from "@omp-app/contracts";
import type { SlashAppCommand } from "@/modules/D2/slash";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { type BtwPanelModel, type BtwTurn, btwModelOf } from "./model";

export interface BtwRpcSource {
  readonly send: RpcSessionClient["send"];
  readonly subscribe: (
    listener: (event: RpcSessionNotification, replayed?: boolean) => void,
  ) => () => void;
}

export interface BtwRpcControllerOptions {
  readonly threadId: ThreadId;
  readonly source: BtwRpcSource;
}

function turnOf(record: OmpWire.BtwHistoryRecord): BtwTurn {
  return {
    id: record.id,
    question: record.question,
    answer: record.answer,
    status: record.status,
    startedAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

function turnsOf(records: readonly OmpWire.BtwHistoryRecord[]): readonly BtwTurn[] {
  return [...records].reverse().flatMap((record) => [
    turnOf(record),
    ...(record.followUps ?? []).map((turn) => ({
      id: `${record.id}:${turn.updatedAt}`,
      question: turn.question,
      answer: turn.answer,
      status: turn.status,
      startedAt: turn.createdAt,
      updatedAt: turn.updatedAt,
      ...(turn.error === undefined ? {} : { error: turn.error }),
    })),
  ]);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/** Typed RPC state/controller for D6's side-question panel. */
export class BtwRpcController {
  private readonly threadId: ThreadId;
  private readonly source: BtwRpcSource;
  private readonly listeners = new Set<() => void>();
  private unsubscribeEvents: (() => void) | undefined;
  private snapshot: BtwPanelModel;
  private disposed = false;

  public constructor(options: BtwRpcControllerOptions) {
    this.threadId = options.threadId;
    this.source = options.source;
    this.snapshot = btwModelOf({ turns: [] });
  }

  public getSnapshot = (): BtwPanelModel => this.snapshot;

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public start(): void {
    if (this.disposed || this.unsubscribeEvents !== undefined) return;
    this.unsubscribeEvents = this.source.subscribe((event, replayed) =>
      this.onEvent(event, replayed),
    );
    void this.refresh();
  }

  public stop(): void {
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
  }

  public select(id: string): void {
    if (!this.snapshot.turns.some((turn) => turn.id === id)) return;
    this.snapshot = btwModelOf({
      turns: this.snapshot.turns,
      selectedId: id,
      copy: { state: "available" },
      cancel: { state: "available" },
    });
    this.publish();
  }
  public async refresh(): Promise<void> {
    if (this.disposed) return;
    try {
      const result = await this.source.send({
        threadId: this.threadId,
        command: { type: "get_btw_history" },
      });
      this.snapshot = btwModelOf({
        turns: turnsOf(result.records),
        copy: { state: "available" },
        cancel: { state: "available" },
      });
      this.publish();
    } catch (error) {
      const message = errorMessage(error, "Side-question history could not be loaded.");
      const unavailable = error instanceof AppFailure && error.appError.code === "unavailable";
      this.snapshot = btwModelOf({
        turns: this.snapshot.turns,
        ...(unavailable ? { unavailableReason: message } : {}),
        ...(unavailable ? {} : { error: { code: "internal", message, retryable: true } }),
        copy: { state: "available" },
        cancel: { state: "available" },
      });
      this.publish();
    }
  }

  public async ask(question: string, recordId?: string): Promise<void> {
    const selected =
      recordId === undefined ? undefined : this.snapshot.turns.find((turn) => turn.id === recordId);
    const running: BtwTurn = {
      id: recordId ?? `pending-${Date.now()}`,
      question,
      answer: selected?.answer ?? "",
      status: "running",
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.snapshot = btwModelOf({
      turns: [...this.snapshot.turns.filter((turn) => turn.id !== recordId), running],
      selectedId: running.id,
      copy: { state: "available" },
      cancel: { state: "available" },
    });
    this.publish();
    try {
      const result = await this.source.send({
        threadId: this.threadId,
        command: { type: "btw", question, ...(recordId === undefined ? {} : { recordId }) },
      });
      this.applyRecord(result.record);
    } catch (error) {
      this.snapshot = btwModelOf({
        turns: this.snapshot.turns.map((turn) =>
          turn.id === running.id
            ? { ...turn, status: "error", error: errorMessage(error, "The side question failed.") }
            : turn,
        ),
        selectedId: running.id,
        error: {
          code: "internal",
          message: errorMessage(error, "The side question failed."),
          retryable: true,
        },
        copy: { state: "available" },
        cancel: { state: "available" },
      });
      this.publish();
      throw error;
    }
  }

  public async cancel(recordId?: string): Promise<void> {
    const normalizedId =
      recordId === undefined || recordId.startsWith("pending-")
        ? undefined
        : recordId.split(":")[0];
    try {
      const result = await this.source.send({
        threadId: this.threadId,
        command: {
          type: "btw_cancel",
          ...(normalizedId === undefined ? {} : { recordId: normalizedId }),
        },
      });
      if (!result.cancelled) throw new Error("The side question could not be cancelled.");
      await this.refresh();
    } catch (error) {
      this.snapshot = btwModelOf({
        turns: this.snapshot.turns,
        selectedId: this.snapshot.selectedId ?? undefined,
        error: {
          code: "internal",
          message: errorMessage(error, "The side question could not be cancelled."),
          retryable: true,
        },
        copy: { state: "available" },
        cancel: { state: "available" },
      });
      this.publish();
      throw error;
    }
  }

  public dispose(): void {
    this.stop();
    this.disposed = true;
    this.listeners.clear();
  }

  private onEvent(event: RpcSessionNotification, replayed = false): void {
    if (replayed) return;
    if (event.type === "btw_record") {
      this.applyRecord(event.record);
      return;
    }
    if (event.type !== "btw_delta") return;
    const targetIndex = this.snapshot.turns.reduce(
      (latest, turn, index) =>
        turn.id === event.recordId || turn.id.startsWith(`${event.recordId}:`) ? index : latest,
      -1,
    );
    if (targetIndex < 0) return;
    const target = this.snapshot.turns[targetIndex];
    if (!target) return;
    this.snapshot = btwModelOf({
      turns: this.snapshot.turns.map((turn, index) =>
        index === targetIndex
          ? { ...turn, answer: `${turn.answer}${event.delta}`, status: "running" }
          : turn,
      ),
      selectedId: target.id,
      copy: { state: "available" },
      cancel: { state: "available" },
    });
    this.publish();
  }

  private applyRecord(record: OmpWire.BtwHistoryRecord): void {
    const next = turnsOf([record]);
    const ids = new Set(next.map((turn) => turn.id));
    const turns = this.snapshot.turns.filter(
      (turn) => !ids.has(turn.id) && !(turn.id.startsWith("pending-") && turn.status === "running"),
    );
    const selectedId = next.at(-1)?.id;
    this.snapshot = btwModelOf({
      turns: [...turns, ...next],
      ...(selectedId === undefined ? {} : { selectedId }),
      copy: { state: "available" },
      cancel: { state: "available" },
    });
    this.publish();
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export function createBtwRpcController(
  client: AppClient,
  threadId: ThreadId,
  runtime: Pick<OmpRuntimeStore, "subscribeNotifications">,
): BtwRpcController {
  const rpc = client.port(RpcSessionPort) as RpcSessionClient;
  return new BtwRpcController({
    threadId,
    source: {
      send: rpc.send,
      // Only omp's `btw_*` notifications are asked for, and those are RPC notifications.
      subscribe: (listener) =>
        runtime.subscribeNotifications(["btw_delta", "btw_record"], (frame, _seq, replayed) =>
          listener(frame as RpcSessionNotification, replayed),
        ),
    },
  });
}

export function btwSlashCommand(controller: Pick<BtwRpcController, "ask">): SlashAppCommand {
  return {
    name: "btw",
    description: "Ask a side question",
    takesArguments: true,
    run: async ({ args }) => {
      const question = args?.trim() ?? "";
      if (question.length === 0) {
        throw new AppFailure({
          code: "invalid_args",
          message: "Add a question after /btw.",
          retryable: false,
        });
      }
      await controller.ask(question);
      return { message: "Side question sent." };
    },
  };
}
