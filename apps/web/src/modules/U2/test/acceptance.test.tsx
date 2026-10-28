import type { CreateAttachment, ThreadUserMessagePart } from "@assistant-ui/react";
import {
  AssistantRuntimeProvider,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type {
  AttachmentRef,
  CapabilityMap,
  ChatSessionRequest,
  Draft,
  DraftScope,
  Revision,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure, checkScrubbed } from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryPreferenceStore, ShortcutRegistry } from "../../../shortcuts/registry";
import type { PromptIntent } from "../../R0/runtime/runtime";
import { OmpRuntimeController } from "../../R0/runtime/runtime";
import { OmpRuntimeStore } from "../../R0/store/store";
import { type AttachmentBlobStore, AttachmentManager, type StoredAttachment } from "../attachments";
import { ComposerSurface } from "../composer";
import type { SubmitPolicy, SubmitPolicyInput } from "../contract";
import { U2Descriptors } from "../descriptors";
import {
  DraftController,
  type DraftLifecycleTarget,
  type DraftStoreAdapter,
  type DraftTimer,
} from "../drafts";
import { EXTERNAL_EDITOR_CAPABILITY, ExternalEditorController } from "../external-editor";
import { U2_STATE_FIXTURES, type U2StateFixture } from "../fixtures";
import { ModeIndicator } from "../modes";
import { ComposerShortcutScope, U2_EXTERNAL_EDITOR_SHORTCUT } from "../shortcuts";

afterEach(() => cleanup());

const pythonUnavailableReason = "Python mode is not available in this version of omp.";
const capabilities: CapabilityMap = {
  "omp.cmd.prompt": { state: "available", via: "omp" },
  "omp.cmd.bash": { state: "available", via: "omp" },
  "omp.cmd.abort": { state: "available", via: "omp" },
  "omp.cmd.abort_bash": { state: "available", via: "omp" },
  "upstream.python-mode": {
    state: "unavailable",
    via: "upstream",
    detail: pythonUnavailableReason,
  },
};

interface AcceptanceRuntime {
  readonly store: OmpRuntimeStore;
  readonly controller: OmpRuntimeController;
  readonly sends: unknown[];
}

function createRuntime(
  fixture: U2StateFixture = U2_STATE_FIXTURES.idle,
  options: {
    readonly beforeSend?: () => Promise<void>;
    readonly runtimeCapabilities?: CapabilityMap;
  } = {},
): AcceptanceRuntime {
  const store = new OmpRuntimeStore({ threadId: "u2-cc6-thread" as ThreadId });
  store.applySessionState(fixture.getState);
  const sends: unknown[] = [];
  const send: ChatSessionRequest = async (args) => {
    sends.push(args);
    await options.beforeSend?.();
    return undefined as never;
  };
  const controller = new OmpRuntimeController({
    store,
    send,
    capabilities: options.runtimeCapabilities ?? capabilities,
  });
  return { store, controller, sends };
}

function RuntimeBridge({
  controller,
  attachments,
  children,
}: PropsWithChildren<{
  readonly controller: OmpRuntimeController;
  readonly attachments?: AttachmentManager;
}>) {
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  );
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const adapter = useMemo(() => {
    const base = controller.createAdapter(snapshot);
    return attachments === undefined ? base : { ...base, adapters: { attachments } };
  }, [attachments, controller, snapshot]);
  const runtime = useExternalStoreRuntime(adapter);
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

interface ComposerOptions {
  readonly attachments?: AttachmentManager;
  readonly policy?: SubmitPolicy;
  readonly submitPrompt?: (intent: PromptIntent) => Promise<void>;
  readonly children?: ReactNode;
}

function renderComposer(runtime: AcceptanceRuntime, options: ComposerOptions = {}) {
  return render(
    <RuntimeBridge controller={runtime.controller} attachments={options.attachments}>
      <ComposerSurface
        autoFocus={false}
        cancel={() => runtime.controller.cancel()}
        policy={options.policy}
        submitPrompt={options.submitPrompt ?? ((intent) => runtime.controller.submitPrompt(intent))}
      >
        {options.children}
      </ComposerSurface>
    </RuntimeBridge>,
  );
}

