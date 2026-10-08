import {
  AssistantRuntimeProvider,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { AppClient } from "@omp-app/client";
import { AppFailure, type CapabilityMap, FolderPath } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ComposerSurface } from "@/modules/U2/composer";
import { ComposerTriggers, composerTriggerProviders } from "./composer-triggers";

const AVAILABLE = { state: "available", via: "host" } as const;
const EVERYTHING: CapabilityMap = {
  "host.file-search": AVAILABLE,
  "host.github-refs": AVAILABLE,
  "host.url-catalog": AVAILABLE,
};
const folder = FolderPath.parse("/workspace");
const oneFile = { results: [{ path: "src/app.ts", kind: "file", score: 1 }], truncated: false };

function unavailableSearch(): never {
  throw new AppFailure({
    code: "unavailable",
    message: "File search is unavailable here.",
    retryable: false,
    capability: "host.file-search",
  });
}

/**
 * A client whose file search answers with `search`. GitHub references find nothing, and the URL
 * catalog is never asked: a test sees only what it types.
 */
function fakeClient(search: (args: unknown) => Promise<unknown>): AppClient {
  return {
    port: (port: { readonly name: string }) => ({
      search: (args: unknown) => {
        if (port.name === "A1.fileSearch") return search(args);
        if (port.name === "A1.githubRefs") {
          return Promise.resolve({ candidates: [], truncated: false });
        }
        return Promise.resolve({ results: [], truncated: false });
      },
    }),
  } as unknown as AppClient;
}

function RuntimeHarness({ children }: { readonly children: React.ReactNode }) {
  const runtime = useExternalStoreRuntime({
    messages: [] as readonly ThreadMessage[],
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

function Composed({
  client,
  capabilities,
}: {
  readonly client: AppClient;
  readonly capabilities: CapabilityMap;
}) {
  return (
    <RuntimeHarness>
      <ComposerTriggers capabilities={capabilities} client={client} folder={folder}>
        <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
      </ComposerTriggers>
    </RuntimeHarness>
  );
}

/** Lets the composer's trigger effects run, and any pending search answer, before a negative assertion. */
function pause(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  // Longer than the 60 ms debounce, so a search that was started has answered by then.
  setTimeout(resolve, 200);
  return promise;
}

afterEach(() => cleanup());

describe("composerTriggerProviders", () => {
  test("without a folder no file or GitHub trigger is offered; the folder-free URL catalog stays", () => {
    const providers = composerTriggerProviders({
      client: fakeClient(async () => oneFile),
      folder: null,
      capabilities: EVERYTHING,
    });
    expect(providers.mention).toEqual([]);
    expect(providers.local.map((provider) => provider.kind)).toEqual(["emoji", "internal-url"]);
  });

  test("every trigger whose capability is available is offered", () => {
    const providers = composerTriggerProviders({
      client: fakeClient(async () => oneFile),
      folder,
      capabilities: EVERYTHING,
    });
    expect(providers.mention.map((provider) => provider.trigger)).toEqual(["@", "#"]);
    expect(providers.local.map((provider) => provider.kind)).toEqual(["emoji", "internal-url"]);
  });

  test("a trigger whose capability is missing or unavailable is not offered", () => {
    const providers = composerTriggerProviders({
      client: fakeClient(async () => oneFile),
      folder,
      capabilities: { "host.github-refs": { state: "unavailable", via: "host" } },
    });
    expect(providers.mention).toEqual([]);
    expect(providers.local.map((provider) => provider.kind)).toEqual(["emoji"]);
  });

  test("an unavailable file search is reported as unavailable, so the composer can stay quiet", async () => {
    const providers = composerTriggerProviders({
      client: fakeClient(async () => unavailableSearch()),
      folder,
      capabilities: EVERYTHING,
    });
    const files = providers.mention.find((provider) => provider.trigger === "@");
    const result = await files?.searchTyped("src");
    expect(result?.state).toBe("unavailable");
    expect(result?.candidates).toEqual([]);
  });

  test("an available file search passes its candidates through", async () => {
    const providers = composerTriggerProviders({
      client: fakeClient(async () => oneFile),
      folder,
      capabilities: EVERYTHING,
    });
    const files = providers.mention.find((provider) => provider.trigger === "@");
    const result = await files?.searchTyped("src");
    expect(result?.state).toBe("ready");
    expect(result?.candidates).toEqual([expect.objectContaining({ label: "src/app.ts" })]);
  });
});

describe("ComposerTriggers in the composer", () => {
  test("@ lists the open folder's files, and inserting one puts a mention into the draft", async () => {
    render(<Composed capabilities={EVERYTHING} client={fakeClient(async () => oneFile)} />);
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "before @src" } });
    (input as HTMLTextAreaElement).setSelectionRange(11, 11);
    await waitFor(() => expect(screen.getByText("src/app.ts")).toBeTruthy());
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).not.toBeNull());
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe("before @src/app.ts "));
  });

  test(": lists emoji, and inserting one writes the character", async () => {
    render(<Composed capabilities={{}} client={fakeClient(async () => oneFile)} />);
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "say :smil" } });
    (input as HTMLTextAreaElement).setSelectionRange(9, 9);
    await waitFor(() => expect(screen.getByText(/:smile:/)).toBeTruthy());
    fireEvent.click(screen.getByText(/:smile:/));
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe("say 😄 "));
  });

  test("with no file search, @ types as plain text and opens nothing", async () => {
    render(<Composed capabilities={{}} client={fakeClient(async () => oneFile)} />);
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "before @src" } });
    (input as HTMLTextAreaElement).setSelectionRange(11, 11);
    await pause();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByText("No matches")).toBeNull();
    expect((input as HTMLTextAreaElement).value).toBe("before @src");
  });

  test("file search unavailable: its row shows, and never No matches", async () => {
    const search = vi.fn(async (_args: unknown) => unavailableSearch());
    render(<Composed capabilities={EVERYTHING} client={fakeClient(search)} />);
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "before @src" } });
    (input as HTMLTextAreaElement).setSelectionRange(11, 11);
    await waitFor(() => expect(search).toHaveBeenCalled());
    expect(await screen.findByText("File search is unavailable here.")).toBeTruthy();
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.queryByText("No matches")).toBeNull();
    expect((input as HTMLTextAreaElement).value).toBe("before @src");
  });

  test("issue:// with no GitHub behind it opens no list at all, and typing is kept", async () => {
    render(
      <Composed
        capabilities={{ "host.url-catalog": AVAILABLE }}
        client={fakeClient(async () => oneFile)}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "see issue://12" } });
    (input as HTMLTextAreaElement).setSelectionRange(15, 15);
    expect(screen.queryByRole("listbox")).toBeNull();
    await pause();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByText("No matches")).toBeNull();
    expect((input as HTMLTextAreaElement).value).toBe("see issue://12");
  });

  test("a # in prose with a space closes its list when nothing matches", async () => {
    render(<Composed capabilities={EVERYTHING} client={fakeClient(async () => oneFile)} />);
    const input = screen.getByRole("textbox", { name: "Message input" });
    const typed = "ticket #12 is";
    fireEvent.change(input, { target: { value: typed } });
    (input as HTMLTextAreaElement).setSelectionRange(typed.length, typed.length);
    await pause();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect((input as HTMLTextAreaElement).value).toBe(typed);
  });
});
