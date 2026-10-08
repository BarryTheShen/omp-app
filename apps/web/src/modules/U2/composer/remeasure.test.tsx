import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { useRemeasureOnWidthChange } from "./remeasure";

let callbacks: Array<() => void> = [];
let disconnected = 0;
const original = globalThis.ResizeObserver;

beforeEach(() => {
  callbacks = [];
  disconnected = 0;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      callbacks.push(callback);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {
      disconnected += 1;
    }
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  globalThis.ResizeObserver = original;
});

let renders = 0;

function Box({ widthRef }: { readonly widthRef: { current: number } }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  renders += 1;
  useRemeasureOnWidthChange(ref);
  return (
    <textarea
      aria-label="box"
      ref={(element) => {
        ref.current = element;
        if (element)
          Object.defineProperty(element, "clientWidth", {
            get: () => widthRef.current,
            configurable: true,
          });
      }}
    />
  );
}

function fire(): void {
  act(() => {
    for (const callback of callbacks) callback();
  });
}

describe("useRemeasureOnWidthChange", () => {
  test("renders again when the width changes, and not when only the height does", () => {
    renders = 0;
    const width = { current: 324 };
    render(<Box widthRef={width} />);
    const afterMount = renders;

    // The observer fires for a height change: the width is the same, so nothing renders.
    fire();
    expect(renders).toBe(afterMount);

    // The width changes: the caller renders once, so the autosize box measures at the new width.
    width.current = 120;
    fire();
    expect(renders).toBe(afterMount + 1);

    // The same width again is not a change.
    fire();
    expect(renders).toBe(afterMount + 1);

    width.current = 324;
    fire();
    expect(renders).toBe(afterMount + 2);
  });

  test("stops observing when the caller unmounts", () => {
    const view = render(<Box widthRef={{ current: 200 }} />);
    view.unmount();
    expect(disconnected).toBe(1);
  });

  test("does nothing where ResizeObserver does not exist", () => {
    // @ts-expect-error simulating an environment without ResizeObserver
    globalThis.ResizeObserver = undefined;
    expect(() => render(<Box widthRef={{ current: 200 }} />)).not.toThrow();
  });
});