class MemoryAttachmentBlobs implements AttachmentBlobStore {
  public readonly values = new Map<string, StoredAttachment>();

  public async put({
    id,
    file,
  }: {
    readonly id: string;
    readonly file: File;
  }): Promise<StoredAttachment> {
    const uri = `attachment://${id}`;
    const ref: AttachmentRef = {
      id,
      name: file.name,
      mediaType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      uri,
    };
    const content: ThreadUserMessagePart[] = file.type.startsWith("image/")
      ? [{ type: "image", image: "data:image/png;base64,AA==" }]
      : [{ type: "file", data: uri, mimeType: ref.mediaType }];
    const stored = { ref, content };
    this.values.set(id, stored);
    return stored;
  }

  public async get(ref: AttachmentRef): Promise<StoredAttachment> {
    const stored = this.values.get(ref.id);
    if (stored === undefined) {
      throw new AppFailure({
        code: "not_found",
        message: "Attachment is unavailable",
        retryable: false,
      });
    }
    return stored;
  }

  public async delete(ref: AttachmentRef): Promise<void> {
    this.values.delete(ref.id);
  }
}
function ComposerAttachmentSeed({ attachment }: { readonly attachment: CreateAttachment }) {
  const composer = useAui().composer;
  useEffect(() => {
    void composer.addAttachment(attachment);
  }, [attachment, composer]);
  return null;
}

function ComposerAttachmentProbe() {
  const attachments = useAuiState((state) => state.composer.attachments);
  return (
    <span data-testid="u2-composer-attachments">
      {attachments
        .filter((attachment) => attachment.status.type === "complete")
        .map((attachment) => attachment.name)
        .join(",")}
    </span>
  );
}

function ComposerTextInjector({ text }: { readonly text: string }) {
  const composer = useAui().composer;
  return (
    <button onClick={() => composer.setText(text)} type="button">
      Inject text
    </button>
  );
}

class MemoryDraftStore implements DraftStoreAdapter {
  public value: Draft | null = null;
  private revision = 0;

  public async get({
    scope,
  }: {
    readonly scope: DraftScope;
  }): Promise<{ readonly draft: Draft | null }> {
    return { draft: this.sameScope(this.value?.scope, scope) ? this.value : null };
  }

  public async save(args: Parameters<DraftStoreAdapter["save"]>[0]): Promise<Draft> {
    const existing = this.sameScope(this.value?.scope, args.scope) ? this.value : null;
    if ((existing?.revision ?? null) !== args.expectedRevision) {
      throw new AppFailure({
        code: "conflict",
        message: "Draft changed while saving",
        retryable: true,
      });
    }
    this.revision += 1;
    this.value = {
      scope: args.scope,
      ...args.draft,
      revision: `u2-revision-${this.revision}` as Revision,
      updatedAt: "2026-10-06T00:00:00.000Z",
    };
    return this.value;
  }

  public async clear(
    args: Parameters<DraftStoreAdapter["clear"]>[0],
  ): Promise<{ readonly cleared: boolean; readonly revision: Revision | null }> {
    const existing = this.sameScope(this.value?.scope, args.scope) ? this.value : null;
    if ((existing?.revision ?? null) !== args.expectedRevision) {
      return { cleared: false, revision: existing?.revision ?? null };
    }
    this.value = null;
    return { cleared: true, revision: null };
  }

  private sameScope(left: DraftScope | undefined, right: DraftScope): boolean {
    if (left === undefined || left.kind !== right.kind) return false;
    return left.kind === "thread" && right.kind === "thread"
      ? left.threadId === right.threadId
      : left.kind === "folder" && right.kind === "folder" && left.folder === right.folder;
  }
}

