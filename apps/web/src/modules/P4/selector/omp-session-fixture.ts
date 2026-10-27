import type { ChatSessionRequest } from "@omp-app/contracts";
import { ThreadId } from "@omp-app/contracts";
import type { TreeSnapshot } from "../contract";
import { OmpSessionTreePort } from "../history";

/**
 * One session entry as omp writes it to its session file (session/session-entries.ts), with the
 * fields the app reads. Built with {@link OmpSessionBuilder}, which follows omp's session manager.
 */
export type OmpSessionEntry = Record<string, unknown> & {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
};

/** One `get_tree` node: the entry, its children, and the label string on that entry (getTree). */
export type OmpTreeNode = {
  readonly entry: OmpSessionEntry;
  readonly children: OmpTreeNode[];
  readonly label?: string;
};

export interface OmpSessionFixture {
  readonly threadId: ThreadId;
  /** Every entry in append order, as `get_entries` returns them. */
  readonly entries: readonly OmpSessionEntry[];
  /** The `get_tree` roots. */
  readonly tree: OmpTreeNode[];
  readonly leafId: string | null;
}

interface ToolCall {
  readonly entryId: string;
  readonly callId: string;
  readonly name: string;
}

const FIXTURE_START_MS = Date.UTC(2026, 9, 6, 7, 0, 0);

/** Appends entries the way omp's session manager does: each entry is a child of the leaf, and becomes the leaf. */
export class OmpSessionBuilder {
  private readonly threadId: ThreadId;
  private readonly entries: OmpSessionEntry[] = [];
  private leaf: string | null = null;
  private tick = 0;

  public constructor(threadId = ThreadId.parse("p4-fixture-thread")) {
    this.threadId = threadId;
  }

  /** Moves the leaf back to an earlier entry, as omp's branch navigation does: the next entry is its child. */
  public branchFrom(entryId: string): void {
    if (!this.entries.some((entry) => entry.id === entryId)) {
      throw new Error(`The fixture has no entry ${entryId}.`);
    }
    this.leaf = entryId;
  }

  /** The session's first entries, as omp writes them: the model, then the thinking level. */
  public modelChange(model: string): string {
    return this.append("model_change", { model });
  }

  public thinkingLevelChange(thinkingLevel: string): string {
    return this.append("thinking_level_change", { thinkingLevel, configured: "auto" });
  }

  public titleChange(title: string): string {
    return this.append("title_change", { title, source: "auto" });
  }

  public user(text: string): string {
    return this.message({ role: "user", content: text, timestamp: this.millis() });
  }

  public assistant(text: string): string {
    return this.message({
      role: "assistant",
      content: [{ type: "text", text }],
      ...this.assistantFields("stop"),
    });
  }

  /** An assistant turn that only calls a tool. omp's default view hides it. */
  public toolCall(name: string, args: Record<string, unknown>): ToolCall {
    const callId = `call_${(this.entries.length + 1).toString(16).padStart(8, "0")}`;
    const entryId = this.message({
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name, arguments: args }],
      ...this.assistantFields("toolUse"),
    });
    return { entryId, callId, name };
  }

  public toolResult(call: ToolCall, text: string, isError = false): string {
    return this.message({
      role: "toolResult",
      toolCallId: call.callId,
      toolName: call.name,
      content: [{ type: "text", text }],
      details: {},
      isError,
      timestamp: this.millis(),
    });
  }

  /** An assistant turn that failed before writing any text (omp keeps it: its stopReason is not "stop"). */
  public failedTurn(errorMessage: string): string {
    return this.message({
      role: "assistant",
      content: [],
      ...this.assistantFields("error"),
      errorMessage,
    });
  }

  /** omp's label entry (appendLabelChange). An undefined label removes the label from its target. */
  public label(targetId: string, label: string | undefined): string {
    return this.append("label", { targetId, ...(label === undefined ? {} : { label }) });
  }

  public build(): OmpSessionFixture {
    const labels = new Map<string, string>();
    for (const entry of this.entries) {
      if (entry.type !== "label") continue;
      const targetId = String(entry.targetId);
      if (typeof entry.label === "string" && entry.label.length > 0) {
        labels.set(targetId, entry.label);
      } else {
        labels.delete(targetId);
      }
    }
    const byId = new Map<
      string,
      { entry: OmpSessionEntry; children: OmpTreeNode[]; label?: string }
    >();
    for (const entry of this.entries) {
      const label = labels.get(entry.id);
      byId.set(entry.id, { entry, children: [], ...(label === undefined ? {} : { label }) });
    }
    const roots: OmpTreeNode[] = [];
    for (const entry of this.entries) {
      const node = byId.get(entry.id);
      if (!node) continue;
      if (entry.parentId === null) roots.push(node);
      else byId.get(entry.parentId)?.children.push(node);
    }
    return { threadId: this.threadId, entries: [...this.entries], tree: roots, leafId: this.leaf };
  }

  private millis(): number {
    return FIXTURE_START_MS + this.tick * 1000;
  }

  private message(message: Record<string, unknown>): string {
    return this.append("message", { message });
  }

  private assistantFields(stopReason: string): Record<string, unknown> {
    return {
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
      stopReason,
      usage: { input: 1200, output: 180, cacheRead: 0, cacheWrite: 0, totalTokens: 1380 },
      timestamp: this.millis(),
    };
  }

  private append(type: string, fields: Record<string, unknown>): string {
    this.tick += 1;
    const id = (this.entries.length + 1).toString(16).padStart(8, "0");
    this.entries.push({
      type,
      id,
      parentId: this.leaf,
      timestamp: new Date(this.millis()).toISOString(),
      ...fields,
    });
    this.leaf = id;
    return id;
  }
}

