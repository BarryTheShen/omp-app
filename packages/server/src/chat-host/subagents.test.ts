import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TASK_SUBAGENT_EVENT_CHANNEL,
  TASK_SUBAGENT_LIFECYCLE_CHANNEL,
  TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { SubagentEvent } from "@omp-app/contracts/chat-host";
import { readSubagentTranscript, SubagentRoster } from "./subagents";

/** omp's reports about one subagent, with the fields the roster reads. */
const started = (id: string, sessionFile: string) => ({
  id,
  index: 0,
  agent: "task",
  agentSource: "bundled",
  status: "started",
  sessionFile,
  parentToolCallId: `call-${id}`,
});
const ended = (id: string, sessionFile: string) => ({
  ...started(id, sessionFile),
  status: "completed",
});
const progress = (id: string) => ({
  index: 0,
  agent: "task",
  agentSource: "bundled",
  task: "a small task",
  parentToolCallId: `call-${id}`,
  progress: { id, index: 0, status: "running", description: "Reading the files" },
});

function roster() {
  const bus = new EventBus();
  const events: SubagentEvent[] = [];
  return { bus, events, roster: new SubagentRoster(bus, (event) => events.push(event)) };
}

describe("the subagent roster", () => {
  test("a subagent is listed while it runs; afterwards its transcript stays readable, and events follow the level", () => {
    const { bus, events, roster: subagents } = roster();
    bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, started("a", "/sessions/a.jsonl"));
    expect(events).toEqual([]);
    subagents.setLevel("progress");
    bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progress("a"));
    bus.emit(TASK_SUBAGENT_EVENT_CHANNEL, { id: "a", event: { type: "turn_start" } });
    expect(subagents.list()).toMatchObject([
      { id: "a", status: "running", description: "Reading the files" },
    ]);
    bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, ended("a", "/sessions/a.jsonl"));
    expect(subagents.list()).toEqual([]);
    expect(subagents.transcriptFile({ subagentId: "a" })).toBe("/sessions/a.jsonl");
    expect(events.map((event) => event.type)).toEqual(["subagent_progress", "subagent_lifecycle"]);
  });

  test("at the events level a subagent's own session events go out too", () => {
    const { bus, events, roster: subagents } = roster();
    subagents.setLevel("events");
    bus.emit(TASK_SUBAGENT_EVENT_CHANNEL, { id: "a", event: { type: "turn_start" } });
    subagents.setLevel("progress");
    bus.emit(TASK_SUBAGENT_EVENT_CHANNEL, { id: "a", event: { type: "turn_end" } });
    expect(events).toEqual([
      { type: "subagent_event", payload: { id: "a", event: { type: "turn_start" } } },
    ]);
  });

  test("after a session change the old subagents are gone, and their late progress is dropped", () => {
    const { bus, roster: subagents } = roster();
    bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, started("a", "/sessions/a.jsonl"));
    subagents.clear();
    bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progress("a"));
    expect(subagents.list()).toEqual([]);
    expect(() => subagents.transcriptFile({ subagentId: "a" })).toThrow("Unknown subagent");
  });

  test("only this session's subagents' transcripts open, never another file", () => {
    const { bus, roster: subagents } = roster();
    bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, started("a", "/sessions/a.jsonl"));
    expect(subagents.transcriptFile({ sessionFile: "/sessions/a.jsonl" })).toBe(
      "/sessions/a.jsonl",
    );
    expect(() => subagents.transcriptFile({ sessionFile: "/etc/passwd" })).toThrow(
      "Unknown subagent session file",
    );
  });
});

describe("a subagent's transcript", () => {
  let folder: string | undefined;
  afterEach(async () => {
    if (folder) await rm(folder, { recursive: true, force: true });
  });

  const message = (text: string) =>
    JSON.stringify({
      type: "message",
      id: text,
      parentId: null,
      timestamp: "2026-10-26T00:00:00.000Z",
      message: { role: "user", content: text },
    });

  test("whole lines are read from the offset; a line still being written waits; a shorter file starts over", async () => {
    folder = await mkdtemp(join(tmpdir(), "omp-app-subagent-transcript-"));
    const file = join(folder, "a.jsonl");
    await writeFile(file, `${message("one")}\n${message("two").slice(0, 10)}`);
    const first = await readSubagentTranscript(file);
    expect(first.messages).toMatchObject([{ role: "user", content: "one" }]);
    await writeFile(file, `${message("one")}\n${message("two")}\n`);
    const next = await readSubagentTranscript(file, first.nextByte);
    expect(next.messages).toMatchObject([{ role: "user", content: "two" }]);
    await writeFile(file, `${message("new")}\n`);
    const replaced = await readSubagentTranscript(file, next.nextByte);
    expect(replaced).toMatchObject({
      reset: true,
      fromByte: 0,
      messages: [{ role: "user", content: "new" }],
    });
  });

  test("a transcript not written yet reads as empty", async () => {
    expect(await readSubagentTranscript("/nonexistent/omp-app/a.jsonl", 5)).toEqual({
      sessionFile: "/nonexistent/omp-app/a.jsonl",
      fromByte: 5,
      nextByte: 5,
      reset: false,
      entries: [],
      messages: [],
    });
  });
});
