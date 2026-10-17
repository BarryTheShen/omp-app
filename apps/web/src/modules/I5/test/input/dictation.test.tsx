import type { ChatModelAdapter } from "@assistant-ui/react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useAui,
  useAuiState,
  useLocalRuntime,
} from "@assistant-ui/react";
import { type DraftScope, ThreadId } from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMemo, useSyncExternalStore } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useComposerDraft } from "@/modules/U2/drafts";
import { DraftController, type DraftTimer } from "@/modules/U2/drafts/drafts";
import { ScopedDraftStore } from "@/modules/U2/drafts/test-support";
import type {
  SpeechRecognitionErrorEventLike,
  SpeechRecognitionLike,
  SpeechRecognitionResultEventLike,
  SpeechRecognitionResultLike,
} from "../../dictation";
import { createBrowserDictationPort, dictationViews } from "../../dictation";

const DictationControl = dictationViews.control;

afterEach(() => {
  cleanup();
  FakeRecognition.instances.length = 0;
  FakeRecognition.neverEnds = false;
  vi.useRealTimers();
});

const NO_TIMERS: DraftTimer = { setTimeout: () => undefined, clearTimeout: () => undefined };
const NO_ATTACHMENTS = {
  restore: async () => undefined,
  subscribe: () => () => undefined,
  toDraftRefs: () => [],
  dropPending: () => undefined,
};
const NOT_RECALLED = () => false;
const controllers: DraftController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.dispose();
});

class FakeRecognition implements SpeechRecognitionLike {
  static readonly instances: FakeRecognition[] = [];
  static neverEnds = false;
  lang = "";
  continuous = false;
  interimResults = false;
  onstart: ((event: Event) => void) | null = null;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null = null;
  onend: ((event: Event) => void) | null = null;
  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start(): void {
    this.startCalls += 1;
  }

  stop(): void {
    this.stopCalls += 1;
    if (!FakeRecognition.neverEnds) this.onend?.(new Event("end"));
  }

  abort(): void {
    this.abortCalls += 1;
    if (!FakeRecognition.neverEnds) this.onend?.(new Event("end"));
  }

  emitStart(): void {
    this.onstart?.(new Event("start"));
  }

  emitResult(transcript: string, isFinal: boolean): void {
    const result = Object.assign([{ transcript }], { isFinal }) as SpeechRecognitionResultLike;
    const event = Object.assign(new Event("result"), {
      resultIndex: 0,
      results: [result],
    }) as SpeechRecognitionResultEventLike;
    this.onresult?.(event);
  }

  emitError(error: string): void {
    this.onerror?.(Object.assign(new Event("error"), { error }) as SpeechRecognitionErrorEventLike);
  }
}

async function draftWithText(text: string) {
  const store = new ScopedDraftStore();
  const scope: DraftScope = { kind: "thread", threadId: ThreadId.parse("i5-dictation-test") };
  if (text !== "") {
    await store.save({
      scope,
      draft: { text, attachments: [], failedSends: [] },
      expectedRevision: null,
    });
  }
  const controller = new DraftController({ store, scope, timers: NO_TIMERS });
  await controller.load();
  controllers.push(controller);
  return { controller, scope, store };
}

function DraftedComposer({
  adapter,
  controller,
  mode,
  secondMode,
  onError,
}: {
  readonly adapter: ReturnType<typeof createBrowserDictationPort>;
  readonly controller: DraftController;
  readonly mode: "push-to-talk" | "toggle";
  readonly secondMode?: "push-to-talk" | "toggle";
  readonly onError?: (message: string) => void;
}) {
  const aui = useAui();
  const text = useAuiState((state) => state.composer.text);
  const snapshot = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getSnapshot(),
    () => controller.getSnapshot(),
  );
  useComposerDraft({
    chat: controller,
    controller,
    text,
    composer: aui.composer,
    attachments: NO_ATTACHMENTS,
    isRecalledPrompt: NOT_RECALLED,
  });
  return (
    <>
      <ComposerPrimitive.Root>
        <ComposerPrimitive.Input aria-label="Message input" />
        <DictationControl adapter={adapter} mode={mode} onError={onError} />
        {secondMode === undefined ? null : (
          <DictationControl adapter={adapter} mode={secondMode} onError={onError} />
        )}
        <ComposerPrimitive.Send>Send message</ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
      <output data-testid="saved-draft">{snapshot.text}</output>
    </>
  );
}

function RuntimeHarness({
  adapter,
  controller,
  mode,
  secondMode,
  run,
  onError,
}: {
  readonly adapter: ReturnType<typeof createBrowserDictationPort>;
  readonly controller: DraftController;
  readonly mode: "push-to-talk" | "toggle";
  readonly secondMode?: "push-to-talk" | "toggle";
  readonly run: () => void;
  readonly onError?: (message: string) => void;
}) {
  const chatModel = useMemo<ChatModelAdapter>(
    () => ({
      async run() {
        run();
        return { content: [] };
      },
    }),
    [run],
  );
  const runtime = useLocalRuntime(chatModel, { adapters: { dictation: adapter } });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <DraftedComposer
        adapter={adapter}
        controller={controller}
        mode={mode}
        secondMode={secondMode}
        onError={onError}
      />
    </AssistantRuntimeProvider>
  );
}