/** Reads a fixture through the app's own omp adapter, so omp's string labels are normalized as in the app. */
export async function fixtureSnapshot(fixture: OmpSessionFixture): Promise<TreeSnapshot> {
  const send = (async (args: { readonly method: string }) => {
    if (args.method !== "get_tree") {
      throw new Error(`The fixture answers get_tree only, not ${args.method}.`);
    }
    return { tree: fixture.tree, leafId: fixture.leafId };
  }) as unknown as ChatSessionRequest;
  return new OmpSessionTreePort({ send }).readTree(fixture.threadId);
}

/** A 26-line answer, the kind omp writes for a pasted trace or a long explanation. */
function longAnswer(): string {
  const lines = ["Here is the check, one step per line:"];
  for (let step = 1; step <= 25; step += 1) {
    lines.push(`${step}. Read entry ${step * 3} and compare its parent with the leaf.`);
  }
  return lines.join("\n");
}

/**
 * The playground conversation: omp's opening settings, a bash turn with its result, a labelled
 * answer, and a 26-line answer that is the current message.
 */
export function reviewSession(): OmpSessionFixture {
  const session = new OmpSessionBuilder();
  session.modelChange("anthropic/claude-sonnet-5");
  session.thinkingLevelChange("medium");
  session.titleChange("Review the conversation");
  session.user("Review the conversation and explain its guarantees.");
  const listing = session.toolCall("bash", { command: "ls docs" });
  session.toolResult(listing, "guarantees.md\nhistory.md\ntree.md");
  const answer = session.assistant(
    "The conversation keeps messages in order and leaves the original conversation unchanged.",
  );
  session.label(answer, "Review checkpoint");
  session.user("Compare the earlier conversation with the current messages.");
  session.assistant(longAnswer());
  return session.build();
}

/** A straight chain of `messageCount` messages after omp's opening settings, with tool turns and a label. */
export function longChatSession(messageCount: number): OmpSessionFixture {
  const session = new OmpSessionBuilder();
  session.modelChange("anthropic/claude-sonnet-5");
  session.thinkingLevelChange("medium");
  let last = "";
  for (let index = 1; index <= messageCount; index += 1) {
    if (index % 2 === 1) {
      const text =
        index === 25
          ? "Unique request about database indexing."
          : `Question ${index} about the conversation.`;
      last = session.user(text);
    } else if (index % 10 === 0) {
      const call = session.toolCall("bash", { command: `echo step ${index}` });
      session.toolResult(call, `step ${index}`);
      last = session.assistant(`Answer ${index}, after the check.`);
    } else {
      last = session.assistant(`Answer ${index} about the conversation.`);
    }
    if (index === 40) session.label(last, "Checkpoint 40");
  }
  return session.build();
}
