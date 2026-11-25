import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeechRecording } from "@omp-app/contracts";
import type { ProcessTimer } from "../../../process/omp-process";
import { SpeechRecordings } from "./recordings";
import { SpeechSettingsStore } from "./settings";
import { cleanAsrText, joinPieceTexts, silentWav } from "./transcribe";

/** A timer the test moves: waits between tries and the 60 s timeout fire only when it advances past them. */
class FakeTimer implements ProcessTimer {
  now = 1_790_000_000_000;
  #next = 0;
  readonly #due = new Map<number, { at: number; run: () => void }>();
  setTimeout(handler: () => void, delayMs: number): unknown {
    const id = ++this.#next;
    this.#due.set(id, { at: this.now + delayMs, run: handler });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.#due.delete(handle as number);
  }
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.#due.entries()]
        .filter(([, item]) => item.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (next === undefined) break;
      this.#due.delete(next[0]);
      this.now = next[1].at;
      next[1].run();
      await settle();
    }
    this.now = end;
  }
}

async function settle(): Promise<void> {
  for (let round = 0; round < 20; round++) await new Promise((resolve) => setImmediate(resolve));
}

/** Reads until `done` holds, for up to 20 seconds: a loaded machine (the full suite beside others) can take seconds. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting");
}

/** Moves the fake time on, 10 s at a time, until `read` gives what `done` wants (the waits between tries pass). */
async function driveUntil<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let round = 0; round < 400; round++) {
    const value = await read();
    if (done(value)) return value;
    await timer.advance(10_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting");
}

/** A transcription server that answers as the test says, and keeps what it was sent. */
function fakeServer(answer: (request: Request, body: unknown) => Response | Promise<Response>) {
  const seen: { path: string; body: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = path.endsWith("/chat/completions")
        ? await request.json()
        : Object.fromEntries(
            [...(await request.formData()).entries()].map(([key, value]) => [
              key,
              typeof value === "string" ? value : `file:${value.size}`,
            ]),
          );
      seen.push({ path, body });
      return answer(request, body);
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, seen, stop: () => server.stop(true) };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

let dir: string;
let timer: FakeTimer;
let settings: SpeechSettingsStore;
let stops: (() => void)[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "speech-"));
  timer = new FakeTimer();
  settings = new SpeechSettingsStore({ appDataDir: dir });
  stops = [];
});

afterEach(async () => {
  for (const stop of stops) stop();
  await rm(dir, { recursive: true, force: true });
});

async function useServers(
  servers: { id: string; url: string; api: "transcriptions" | "chat-audio"; key?: string | null }[],
  extra: { keepDays?: number; context?: string; language?: "auto" | "zh" | "en" } = {},
) {
  const { revision } = await settings.read();
  return settings.set({
    settings: {
      enabled: true,
      servers: servers.map((server) => ({
        id: server.id,
        name: server.id,
        url: server.url,
        api: server.api,
        model: "qwen3-asr",
        ...(server.key === undefined ? {} : { key: server.key }),
      })),
      language: extra.language ?? "auto",
      context: extra.context ?? "",
      keepDays: extra.keepDays ?? 14,
    },
    expectedRevision: revision,
  });
}

function recordings(): SpeechRecordings {
  const made = new SpeechRecordings({
    settings,
    appDataDir: dir,
    timer,
    now: () => timer.now,
  });
  stops.push(() => made.stop());
  return made;
}

/** Sends a piece of `ms` of silence in chunks of at most `chunk` bytes. */
async function send(store: SpeechRecordings, id: string, index: number, ms = 2000, chunk = 40_000) {
  const wav = silentWav(ms);
  let result = { received: 0, complete: false };
  for (let offset = 0; offset < wav.length; offset += chunk) {
    result = await store.putPiece({
      recordingId: id,
      startedAt: timer.now,
      index,
      offset,
      data: Buffer.from(wav.subarray(offset, offset + chunk)).toString("base64"),
      size: wav.length,
    });
  }
  return result;
}

