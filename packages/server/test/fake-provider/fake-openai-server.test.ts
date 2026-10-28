import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as path from "node:path";

const SERVER = path.resolve(import.meta.dir, "fake-openai-server.ts");
// Scratch files live in the repo's git-ignored `.data` directory, never in /tmp.
const SCRATCH = path.resolve(import.meta.dir, "../../../../.data");
const decoder = new TextDecoder();

interface Turn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

interface SseChunk {
  readonly choices: readonly { readonly delta: { readonly content?: string } }[];
}

/** Resolves with the port the server prints once it is listening. */
async function readyPort(output: ReadableStream<Uint8Array>): Promise<number> {
  let text = "";
  for await (const chunk of output) {
    text += decoder.decode(chunk, { stream: true });
    const ready = /READY (\d+)/.exec(text);
    if (ready?.[1] !== undefined) return Number(ready[1]);
  }
  throw new Error(`The fake server stopped before it was ready: ${text}`);
}

/** Runs the fake server in a scratch agent directory for one test, then stops it and removes the directory. */
async function withFakeServer(run: (port: number) => Promise<void>): Promise<void> {
  await mkdir(SCRATCH, { recursive: true });
  const agentDir = await mkdtemp(path.join(SCRATCH, "fake-openai-server-"));
  const child = Bun.spawn([process.execPath, SERVER, agentDir], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await run(await readyPort(child.stdout));
  } finally {
    child.kill();
    await child.exited;
    await rm(agentDir, { recursive: true, force: true });
  }
}

/** The raw server-sent events of one streamed chat completion. */
async function complete(port: number, messages: readonly Turn[]): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fake-model", stream: true, messages }),
  });
  return response.text();
}

/** The content of each server-sent event that carries some, in the order they were sent. */
function contentPieces(events: string): string[] {
  const pieces: string[] = [];
  for (const event of events.split("\n\n")) {
    if (!event.startsWith("data: ") || event === "data: [DONE]") continue;
    const chunk: SseChunk = JSON.parse(event.slice("data: ".length));
    for (const choice of chunk.choices) {
      if (choice.delta.content !== undefined) pieces.push(choice.delta.content);
    }
  }
  return pieces;
}

describe("fake OpenAI server", () => {
  test("a stream_code reply arrives as several content deltas that make up one fenced block", () =>
    withFakeServer(async (port) => {
      const pieces = contentPieces(
        await complete(port, [{ role: "user", content: "please stream_code" }]),
      );
      const reply = pieces.join("");
      expect(pieces.length).toBeGreaterThan(10);
      expect(reply.startsWith("Here is the streamed block:")).toBe(true);
      expect(reply).toContain("export const answer = sum([1, 2, 3]);");
      expect(reply.endsWith("```")).toBe(true);
    }));

  test(
    "a stream_long_code reply is one fenced block over the code view's short-block limit",
    () =>
      withFakeServer(async (port) => {
        const pieces = contentPieces(
          await complete(port, [{ role: "user", content: "please stream_long_code" }]),
        );
        const reply = pieces.join("");
        expect(reply.startsWith("Here is the long streamed block:")).toBe(true);
        expect(reply.length).toBeGreaterThan(2_048);
        expect(reply.endsWith("```")).toBe(true);
      }),
    30_000,
  );

  test("a reply without stream_code is one content delta, even after a streamed turn", () =>
    withFakeServer(async (port) => {
      const pieces = contentPieces(
        await complete(port, [
          { role: "user", content: "please stream_code" },
          { role: "assistant", content: "Here is the streamed block:" },
          { role: "user", content: "say something else" },
        ]),
      );
      expect(pieces).toHaveLength(1);
    }));
});
