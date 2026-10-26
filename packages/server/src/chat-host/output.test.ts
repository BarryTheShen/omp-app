import { describe, expect, test } from "bun:test";
import { createLineWriter, type LineSink } from "./output";

/** A pipe that accepts or pushes back on demand, and completes writes when told. */
class FakePipe implements LineSink {
  readonly written: string[] = [];
  readonly #callbacks: ((error?: Error | null) => void)[] = [];
  readonly #listeners = new Map<string, ((error: Error) => void)[]>();
  accepting = true;

  write(text: string, callback: (error?: Error | null) => void): boolean {
    this.written.push(text);
    this.#callbacks.push(callback);
    return this.accepting;
  }

  on(event: "drain" | "error" | "close", listener: (error: Error) => void): unknown {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: "drain" | "error" | "close", error = new Error(event)): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(error);
  }

  completeAll(error?: Error): void {
    for (const callback of this.#callbacks.splice(0)) callback(error ?? null);
  }
}

const settled = (promise: Promise<unknown>) => {
  const state = { done: false };
  promise.then(
    () => {
      state.done = true;
    },
    () => {
      state.done = true;
    },
  );
  return state;
};

describe("the stdout writer", () => {
  test("lines come out whole and in order while the pipe pushes back, and flush waits for the last", async () => {
    const pipe = new FakePipe();
    const writer = createLineWriter(pipe, () => undefined);
    pipe.accepting = false;
    writer.write("one");
    writer.write("two");
    writer.write("three");
    expect(pipe.written).toEqual(["one\n"]);

    const flushed = settled(writer.flush());
    pipe.completeAll();
    await Bun.sleep(0);
    expect(flushed.done).toBe(false);

    pipe.accepting = true;
    pipe.emit("drain");
    expect(pipe.written).toEqual(["one\n", "two\n", "three\n"]);
    pipe.completeAll();
    await Bun.sleep(0);
    expect(flushed.done).toBe(true);
  });

  test("a failed pipe fails the writer once: later lines are dropped and flush rejects", async () => {
    const pipe = new FakePipe();
    const failures: Error[] = [];
    const writer = createLineWriter(pipe, (error) => failures.push(error));
    writer.write("one");
    pipe.completeAll(new Error("EPIPE"));
    pipe.emit("close");
    writer.write("two");
    expect(pipe.written).toEqual(["one\n"]);
    expect(failures.map((error) => error.message)).toEqual(["EPIPE"]);
    await expect(writer.flush()).rejects.toThrow("EPIPE");
  });
});
