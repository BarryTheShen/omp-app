import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { CapabilityMap } from "@omp-app/contracts";
import { ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ComposerSurface } from "../../U2/composer/composer";
import { LocalComposerSlot } from "../local/trigger-slot";
import { MentionComposerSlot } from "../mentions/trigger-slot";
import { createSlashCommandProvider, type SlashCommandProvider } from "./provider";
import { fakeSlashClient, REAL_COMMAND_LIST } from "./test-support";
import { SlashComposerSlot, SlashTriggerSlot } from "./trigger-slot";

function RuntimeHarness({
  children,
  running = false,
}: {
  readonly children: ReactNode;
  readonly running?: boolean;
}) {
  const runtime = useExternalStoreRuntime({
    messages: [] as readonly ThreadMessage[],
    isRunning: running,
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

afterEach(() => cleanup());

const threadId = ThreadId.parse("thread-d23-trigger");

function providerWith(capabilities: CapabilityMap): SlashCommandProvider {
  const fake = fakeSlashClient();
  return createSlashCommandProvider({
    client: fake.client,
    threadId,
    capabilities: () => capabilities,
  });
}

const available: CapabilityMap = {
  "omp.cmd.get_available_commands": { state: "available", via: "rpc" },
};

/**
 * The list's first answer follows a 60 ms debounce and a render. A loaded worker can take longer than RTL's 1 s default
 * (issue 2271), so these waits allow 5 s. They still end on that event, never on a timer.
 */
const LIST_ANSWER_WAIT = { timeout: 5000 } as const;

describe("D2.3 SlashTriggerSlot", () => {
  test("opens omp's commands with their source, description and argument hint, and inserts one", async () => {
    const provider = providerWith(available);
    const selected = vi.fn();
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={selected}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );

    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "/us" } });
    (input as HTMLTextAreaElement).setSelectionRange(3, 3);
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("/usage")).toBeTruthy());
    expect(screen.getByText("Show token usage")).toBeTruthy();
    expect(screen.getAllByText("Built-in").length).toBeGreaterThan(0);
    expect(screen.getByText(/Arguments: \[show\|reset/)).toBeTruthy();
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).not.toBeNull());
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(selected).toHaveBeenCalledTimes(1));
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: "slash:builtin:usage" }));
    expect((input as HTMLTextAreaElement).value).toBe("/usage ");
    provider.dispose();
  });

  test("with omp's list unavailable, the app's command is still offered and the reason is shown plainly", async () => {
    const provider = createSlashCommandProvider({
      client: fakeSlashClient().client,
      threadId,
      capabilities: () => ({}),
      appCommands: () => [{ name: "new", description: "Start a new chat", run: async () => ({}) }],
    });
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );

    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "/" } });
    (input as HTMLTextAreaElement).setSelectionRange(1, 1);
    await waitFor(() => expect(screen.getByText("/new")).toBeTruthy());
    expect(screen.getByText("Slash commands are unavailable in this omp session.")).toBeTruthy();
    provider.dispose();
  });

  test("Escape closes the command list without changing the message", async () => {
    const provider = providerWith(available);
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );

    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "/usa" } });
    (input as HTMLTextAreaElement).setSelectionRange(4, 4);
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect((input as HTMLTextAreaElement).value).toBe("/usa");
    provider.dispose();
  });

  test("while a turn runs, Escape dismisses the command list and the turn keeps running", async () => {
    const provider = providerWith(available);
    const cancel = vi.fn(async () => undefined);
    render(
      <RuntimeHarness running>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={cancel} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );

    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "/usa" } });
    (input as HTMLTextAreaElement).setSelectionRange(4, 4);
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(cancel).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value).toBe("/usa");

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    provider.dispose();
  });

  test("a message that does not start with the slash opens no command list", async () => {
    const provider = providerWith(available);
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );

    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: " /usage" } });
    (input as HTMLTextAreaElement).setSelectionRange(7, 7);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.queryByRole("listbox")).toBeNull();
    provider.dispose();
  });

  /** The message box as a textarea: the slash tests type into it and read its selection and value. */
  function composerInput(): HTMLTextAreaElement {
    const input = screen.getByRole("textbox", { name: "Message input" });
    if (!(input instanceof HTMLTextAreaElement))
      throw new Error("the message box is not a textarea");
    return input;
  }

  /** An app command with no arguments, so choosing it runs it. */
  function loginProvider(): SlashCommandProvider {
    const provider = createSlashCommandProvider({
      client: fakeSlashClient().client,
      threadId,
      capabilities: () => available,
      appCommands: () => [{ name: "login", description: "Sign in", run: async () => ({}) }],
    });
    return provider;
  }

  /** Lets the work that a key press queued in microtasks run: a macrotask runs only after every queued microtask. */
  function settle(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    return promise;
  }

  test("a command with no arguments runs when it is chosen by Enter, and the list goes quiet", async () => {
    const provider = loginProvider();
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );
    const input = composerInput();
    fireEvent.change(input, { target: { value: "/login" } });
    input.setSelectionRange(6, 6);
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).not.toBeNull());
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("option")).toBeNull();
    provider.dispose();
  });

  test("a command with no arguments runs when a click chooses it", async () => {
    const provider = loginProvider();
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );
    const input = composerInput();
    fireEvent.change(input, { target: { value: "/login" } });
    input.setSelectionRange(6, 6);
    fireEvent.click(await screen.findByRole("option", { name: /^\/login/ }));
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(1));
    provider.dispose();
  });

  test("Tab completes a command with no arguments without sending it, and Enter then sends it", async () => {
    const provider = loginProvider();
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );
    const input = composerInput();
    fireEvent.change(input, { target: { value: "/login" } });
    input.setSelectionRange(6, 6);
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).not.toBeNull());
    fireEvent.keyDown(input, { key: "Tab" });
    await waitFor(() => expect(input.value).toBe("/login "));
    // A send would run after a microtask: let the queued work run, then check that nothing was sent.
    await settle();
    expect(submitPrompt).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(1));
    provider.dispose();
  });

  test("Tab, then Enter at once: the command is sent once", async () => {
    const provider = loginProvider();
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );
    const input = composerInput();
    fireEvent.change(input, { target: { value: "/login" } });
    input.setSelectionRange(6, 6);
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).not.toBeNull());
    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(1));
    await settle();
    expect(submitPrompt).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  test("after Tab completes a command, rows that a search answers for the completed text do not reopen the list", async () => {
    const base = loginProvider();
    // Every search answers with the /login row: a search for the completed text would reopen the list.
    const provider: SlashCommandProvider = {
      ...base,
      searchTyped: () => base.searchTyped("/login"),
    };
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );
    const input = composerInput();
    fireEvent.change(input, { target: { value: "/login" } });
    input.setSelectionRange(6, 6);
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).not.toBeNull());
    fireEvent.keyDown(input, { key: "Tab" });
    await waitFor(() => expect(input.value).toBe("/login "));
    await settle();
    expect(screen.queryByRole("option")).toBeNull();
    expect(submitPrompt).not.toHaveBeenCalled();
    provider.dispose();
  });

  test("after Tab completes a command, one typed character searches again and the list comes back", async () => {
    const base = loginProvider();
    const searched: string[] = [];
    const submitPrompt = vi.fn(async () => undefined);
    const provider: SlashCommandProvider = {
      ...base,
      searchTyped: (query) => {
        searched.push(query);
        return base.searchTyped("/login");
      },
    };
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );
    const input = composerInput();
    fireEvent.change(input, { target: { value: "/login" } });
    input.setSelectionRange(6, 6);
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).not.toBeNull());
    fireEvent.keyDown(input, { key: "Tab" });
    await waitFor(() => expect(input.value).toBe("/login "));
    await settle();
    expect(submitPrompt).not.toHaveBeenCalled();
    const searchesBeforeTyping = searched.length;
    fireEvent.change(input, { target: { value: "/login x" } });
    input.setSelectionRange(8, 8);
    // The typed text searches again, and the list comes back with the row that the search answers with.
    await waitFor(() => expect(searched.length).toBeGreaterThan(searchesBeforeTyping));
    await screen.findByRole("option", { name: /^\/login/ });
    provider.dispose();
  });

  test("a command with arguments inserts its name and waits for the arguments: Enter does not send it", async () => {
    const provider = providerWith(available);
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );
    const input = composerInput();
    fireEvent.change(input, { target: { value: "/us" } });
    input.setSelectionRange(3, 3);
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).not.toBeNull());
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input.value).toBe("/usage "));
    expect(submitPrompt).not.toHaveBeenCalled();
    provider.dispose();
  });

  test("an Enter kept while the list loads runs the command whose exact name was typed", async () => {
    const release = Promise.withResolvers<void>();
    let searching = false;
    const base = loginProvider();
    const provider: SlashCommandProvider = {
      ...base,
      searchTyped: (query) => {
        searching = true;
        return release.promise.then(() => base.searchTyped(query));
      },
    };
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );
    const input = composerInput();
    fireEvent.change(input, { target: { value: "/login" } });
    input.setSelectionRange(6, 6);
    await waitFor(() => expect(searching).toBe(true));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submitPrompt).not.toHaveBeenCalled();
    release.resolve();
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(1));
    base.dispose();
  });

  test("an Enter kept while the list loads is dropped when the typed text is only a prefix of the first command", async () => {
    const release = Promise.withResolvers<void>();
    let searching = false;
    const base = loginProvider();
    const provider: SlashCommandProvider = {
      ...base,
      searchTyped: (query) => {
        searching = true;
        return release.promise.then(() => base.searchTyped(query));
      },
    };
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );
    const input = composerInput();
    fireEvent.change(input, { target: { value: "/log" } });
    input.setSelectionRange(4, 4);
    await waitFor(() => expect(searching).toBe(true));
    fireEvent.keyDown(input, { key: "Enter" });
    release.resolve();
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).not.toBeNull());
    expect(submitPrompt).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(1));
    base.dispose();
  });

  test("a row fetched for earlier text is not chosen: Enter waits for the list's answer, then sends the whole command", async () => {
    // The arguments' answer is held, so the list still shows the row it fetched for `/us` when the command is typed on.
    const releaseArguments = Promise.withResolvers<void>();
    const base = providerWith(available);
    const provider: SlashCommandProvider = {
      ...base,
      searchTyped: (query) =>
        query.includes(" ")
          ? releaseArguments.promise.then(() => base.searchTyped(query))
          : base.searchTyped(query),
    };
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );
    const input = composerInput();
    fireEvent.change(input, { target: { value: "/us" } });
    input.setSelectionRange(3, 3);
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).not.toBeNull());

    fireEvent.change(input, { target: { value: "/usage fix the typo" } });
    input.setSelectionRange(19, 19);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("/usage fix the typo");
    expect(submitPrompt).not.toHaveBeenCalled();

    releaseArguments.resolve();
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(1));
    expect(submitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: "/usage fix the typo" }),
    );
    base.dispose();
  });

  test("the app's stack of composer slots: an outer slot does not choose the slash list's stale row either", async () => {
    const releaseArguments = Promise.withResolvers<void>();
    const base = providerWith(available);
    const provider: SlashCommandProvider = {
      ...base,
      searchTyped: (query) =>
        query.includes(" ")
          ? releaseArguments.promise.then(() => base.searchTyped(query))
          : base.searchTyped(query),
    };
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <ComposerPrimitive.Unstable_TriggerPopoverRoot>
          <LocalComposerSlot providers={[]} onSelect={() => undefined}>
            <MentionComposerSlot
              providers={[]}
              onSelect={() => undefined}
              notify={() => undefined}
              fail={() => undefined}
            >
              <SlashComposerSlot providers={[provider]} onSelect={() => undefined}>
                <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
              </SlashComposerSlot>
            </MentionComposerSlot>
          </LocalComposerSlot>
        </ComposerPrimitive.Unstable_TriggerPopoverRoot>
      </RuntimeHarness>,
    );
    const input = composerInput();
    fireEvent.change(input, { target: { value: "/us" } });
    input.setSelectionRange(3, 3);
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).not.toBeNull());

    fireEvent.change(input, { target: { value: "/usage fix the typo" } });
    input.setSelectionRange(19, 19);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("/usage fix the typo");
    expect(submitPrompt).not.toHaveBeenCalled();

    releaseArguments.resolve();
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(1));
    expect(submitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: "/usage fix the typo" }),
    );
    base.dispose();
  });

  test("an arrow key that moves the highlight scrolls the highlighted command into view, once per move", async () => {
    const scrolled: string[] = [];
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    const provider = providerWith(available);
    try {
      render(
        <RuntimeHarness>
          <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
            <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
          </SlashTriggerSlot>
        </RuntimeHarness>,
      );
      const input = composerInput();
      fireEvent.change(input, { target: { value: "/" } });
      input.setSelectionRange(1, 1);
      const listbox = await screen.findByRole("listbox", {}, LIST_ANSWER_WAIT);
      await waitFor(
        () => expect(listbox.getAttribute("aria-activedescendant")).not.toBeNull(),
        LIST_ANSWER_WAIT,
      );
      const first = listbox.getAttribute("aria-activedescendant");
      fireEvent.keyDown(input, { key: "ArrowDown" });
      await waitFor(() => expect(scrolled).toHaveLength(1));
      const second = listbox.getAttribute("aria-activedescendant");
      expect(second).not.toBe(first);
      expect(scrolled).toEqual([second]);
      fireEvent.keyDown(input, { key: "ArrowUp" });
      await waitFor(() => expect(scrolled).toHaveLength(2));
      expect(scrolled).toEqual([second, first]);
    } finally {
      Element.prototype.scrollIntoView = scrollIntoView;
      provider.dispose();
    }
  });

  test("a pointer move over a command moves the highlight, and the list does not scroll", async () => {
    const scrolled: string[] = [];
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    const provider = providerWith(available);
    try {
      render(
        <RuntimeHarness>
          <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
            <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
          </SlashTriggerSlot>
        </RuntimeHarness>,
      );
      const input = composerInput();
      fireEvent.change(input, { target: { value: "/" } });
      input.setSelectionRange(1, 1);
      const listbox = await screen.findByRole("listbox", {}, LIST_ANSWER_WAIT);
      await waitFor(
        () => expect(listbox.getAttribute("aria-activedescendant")).not.toBeNull(),
        LIST_ANSWER_WAIT,
      );
      const third = screen.getAllByRole("option")[2];
      if (third === undefined) throw new Error("the list has fewer than three commands");
      fireEvent.mouseMove(third);
      await waitFor(() => expect(listbox.getAttribute("aria-activedescendant")).toBe(third.id));
      expect(scrolled).toEqual([]);
    } finally {
      Element.prototype.scrollIntoView = scrollIntoView;
      provider.dispose();
    }
  });

  test("while omp's list has not answered, `/` shows a loading line: no option, no no-match text, and Enter is kept", async () => {
    const release = Promise.withResolvers<void>();
    let searching = false;
    const base = providerWith(available);
    const provider: SlashCommandProvider = {
      ...base,
      searchTyped: (query) => {
        searching = true;
        return release.promise.then(() => base.searchTyped(query));
      },
    };
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );
    const input = composerInput();
    fireEvent.change(input, { target: { value: "/us" } });
    input.setSelectionRange(3, 3);
    await waitFor(() => expect(searching).toBe(true));
    expect(screen.getByText("Loading commands…").getAttribute("role")).toBe("status");
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.queryByText("No matching commands.")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submitPrompt).not.toHaveBeenCalled();

    release.resolve();
    await waitFor(() => expect(screen.getByRole("option", { name: /^\/usage/ })).toBeTruthy());
    expect(screen.queryByText("Loading commands…")).toBeNull();
    base.dispose();
  });

  test("a list that fails to answer replaces the loading line with the reason", async () => {
    const release = Promise.withResolvers<void>();
    const provider = createSlashCommandProvider({
      client: fakeSlashClient({
        commands: () => release.promise.then(() => Promise.reject(new Error("omp refused"))),
      }).client,
      threadId,
      capabilities: () => available,
    });
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );
    const input = composerInput();
    fireEvent.change(input, { target: { value: "/us" } });
    input.setSelectionRange(3, 3);
    await waitFor(() => expect(screen.getByText("Loading commands…")).toBeTruthy());
    release.resolve();
    await waitFor(() =>
      expect(screen.getByText("Slash commands could not be loaded.")).toBeTruthy(),
    );
    expect(screen.queryByText("Loading commands…")).toBeNull();
    provider.dispose();
  });
});

