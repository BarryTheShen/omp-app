import { describe, expect, test } from "bun:test";
import { InputGate, linesOf } from "./input";

function reader(chunks: readonly Uint8Array[]) {
  const queue = [...chunks];
  return {
    read: async () => {
      const value = queue.shift();
      return value === undefined ? { done: true } : { done: false, value };
    },
  };
}

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

describe("the server's lines", () => {
  test("a line split across reads arrives whole, and a last line without a newline still arrives", async () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const lines = await collect(
      linesOf(reader([encode('{"a":1}\n{"b'), encode('":2}\n'), encode("tail")])),
    );
    expect(lines).toEqual(['{"a":1}', '{"b":2}', "tail"]);
  });

  test("a character split across reads is decoded whole", async () => {
    const bytes = new TextEncoder().encode('{"text":"café ☕"}\n');
    const cut = bytes.indexOf(0xe2) + 1;
    const lines = await collect(linesOf(reader([bytes.slice(0, cut), bytes.slice(cut)])));
    expect(lines).toEqual(['{"text":"café ☕"}']);
  });
});

describe("the order of user input", () => {
  test("an abort invalidates the prompts read before it, never those read after", () => {
    const gate = new InputGate();
    const before = gate.accept("input");
    gate.accept("abort");
    const after = gate.accept("input");
    expect(gate.isCurrent(before)).toBe(false);
    expect(gate.isCurrent(after)).toBe(true);
  });

  test("a session change, once made, invalidates the prompts read before it", () => {
    const gate = new InputGate();
    const before = gate.accept("input");
    const change = gate.accept("input");
    const after = gate.accept("input");
    expect(gate.isCurrent(before)).toBe(true);
    gate.commitSessionChange(change);
    expect(gate.isCurrent(before)).toBe(false);
    expect(gate.isCurrent(after)).toBe(true);
  });

  test("a change made after a later abort leaves that abort in force", () => {
    const gate = new InputGate();
    const change = gate.accept("input");
    const prompt = gate.accept("input");
    gate.accept("abort");
    gate.commitSessionChange(change);
    expect(gate.isCurrent(prompt)).toBe(false);
  });

  test("prompts are admitted one at a time in the order read, even after one fails", async () => {
    const gate = new InputGate();
    const order: string[] = [];
    const first = Promise.withResolvers<void>();
    const a = gate.enqueue(async () => {
      order.push("a starts");
      await first.promise;
      throw new Error("a failed");
    });
    const b = gate.enqueue(async () => {
      order.push("b starts");
    });
    await Bun.sleep(0);
    expect(order).toEqual(["a starts"]);
    first.resolve();
    await expect(a).rejects.toThrow("a failed");
    await b;
    expect(order).toEqual(["a starts", "b starts"]);
  });
});