describe("the browser dictation adapter", () => {
  test("reports interim and final speech, then resolves stop and cleanup", async () => {
    const onSpeech = vi.fn();
    const onSpeechStart = vi.fn();
    const onSpeechEnd = vi.fn();
    const adapter = createBrowserDictationPort({ recognition: FakeRecognition });
    expect(adapter.available).toBe(true);
    const session = adapter.listen();
    const recognition = FakeRecognition.instances[0];
    if (!recognition) throw new Error("The recognition instance was not created.");
    session.onSpeech(onSpeech);
    session.onSpeechStart(onSpeechStart);
    session.onSpeechEnd(onSpeechEnd);

    recognition.emitStart();
    recognition.emitResult("some words", false);
    recognition.emitResult("some words, finalized", true);
    expect(session.status).toEqual({ type: "running" });
    expect(onSpeechStart).toHaveBeenCalledOnce();
    expect(onSpeech.mock.calls.map(([result]) => result)).toEqual([
      { transcript: "some words", isFinal: false },
      { transcript: "some words, finalized", isFinal: true },
    ]);

    await act(async () => session.stop());
    expect(recognition.stopCalls).toBe(1);
    expect(session.status).toEqual({ type: "ended", reason: "stopped" });
    expect(onSpeechEnd).toHaveBeenCalledOnce();
  });

  test("reports only safe permission errors and returns an explicit unsupported state", () => {
    const onError = vi.fn();
    const adapter = createBrowserDictationPort({ recognition: FakeRecognition, onError });
    const onPortError = vi.fn();
    adapter.subscribeError(onPortError);
    const session = adapter.listen();
    const recognition = FakeRecognition.instances[0];
    if (!recognition) throw new Error("The recognition instance was not created.");
    recognition.emitError("not-allowed");

    expect(session.status).toEqual({ type: "ended", reason: "error" });
    expect(onError).toHaveBeenCalledWith("Microphone access was denied.");
    expect(onPortError).toHaveBeenCalledWith("Microphone access was denied.");

    const unavailable = createBrowserDictationPort({ recognition: null });
    expect(unavailable.available).toBe(false);
    expect(unavailable.unavailableReason).toBe(
      "Speech recognition is not available in this browser.",
    );
    expect(() => unavailable.listen()).toThrow(
      "Speech recognition is not available in this browser.",
    );
  });
  test("stops and reports when recognition never emits end", async () => {
    vi.useFakeTimers();
    FakeRecognition.neverEnds = true;
    const onError = vi.fn();
    const adapter = createBrowserDictationPort({ recognition: FakeRecognition, onError });
    const session = adapter.listen();
    const recognition = FakeRecognition.instances[0];
    if (!recognition) throw new Error("The recognition instance was not created.");

    const stop = session.stop();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));

    await expect(stop).resolves.toBeUndefined();
    expect(recognition.abortCalls).toBe(1);
    expect(session.status).toEqual({ type: "ended", reason: "error" });
    expect(onError).toHaveBeenCalledWith("Dictation could not stop.");
  });

  test("assistant-ui inserts final speech into U2's draft and never submits it", async () => {
    const { controller, scope, store } = await draftWithText("Saved draft");
    const run = vi.fn();
    const dictation = createBrowserDictationPort({ recognition: FakeRecognition });
    render(<RuntimeHarness adapter={dictation} controller={controller} mode="toggle" run={run} />);
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.value).toBe("Saved draft"));

    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    const recognition = FakeRecognition.instances[0];
    if (!recognition) throw new Error("The recognition instance was not created.");
    recognition.emitStart();
    recognition.emitResult("partial words", false);
    recognition.emitResult("final words", true);

    await waitFor(() => expect(controller.getSnapshot().text).toBe("Saved draft final words"));
    expect(input.value).toBe("Saved draft final words");
    expect(run).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    await controller.flush();
    expect(store.text(scope)).toBe("Saved draft final words");
    expect(run).not.toHaveBeenCalled();
  });
  test("shows starting until the recognition session is live", async () => {
    const { controller } = await draftWithText("");
    const adapter = createBrowserDictationPort({ recognition: FakeRecognition });
    render(
      <RuntimeHarness
        adapter={adapter}
        controller={controller}
        mode="toggle"
        run={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    expect(screen.getByRole("button", { name: "Starting dictation" })).toBeTruthy();
    const recognition = FakeRecognition.instances[0];
    if (!recognition) throw new Error("The recognition instance was not created.");
    recognition.emitStart();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stop dictation" })).toBeTruthy(),
    );
  });

  test("a recognition failure keeps finalized words and restores only the interim suffix", async () => {
    const { controller, scope, store } = await draftWithText("Keep this draft");
    const run = vi.fn();
    const dictation = createBrowserDictationPort({ recognition: FakeRecognition });
    render(<RuntimeHarness adapter={dictation} controller={controller} mode="toggle" run={run} />);
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.value).toBe("Keep this draft"));

    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    const recognition = FakeRecognition.instances[0];
    if (!recognition) throw new Error("The recognition instance was not created.");
    recognition.emitStart();
    recognition.emitResult("final words", true);
    await waitFor(() => expect(input.value).toBe("Keep this draft final words"));
    recognition.emitResult("interim words", false);
    await waitFor(() => expect(input.value).toBe("Keep this draft final words interim words"));
    recognition.emitError("not-allowed");

    await waitFor(() => expect(controller.getSnapshot().text).toBe("Keep this draft final words"));
    expect(input.value).toBe("Keep this draft final words");
    expect(screen.getByRole("alert").textContent).toBe("Microphone access was denied.");
    expect(run).not.toHaveBeenCalled();
    await controller.flush();
    expect(store.text(scope)).toBe("Keep this draft final words");
  });
  test("resets ownership after a normal end and reports the next error only on its owner", async () => {
    const { controller } = await draftWithText("");
    const adapter = createBrowserDictationPort({ recognition: FakeRecognition });
    render(
      <RuntimeHarness
        adapter={adapter}
        controller={controller}
        mode="toggle"
        secondMode="push-to-talk"
        run={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    const firstRecognition = FakeRecognition.instances[0];
    if (!firstRecognition) throw new Error("The first recognition instance was not created.");
    firstRecognition.emitStart();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stop dictation" })).toBeTruthy(),
    );
    firstRecognition.onend?.(new Event("end"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Start dictation" }).getAttribute("aria-pressed"),
      ).toBe("false"),
    );

    const push = screen.getByRole("button", { name: "Hold to dictate" });
    fireEvent.keyDown(push, { key: " ", repeat: false });
    const secondRecognition = FakeRecognition.instances[1];
    if (!secondRecognition) throw new Error("The second recognition instance was not created.");
    secondRecognition.emitStart();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Hold to dictate" }).textContent).toContain(
        "Listening",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Start dictation" }).getAttribute("aria-pressed"),
    ).toBe("false");
    secondRecognition.emitError("not-allowed");
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
    expect(screen.getByRole("alert").textContent).toBe("Microphone access was denied.");
  });

  test("a parent rerender with a new error callback does not stop held dictation", async () => {
    const { controller } = await draftWithText("");
    const adapter = createBrowserDictationPort({ recognition: FakeRecognition });
    const run = vi.fn();
    const view = render(
      <RuntimeHarness
        adapter={adapter}
        controller={controller}
        mode="push-to-talk"
        onError={() => undefined}
        run={run}
      />,
    );
    const hold = screen.getByRole("button", { name: "Hold to dictate" });
    fireEvent.pointerDown(hold, { button: 0, isPrimary: true, pointerId: 1 });
    const recognition = FakeRecognition.instances[0];
    if (!recognition) throw new Error("The recognition instance was not created.");
    view.rerender(
      <RuntimeHarness
        adapter={adapter}
        controller={controller}
        mode="push-to-talk"
        onError={() => undefined}
        run={run}
      />,
    );
    const heldButton = screen.getByRole("button", {
      name: /Hold to dictate|Starting dictation|Listening/,
    });
    expect(recognition.stopCalls).toBe(0);
    fireEvent.pointerUp(heldButton, { button: 0, isPrimary: true, pointerId: 1 });
    expect(recognition.stopCalls).toBe(1);
  });

  test("push-to-talk ignores repeat, modifier and IME keys, and stops on release", async () => {
    const { controller } = await draftWithText("");
    const run = vi.fn();
    const adapter = createBrowserDictationPort({ recognition: FakeRecognition });
    render(
      <RuntimeHarness adapter={adapter} controller={controller} mode="push-to-talk" run={run} />,
    );
    const hold = screen.getByRole("button", { name: "Hold to dictate" });

    fireEvent.keyDown(hold, { key: " ", repeat: true });
    fireEvent.keyDown(hold, { key: " ", ctrlKey: true });
    fireEvent.keyDown(hold, { key: " ", isComposing: true });
    expect(FakeRecognition.instances).toHaveLength(0);

    fireEvent.keyDown(hold, { key: " ", repeat: false });
    fireEvent.keyDown(hold, { key: " ", repeat: true });
    expect(FakeRecognition.instances).toHaveLength(1);
    const recognition = FakeRecognition.instances[0];
    if (!recognition) throw new Error("The recognition instance was not created.");
    fireEvent.keyUp(hold, { key: " " });
    expect(recognition.stopCalls).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });
});