const pieceOf = async (store: SpeechRecordings, id: string, index: number) =>
  (await store.list())
    .find((each) => each.id === id)
    ?.pieces.find((piece) => piece.index === index);

describe("voice input settings", () => {
  test("start off with no server; a key is kept for its server and never shown, kept when left out, removed with null", async () => {
    expect((await settings.read()).settings).toEqual({
      enabled: false,
      servers: [],
      language: "auto",
      context: "",
      keepDays: 14,
    });
    await useServers([
      { id: "gpu", url: "http://gpu-box:8080/v1", api: "chat-audio", key: "sk-1" },
    ]);
    const read = await settings.read();
    expect(read.settings.servers[0]?.hasKey).toBe(true);
    expect(JSON.stringify(read)).not.toContain("sk-1");
    expect((await settings.servers())[0]?.key).toBe("sk-1");
    await useServers([{ id: "gpu", url: "http://gpu-box:8080/v1", api: "chat-audio" }]);
    expect((await settings.servers())[0]?.key).toBe("sk-1");
    await useServers([{ id: "gpu", url: "http://gpu-box:8080/v1", api: "chat-audio", key: null }]);
    expect((await settings.servers())[0]?.key).toBeUndefined();
  });

  test("a change made on an older revision is a retryable conflict; two servers with one id are refused", async () => {
    const first = await settings.read();
    await useServers([{ id: "a", url: "http://a/v1", api: "transcriptions" }]);
    const stale = settings.set({
      settings: { ...first.settings, servers: [] },
      expectedRevision: first.revision,
    });
    await expect(stale).rejects.toMatchObject({ appError: { code: "conflict", retryable: true } });
    const now = await settings.read();
    const twice = settings.set({
      settings: {
        ...now.settings,
        servers: [
          { id: "a", name: "a", url: "http://a/v1", api: "transcriptions", model: "" },
          { id: "a", name: "b", url: "http://b/v1", api: "transcriptions", model: "" },
        ],
      },
      expectedRevision: now.revision,
    });
    await expect(twice).rejects.toMatchObject({ appError: { code: "invalid_args" } });
  });
});

describe("talking to a transcription server", () => {
  test("the transcription API gets the WAV as a form file with the model, language and words; the chat API an input_audio part", async () => {
    const asr = fakeServer((request) =>
      new URL(request.url).pathname.endsWith("/chat/completions")
        ? json({
            choices: [{ message: { content: "language Chinese<asr_text>我们用 Claude 写 code" } }],
          })
        : json({ text: "hello there" }),
    );
    stops.push(asr.stop);
    await useServers(
      [
        { id: "vllm", url: asr.url, api: "transcriptions" },
        { id: "llama", url: `${asr.url}/`, api: "chat-audio" },
      ],
      { language: "zh", context: "omp, Kubernetes" },
    );
    const store = recordings();
    expect(await store.test("vllm")).toMatchObject({ ok: true });
    expect(await store.test("llama")).toMatchObject({ ok: true });
    expect(asr.seen[0]).toEqual({
      path: "/v1/audio/transcriptions",
      body: {
        file: `file:${silentWav(1000).length}`,
        model: "qwen3-asr",
        language: "zh",
        prompt: "omp, Kubernetes",
        response_format: "json",
      },
    });
    const chat = asr.seen[1]?.body as { messages: { role: string; content: unknown }[] };
    expect(asr.seen[1]?.path).toBe("/v1/chat/completions");
    expect(chat.messages[0]).toEqual({ role: "system", content: "omp, Kubernetes" });
    expect(chat.messages[1]?.content).toEqual([
      {
        type: "input_audio",
        input_audio: { data: Buffer.from(silentWav(1000)).toString("base64"), format: "wav" },
      },
    ]);
  });

  test("a server that answers with an error says so, with its words; one that is down says why", async () => {
    const asr = fakeServer(() => new Response("model not loaded", { status: 503 }));
    stops.push(asr.stop);
    await useServers([
      { id: "broken", url: asr.url, api: "transcriptions" },
      { id: "down", url: "http://127.0.0.1:9/v1", api: "transcriptions" },
    ]);
    const store = recordings();
    expect(await store.test("broken")).toMatchObject({
      ok: false,
      error: "HTTP 503: model not loaded",
    });
    expect((await store.test("down")).ok).toBe(false);
  });

  test("Qwen3-ASR's language prefix is taken off, and no speech is no text", () => {
    expect(cleanAsrText("language English<asr_text>Today we ship.")).toBe("Today we ship.");
    expect(cleanAsrText("language None<asr_text>")).toBe("");
    expect(cleanAsrText(" plain text ")).toBe("plain text");
  });

  test("pieces join with a space only between Latin on both sides of the cut", () => {
    expect(joinPieceTexts(["We ship today.", "Then rest."])).toBe("We ship today. Then rest.");
    expect(joinPieceTexts(["今天我们发布", "然后休息。"])).toBe("今天我们发布然后休息。");
    expect(joinPieceTexts(["用 Claude", "写代码", "", "and test it"])).toBe(
      "用 Claude写代码and test it",
    );
  });
});

