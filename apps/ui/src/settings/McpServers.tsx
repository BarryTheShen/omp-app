import type { McpCommandServerSummary } from "@omp-app/contracts";
import {
  type HostDialogRequest,
  MCP_REAUTH_ADDRESS_PROMPT,
  type McpReauthResult,
} from "@omp-app/contracts/chat-host";
import { type ReactNode, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ChatController } from "../chat/controller";

const words = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/**
 * How each server reads. omp's `/mcp list` says only whether a server is enabled; the other states are for a list that
 * knows its connection.
 */
const STATUS_WORDS: Readonly<Record<McpCommandServerSummary["status"], string>> = {
  configured: "Enabled",
  connecting: "Connecting",
  ready: "Connected",
  error: "Failed",
  disabled: "Disabled",
};

/** What a sign-in ended with, by the server's connection after it. */
function signedInWords(name: string, status: McpReauthResult["status"]): string {
  if (status === "connected") return `Signed in to ${name} again; it is connected.`;
  if (status === "connecting") return `Signed in to ${name} again; it is connecting.`;
  return `Signed in to ${name} again.`;
}

/**
 * omp's MCP servers, at the top of the Tools tab (#2779 D6.2): each one, and Sign in again for an enabled server reached
 * over the network (HTTP or SSE), the kind that signs in through a page; for one that needs no sign-in omp says so. omp
 * signs in inside a chat, so this goes through the focused chat: the page opens here, on the device in use, and as omp
 * waits for the sign-in's answer on its own computer, the address the browser ends on is asked for as one of the chat's
 * questions.
 */
export function McpServers({
  controller,
}: {
  readonly controller: ChatController | null;
}): ReactNode {
  return (
    <section aria-label="MCP servers" className="mt-6">
      <h3 className="text-xs font-medium text-t3">MCP servers</h3>
      {controller === null ? (
        <p className="mt-2 text-sm text-t3">
          Open a chat to see the MCP servers: omp runs them inside a chat.
        </p>
      ) : (
        <Servers controller={controller} />
      )}
    </section>
  );
}

function Servers({ controller }: { readonly controller: ChatController }): ReactNode {
  const { signIn, requests } = useSyncExternalStore(
    controller.store.subscribe,
    controller.store.getSnapshot,
  );
  const [servers, setServers] = useState<readonly McpCommandServerSummary[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** How the last sign-in ended, when it ended well. */
  const [done, setDone] = useState<string | null>(null);
  /** The server being signed in to. */
  const [busy, setBusy] = useState<string | null>(null);
  // A read that fails keeps the list shown, and says so.
  const read = useCallback(
    () =>
      controller.mcpServers().then(setServers, (failure: unknown) => {
        setServers((shown) => shown ?? []);
        setProblem(`omp could not list its MCP servers: ${words(failure)}`);
      }),
    [controller],
  );
  useEffect(() => {
    void read();
  }, [read]);
  const signInAgain = (name: string): void => {
    setBusy(name);
    setProblem(null);
    setDone(null);
    controller
      .mcpReauth(name)
      .then((result) => {
        if (result.status === "disconnected") {
          setProblem(`Signed in to ${name} again, but it did not connect.`);
        } else {
          setDone(signedInWords(name, result.status));
        }
        void read();
      })
      .catch((failure: unknown) => setProblem(`Could not sign in to ${name}: ${words(failure)}`))
      .finally(() => setBusy(null));
  };
  if (servers === null) {
    return <p className="mt-2 text-sm text-t3">Reading omp's MCP servers…</p>;
  }
  return (
    <>
      {servers.length === 0 ? (
        <p className="mt-2 text-sm text-t3">omp has no MCP servers set up.</p>
      ) : (
        <ul className="mt-1">
          {servers.map((server) => (
            <li
              key={server.name}
              className="flex min-h-10 items-center gap-3 border-b border-l1 py-1.5 text-sm"
            >
              <span className="min-w-0 flex-1 truncate text-t1">{server.name}</span>
              <span className="shrink-0 text-xs text-t3">{STATUS_WORDS[server.status]}</span>
              {server.enabled && server.transport !== "stdio" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => signInAgain(server.name)}
                >
                  {busy === server.name ? "Waiting…" : "Sign in again"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {busy !== null && (
        <div role="status" className="mt-2 text-sm text-t2">
          {signIn === null ? (
            `Starting the sign-in to ${busy}…`
          ) : (
            <>
              Open{" "}
              <a
                href={signIn.url}
                target="_blank"
                rel="noreferrer"
                className="text-accent-ink underline underline-offset-2"
              >
                {busy}'s sign-in page
              </a>
              . After you sign in, your browser shows a page that cannot load: paste its address
              here.
            </>
          )}
        </div>
      )}
      {busy !== null && (
        <AddressQuestion
          controller={controller}
          request={requests.find(
            (request) =>
              request.method === "ui.input" && request.params.title === MCP_REAUTH_ADDRESS_PROMPT,
          )}
        />
      )}
      {done !== null && busy === null && (
        <p role="status" className="mt-2 text-sm text-t2">
          {done}
        </p>
      )}
      {problem !== null && (
        <p role="alert" className="mt-2 text-xs text-bad-ink">
          {problem}
        </p>
      )}
    </>
  );
}

/**
 * omp's question for the address the browser ends on, answered here as well as in the chat (it is the chat's own
 * question, behind Settings): a sign-in from Settings finishes in Settings.
 */
function AddressQuestion({
  controller,
  request,
}: {
  readonly controller: ChatController;
  readonly request: HostDialogRequest | undefined;
}): ReactNode {
  const [address, setAddress] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (request === undefined) return null;
  const answer = (value: { readonly value: string } | { readonly cancelled: true }): void => {
    setSending(true);
    setProblem(null);
    controller
      .answer(request.id, value)
      .catch((failure: unknown) => setProblem(`Not sent: ${words(failure)}`))
      .finally(() => setSending(false));
  };
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        answer({ value: address.trim() });
      }}
    >
      <Input
        aria-label="The address your browser ended on"
        placeholder="http://localhost:…"
        className="min-w-64 flex-1"
        value={address}
        onChange={(event) => setAddress(event.target.value)}
      />
      <Button type="submit" size="sm" disabled={sending || address.trim() === ""}>
        Finish sign-in
      </Button>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={sending}
        onClick={() => answer({ cancelled: true })}
      >
        Cancel
      </Button>
      {problem !== null && <p className="w-full text-xs text-bad-ink">{problem}</p>}
    </form>
  );
}