describe("#2199 a typed terminal-only name shows its note in the list", () => {
  test("typed /clear shows its note, with no row and no 'No matching commands.'", async () => {
    const provider = providerWith(available);
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "/clear" } });
    (input as HTMLTextAreaElement).setSelectionRange(6, 6);
    await waitFor(() => expect(screen.getByText("Terminal only")).toBeTruthy());
    expect(screen.getByText(/Use New chat instead\./)).toBeTruthy();
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.queryByText("No matching commands.")).toBeNull();
    provider.dispose();
  });

  test("Enter on a typed terminal-only name sends it as typed, and no row is chosen", async () => {
    const provider = providerWith(available);
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "/clear" } });
    (input as HTMLTextAreaElement).setSelectionRange(6, 6);
    await waitFor(() => expect(screen.getByText("Terminal only")).toBeTruthy());
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(1));
    provider.dispose();
  });

  test("/tree shows its note alone: a command its letters match is not offered, so Enter cannot pick it", async () => {
    const autoresearch = {
      name: "autoresearch",
      description: "Run an autoresearch loop",
      source: "builtin",
    };
    const provider = createSlashCommandProvider({
      client: fakeSlashClient({
        commands: async () => ({ commands: [...REAL_COMMAND_LIST, autoresearch] }),
      }).client,
      threadId,
      capabilities: () => available,
    });
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "/tree" } });
    (input as HTMLTextAreaElement).setSelectionRange(5, 5);
    await waitFor(() => expect(screen.getByText("Terminal only")).toBeTruthy());
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.queryByText("/autoresearch")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(1));
    provider.dispose();
  });
});