describe("recordings", () => {
  test("a piece sent in chunks is kept and transcribed; sending it again changes nothing", async () => {
    const asr = fakeServer(() => json({ text: "第一段 first piece" }));
    stops.push(asr.stop);
    await useServers([{ id: "gpu", url: asr.url, api: "transcriptions" }]);
    const store = recordings();
    await store.start();
    const heard: SpeechRecording[] = [];
    store.subscribe((change) => change.kind === "recording" && heard.push(change.recording));
    expect(await send(store, "rec-1", 0)).toMatchObject({ complete: true });
    // A piece is saved, then announced: wait for the announcement, not only the file.
    await until(
      async () => heard.at(-1)?.pieces[0]?.state,
      (state) => state === "done",
    );
    const done = await pieceOf(store, "rec-1", 0);
    expect(done).toMatchObject({ text: "第一段 first piece", server: "gpu", ms: 2000 });
    expect(heard.map((recording) => recording.pieces[0]?.state)).toEqual([
      "stored",
      "transcribing",
      "done",
    ]);
    expect(await send(store, "rec-1", 0)).toMatchObject({ complete: true });
    expect(asr.seen).toHaveLength(1);
    const finished = await store.finish("rec-1", 1);
    expect(finished).toMatchObject({ pieceCount: 1, text: "第一段 first piece" });
    // The whole recording, for agents: one WAV and its transcript, beside the pieces.
    const whole = await readFile(join(dir, "voice", "rec-1", "audio.wav"));
    expect(whole.length).toBe(silentWav(2000).length);
    expect(whole.subarray(0, 4).toString()).toBe("RIFF");
    expect(whole.readUInt32LE(40)).toBe(silentWav(2000).length - 44);
    expect(await readFile(join(dir, "voice", "rec-1", "transcript.md"), "utf8")).toContain(
      "第一段 first piece",
    );
    expect((await store.audio("rec-1", undefined, 0)).size).toBe(whole.length);
  });

  test("a server that fails is tried again after waits, then the next server; a piece every server failed keeps its audio and Retry transcribes it", async () => {
    let first = 0;
    const flaky = fakeServer(() => {
      first += 1;
      return new Response("busy", { status: 500 });
    });
    let secondUp = false;
    const backup = fakeServer(() =>
      secondUp ? json({ text: "from the backup" }) : new Response("down", { status: 502 }),
    );
    stops.push(flaky.stop, backup.stop);
    await useServers([
      { id: "gpu", url: flaky.url, api: "transcriptions" },
      { id: "backup", url: backup.url, api: "transcriptions" },
    ]);
    const store = recordings();
    await store.start();
    await send(store, "rec-2", 0);
    // Three tries on the first server (2 s and 8 s apart), then three on the backup: every one fails.
    const failed = await driveUntil(
      () => pieceOf(store, "rec-2", 0),
      (piece) => piece?.state === "failed",
    );
    expect(first).toBe(3);
    expect(backup.seen).toHaveLength(3);
    expect(failed?.error).toBe("backup: HTTP 502: down");
    expect((await stat(join(dir, "voice", "rec-2", "0.wav"))).size).toBe(silentWav(2000).length);
    expect((await store.audio("rec-2", 0, 0)).size).toBe(silentWav(2000).length);

    secondUp = true;
    await store.retry("rec-2", 0);
    const done = await driveUntil(
      () => pieceOf(store, "rec-2", 0),
      (piece) => piece?.state === "done",
    );
    expect(done).toMatchObject({ text: "from the backup", server: "backup" });
    expect(done?.error).toBeUndefined();
  });

  test("pieces of one recording are transcribed in order, and the recording's text joins them", async () => {
    const order: string[] = [];
    const asr = fakeServer(async (_request, body) => {
      const size = (body as { file: string }).file;
      order.push(size);
      return json({ text: size === `file:${silentWav(1000).length}` ? "one" : "two" });
    });
    stops.push(asr.stop);
    await useServers([{ id: "gpu", url: asr.url, api: "transcriptions" }]);
    const store = recordings();
    await store.start();
    await send(store, "rec-3", 0, 1000);
    await send(store, "rec-3", 1, 1500);
    const recording = await until(
      async () => (await store.list()).find((each) => each.id === "rec-3"),
      (each) => each?.pieces.every((piece) => piece.state === "done") === true,
    );
    expect(order).toEqual([`file:${silentWav(1000).length}`, `file:${silentWav(1500).length}`]);
    expect(recording?.text).toBe("one two");
  });

  test("after a restart, a piece that was not transcribed yet goes back into the queue", async () => {
    let up = false;
    const asr = fakeServer(() =>
      up ? json({ text: "after the restart" }) : new Response("x", { status: 500 }),
    );
    stops.push(asr.stop);
    await useServers([{ id: "gpu", url: asr.url, api: "transcriptions" }]);
    const before = recordings();
    await before.start();
    await send(before, "rec-4", 0);
    await until(
      () => pieceOf(before, "rec-4", 0),
      (piece) => piece?.error !== undefined,
    );
    before.stop();
    up = true;
    const after = recordings();
    await after.start();
    const done = await until(
      () => pieceOf(after, "rec-4", 0),
      (piece) => piece?.state === "done",
    );
    expect(done?.text).toBe("after the restart");
  });

  test("recordings older than the kept days are swept with their audio; Discard removes one at once", async () => {
    const asr = fakeServer(() => json({ text: "x" }));
    stops.push(asr.stop);
    await useServers([{ id: "gpu", url: asr.url, api: "transcriptions" }], { keepDays: 1 });
    const store = recordings();
    await store.start();
    const removed: string[] = [];
    store.subscribe((change) => change.kind === "removed" && removed.push(change.recordingId));
    await send(store, "old", 0);
    await send(store, "kept", 0);
    await until(
      () => store.list(),
      (all) => all.every((each) => each.pieces[0]?.state === "done"),
    );
    // The daily sweep a day after the start sees them exactly a day old (kept); the next day's removes them.
    await timer.advance(2 * 86_400_000 + 1);
    // A removal is announced once its folder is gone: wait for both announcements, not only the empty list.
    await until(
      async () => removed.length,
      (count) => count === 2,
    );
    expect(await store.list()).toEqual([]);
    expect(removed.sort()).toEqual(["kept", "old"]);
    await expect(readFile(join(dir, "voice", "old", "0.wav"))).rejects.toThrow();

    await send(store, "gone", 0);
    await store.discard("gone");
    expect(await store.list()).toEqual([]);
  });
});