class MemoryLifecycle implements DraftLifecycleTarget {
  public document = { visibilityState: "visible" };
  private readonly listeners = new Map<"pagehide" | "visibilitychange", Set<() => void>>();

  public addEventListener(type: "visibilitychange" | "pagehide", listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: "visibilitychange" | "pagehide", listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  public emit(type: "visibilitychange" | "pagehide"): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

class ManualDraftTimer implements DraftTimer {
  private nextId = 0;
  private readonly tasks = new Map<
    number,
    { readonly callback: () => void; readonly delay: number }
  >();
  public readonly scheduledDelays: number[] = [];

  public setTimeout(callback: () => void, delay: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { callback, delay });
    this.scheduledDelays.push(delay);
    return id;
  }

  public clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  public runDue(delay: number): void {
    for (const [id, task] of this.tasks) {
      if (task.delay > delay) continue;
      this.tasks.delete(id);
      task.callback();
    }
  }
}

function newDraftController(
  store: DraftStoreAdapter,
  lifecycle: DraftLifecycleTarget,
  timers: DraftTimer,
): DraftController {
  return new DraftController({
    store,
    scope: { kind: "thread", threadId: "u2-cc6-thread" as ThreadId },
    lifecycle,
    timers,
    now: () => new Date("2026-10-06T00:00:00.000Z"),
  });
}

function ExternalEditorShortcutScope({
  editor,
  registry,
  children,
}: PropsWithChildren<{
  readonly editor: ExternalEditorController;
  readonly registry: ShortcutRegistry;
}>) {
  const composer = useAui().composer;
  const text = useAuiState((state) => state.composer.text);
  const actions = useMemo(
    () => ({
      externalEditor: async () => {
        composer.setText(await editor.open(text));
      },
    }),
    [composer, editor, text],
  );
  return (
    <ComposerShortcutScope registry={registry} actions={actions} scope="composer-input">
      {children}
    </ComposerShortcutScope>
  );
}

describe("U2 composer CC6 acceptance", () => {
  test("normalizes realistic idle and streaming get_state fixtures through R0", () => {
    for (const fixture of Object.values(U2_STATE_FIXTURES)) {
      const store = new OmpRuntimeStore({ threadId: "u2-cc6-thread" as ThreadId });
      store.applySessionState(fixture.getState);
      const snapshot = store.getSnapshot();

      expect({
        process: snapshot.process,
        prompt: snapshot.prompt,
        queue: snapshot.queue,
        session: snapshot.session,
      }).toEqual(fixture.snapshot);
    }
    expect(U2_STATE_FIXTURES.idle.snapshot.session.model?.name).toBe("Fake Model");
    expect(U2_STATE_FIXTURES.streaming.snapshot.queue).toMatchObject({
      steering: ["check the failing assertion"],
      followUp: ["run tests"],
    });
    expect(checkScrubbed(JSON.stringify(U2_STATE_FIXTURES))).toEqual([]);
  });

  test("submits one prompt from the idle composer and clears after admission", async () => {
    const runtime = createRuntime();
    const submitted: PromptIntent[] = [];
    const view = renderComposer(runtime, {
      submitPrompt: async (intent) => {
        submitted.push(intent);
        await runtime.controller.submitPrompt(intent);
      },
    });
    const input = screen.getByRole("textbox", { name: "Message input" });

    fireEvent.change(input, { target: { value: "Summarize the current session" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(runtime.sends).toHaveLength(1));
    expect(submitted[0]).toMatchObject({
      mode: "prompt",
      text: "Summarize the current session",
      delivery: "new",
    });
    expect(runtime.sends[0]).toMatchObject({
      method: "prompt",
      params: { text: "Summarize the current session" },
    });
    expect((input as HTMLTextAreaElement).value).toBe("");
    view.unmount();
  });

  test("chooses steer by default and lets an explicit policy choose follow-up for a live turn", async () => {
    const streaming = createRuntime(U2_STATE_FIXTURES.streaming);
    const steered: PromptIntent[] = [];
    const first = renderComposer(streaming, {
      submitPrompt: async (intent) => {
        steered.push(intent);
        await streaming.controller.submitPrompt(intent);
      },
    });
    expect(screen.getByPlaceholderText("Enter steers · Ctrl+Enter queues")).toBeTruthy();
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "Inspect the assertion" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(streaming.sends).toHaveLength(1));
    expect(steered[0]?.delivery).toBe("steer");
    expect(streaming.sends[0]).toMatchObject({
      method: "prompt",
      params: { text: "Inspect the assertion", streamingBehavior: "steer" },
    });
    first.unmount();

    const followedUp: PromptIntent[] = [];
    const followUpPolicy: SubmitPolicy = (input: SubmitPolicyInput) => {
      expect(input.isStreaming).toBe(true);
      return { delivery: "followUp" as const };
    };
    renderComposer(streaming, {
      policy: followUpPolicy,
      submitPrompt: async (intent) => {
        followedUp.push(intent);
        await streaming.controller.submitPrompt(intent);
      },
    });
    const followUpInput = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(followUpInput, { target: { value: "Run the test suite" } });
    fireEvent.keyDown(followUpInput, { key: "Enter" });

    await waitFor(() => expect(streaming.sends).toHaveLength(2));
    expect(followedUp[0]?.delivery).toBe("followUp");
    expect(streaming.sends[1]).toMatchObject({
      method: "prompt",
      params: { text: "Run the test suite", streamingBehavior: "followUp" },
    });
  });

  test("guards duplicate submission while admission is pending", async () => {
    let releaseAdmission!: () => void;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const runtime = createRuntime(U2_STATE_FIXTURES.idle, { beforeSend: () => admission });
    const view = renderComposer(runtime);
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "Submit exactly once" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(runtime.sends).toHaveLength(1));

    const form = view.container.querySelector("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    expect(runtime.sends).toHaveLength(1);

    await act(async () => {
      releaseAdmission();
      await admission;
    });
    view.unmount();
  });

  test("keeps text that arrives while a send waits for admission, and clears the composer when none did", async () => {
    let releaseAdmission!: () => void;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const runtime = createRuntime(U2_STATE_FIXTURES.idle, { beforeSend: () => admission });
    const view = renderComposer(runtime, {
      children: <ComposerTextInjector text="Something newer" />,
    });
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "Sent text" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(runtime.sends).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Inject text" }));
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe("Something newer"));

    await act(async () => {
      releaseAdmission();
      await admission;
    });

    await waitFor(() => expect(runtime.sends).toHaveLength(1));
    expect((input as HTMLTextAreaElement).value).toBe("Something newer");
    view.unmount();

    const plain = createRuntime(U2_STATE_FIXTURES.idle);
    const plainView = renderComposer(plain);
    const plainInput = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(plainInput, { target: { value: "Sent and gone" } });
    fireEvent.keyDown(plainInput, { key: "Enter" });
    await waitFor(() => expect(plain.sends).toHaveLength(1));
    await waitFor(() => expect((plainInput as HTMLTextAreaElement).value).toBe(""));
    plainView.unmount();
  });

  test("keeps the exact composer text and attachment after an admission failure", async () => {
    const runtime = createRuntime(U2_STATE_FIXTURES.idle, {
      beforeSend: async () => {
        throw new AppFailure({
          code: "unavailable",
          message: "Connection closed before admission",
          retryable: true,
        });
      },
    });
    const blobs = new MemoryAttachmentBlobs();
    const manager = new AttachmentManager({ blobStore: blobs, idPrefix: "u2-failed-send" });
    const submitted: PromptIntent[] = [];
    const attachment = {
      id: "u2-failed-send-image",
      type: "image",
      name: "failed-send.png",
      contentType: "image/png",
      content: [{ type: "image", image: "data:image/png;base64,AA==" }],
    } satisfies CreateAttachment;
    const view = renderComposer(runtime, {
      attachments: manager,
      submitPrompt: async (intent) => {
        submitted.push(intent);
        await runtime.controller.submitPrompt(intent);
      },
      children: (
        <>
          <ComposerAttachmentSeed attachment={attachment} />
          <ComposerAttachmentProbe />
        </>
      ),
    });
    const input = screen.getByRole("textbox", { name: "Message input" });
    const exactDraft = "Keep this draft: inspect <WORKSPACE>/src/app.ts";
    await waitFor(() =>
      expect(screen.getByTestId("u2-composer-attachments").textContent).toContain(
        "failed-send.png",
      ),
    );

    fireEvent.change(input, { target: { value: exactDraft } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Connection closed before admission",
    );
    expect((input as HTMLTextAreaElement).value).toBe(exactDraft);
    expect(runtime.sends).toHaveLength(1);
    expect(submitted[0]?.attachmentRefs?.[0]).toMatchObject({
      id: "u2-failed-send-image",
      name: "failed-send.png",
      mediaType: "image/png",
    });
    expect(submitted[0]?.images?.[0]).toMatchObject({
      type: "image",
      data: "AA==",
      mimeType: "image/png",
    });
    view.unmount();
  });

  test("submits an image-only composer attachment with its durable reference", async () => {
    const runtime = createRuntime();
    const blobs = new MemoryAttachmentBlobs();
    const manager = new AttachmentManager({ blobStore: blobs, idPrefix: "u2-acceptance" });
    const submitted: PromptIntent[] = [];
    const attachment = {
      id: "u2-composer-image",
      type: "image",
      name: "diagram.png",
      contentType: "image/png",
      content: [{ type: "image", image: "data:image/png;base64,AA==" }],
    } satisfies CreateAttachment;
    const view = renderComposer(runtime, {
      attachments: manager,
      submitPrompt: async (intent) => {
        submitted.push(intent);
        await runtime.controller.submitPrompt(intent);
      },
      children: (
        <>
          <ComposerAttachmentSeed attachment={attachment} />
          <ComposerAttachmentProbe />
        </>
      ),
    });

    await waitFor(() =>
      expect(screen.getByTestId("u2-composer-attachments").textContent).toContain("diagram.png"),
    );
    const sendButton = screen.getByRole("button", { name: "Send message" });
    expect((sendButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(sendButton);
    await waitFor(() => expect(runtime.sends).toHaveLength(1));

    expect(submitted[0]?.text).toBe("");
    expect(submitted[0]?.attachmentRefs?.[0]).toMatchObject({
      id: "u2-composer-image",
      name: "diagram.png",
      mediaType: "image/png",
    });
    expect(submitted[0]?.images?.[0]).toMatchObject({
      type: "image",
      data: "AA==",
      mimeType: "image/png",
    });
    expect(runtime.sends[0]).toMatchObject({
      method: "prompt",
      params: {
        text: "",
        images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      },
    });
    view.unmount();
  });

  test("autosaves, flushes on hidden, and restores text plus attachment references after reload", async () => {
    const store = new MemoryDraftStore();
    const blobs = new MemoryAttachmentBlobs();
    const manager = new AttachmentManager({ blobStore: blobs, idPrefix: "u2-draft" });
    const pending = await manager.add({
      file: new File(["attachment payload stays host-side"], "notes.txt", { type: "text/plain" }),
    });
    await manager.send(pending);
    const refs = manager.toDraftRefs();
    const lifecycle = new MemoryLifecycle();
    const timers = new ManualDraftTimer();
    const first = newDraftController(store, lifecycle, timers);

    await first.load();
    first.setDraft("Autosaved composer text", refs);
    expect(timers.scheduledDelays).toContain(1_000);
    expect(timers.scheduledDelays).toContain(5_000);
    timers.runDue(1_000);
    await waitFor(() => expect(store.value?.text).toBe("Autosaved composer text"));
    first.setDraft("Latest text before ceiling", refs);
    timers.runDue(5_000);
    await waitFor(() => expect(store.value?.text).toBe("Latest text before ceiling"));

    first.setDraft("Latest text flushed when hidden", refs);
    lifecycle.document.visibilityState = "hidden";
    lifecycle.emit("visibilitychange");
    await waitFor(() => expect(store.value?.text).toBe("Latest text flushed when hidden"));
    expect(JSON.stringify(store.value)).not.toContain("attachment payload stays host-side");
    await first.dispose();

    const restoredManager = new AttachmentManager({ blobStore: blobs, idPrefix: "u2-reload" });
    const restored = newDraftController(store, new MemoryLifecycle(), new ManualDraftTimer());
    const restoredDraft = await restored.load();
    await restoredManager.restore(restoredDraft.attachments);

    expect(restoredDraft.text).toBe("Latest text flushed when hidden");
    expect(restoredDraft.attachments).toEqual(refs);
    expect(restoredManager.toDraftRefs()).toEqual(refs);
    expect(restoredManager.getState().complete[0]?.name).toBe("notes.txt");
    await restored.dispose();
  });

  test("routes Bash through R0 and keeps Python's unavailable reason in its tooltip", async () => {
    const runtime = createRuntime();
    const submittedModes: PromptIntent[] = [];
    const submitToR0 = async (intent: PromptIntent): Promise<void> => {
      submittedModes.push(intent);
      await runtime.controller.submitPrompt(intent);
    };
    const view = renderComposer(runtime, {
      submitPrompt: submitToR0,
      children: <ModeIndicator capabilities={capabilities} />,
    });
    const input = screen.getByRole("textbox", { name: "Message input" });
    const python = screen.getByRole("button", { name: "Python" });
    expect((python as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTitle(pythonUnavailableReason)).toBeTruthy();
    expect(screen.queryByText(pythonUnavailableReason, { exact: true })).toBeNull();

    fireEvent.change(input, { target: { value: "$ print(1)" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toContain(pythonUnavailableReason);
    expect((input as HTMLTextAreaElement).value).toBe("$ print(1)");
    expect(runtime.sends).toHaveLength(0);

    fireEvent.change(input, { target: { value: "! printf hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(runtime.sends).toHaveLength(1));
    expect(submittedModes[0]).toMatchObject({
      mode: "bash",
      text: "printf hello",
      delivery: "new",
    });
    expect(runtime.sends[0]).toMatchObject({
      method: "bash",
      params: { command: "printf hello" },
    });
    view.unmount();
  });

  test("dispatches the host external editor from Ctrl+G without losing composer focus", async () => {
    const runtime = createRuntime();
    const opened: string[] = [];
    const editor = new ExternalEditorController({
      adapter: {
        open: async ({ initialText }) => {
          opened.push(initialText);
          return `${initialText}\nEdited outside the app`;
        },
      },
      capabilities: { [EXTERNAL_EDITOR_CAPABILITY]: { state: "available", via: "host" } },
    });
    const registry = new ShortcutRegistry([...U2Descriptors, U2_EXTERNAL_EDITOR_SHORTCUT], {
      preferenceStore: new MemoryPreferenceStore(),
    });
    const view = render(
      <RuntimeBridge controller={runtime.controller}>
        <ExternalEditorShortcutScope editor={editor} registry={registry}>
          <ComposerSurface
            autoFocus={false}
            cancel={() => runtime.controller.cancel()}
            submitPrompt={(intent) => runtime.controller.submitPrompt(intent)}
          />
        </ExternalEditorShortcutScope>
      </RuntimeBridge>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "Working draft" } });
    input.focus();
    fireEvent.keyDown(input, { key: "g", ctrlKey: true });

    await waitFor(() =>
      expect((input as HTMLTextAreaElement).value).toBe("Working draft\nEdited outside the app"),
    );
    expect(opened).toEqual(["Working draft"]);
    expect(document.activeElement).toBe(input);
    expect(runtime.sends).toHaveLength(0);
    view.unmount();
  });
});
