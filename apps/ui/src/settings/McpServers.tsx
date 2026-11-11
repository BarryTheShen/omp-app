import type { AppClient } from "@omp-app/client";
import {
  type FolderPath,
  type McpCommandServerSummary,
  McpConfigPort,
  type McpConfigServer,
} from "@omp-app/contracts";
import type { McpReauthResult } from "@omp-app/contracts/chat-host";
import { Plus } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { ChatController } from "../chat/controller";
import { type McpSave, McpServerEditor } from "./McpServerEditor";
import { reachWords } from "./mcpForm";
import { SignInProgress } from "./SignInProgress";

const words = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/** A finger's 44 pt on a phone or tablet. */
const TOUCH = "max-sm:h-11 tablet:h-11";

/** How a server's state in the open chat reads, and its dot. */
const STATUS: Readonly<
  Record<McpCommandServerSummary["status"], { readonly words: string | null; readonly dot: string }>
> = {
  // omp's `/mcp list` says only "configured" for a server that is on: its switch says that already.
  configured: { words: null, dot: "bg-t4" },
  connecting: { words: "connecting", dot: "bg-warn" },
  ready: { words: "connected", dot: "bg-ok" },
  error: { words: "failed", dot: "bg-bad" },
  disabled: { words: "off", dot: "bg-t4" },
};

const KIND_WORDS = { stdio: "Command", http: "HTTP", sse: "SSE" } as const;

/** What a sign-in ended with, by the server's connection after it. */
function signedInWords(name: string, status: McpReauthResult["status"]): string {
  if (status === "connected") return `Signed in to ${name} again; it is connected.`;
  if (status === "connecting") return `Signed in to ${name} again; it is connecting.`;
  return `Signed in to ${name} again.`;
}

/** `/mcp` commands take no spaces in a name (`McpCommandServerName`); omp's files do. */
const commandable = (name: string): boolean => !name.includes(" ");

/**
 * omp's MCP servers in Settings → Tools (#16): every server in your MCP file and this folder's, each with how omp
 * reaches it, where it is kept, its state in the open chat, an on/off switch, Test, Sign in again (an address that signs
 * in through a page), Edit and Remove; Add a server opens the editor, which takes a form or JSON. Writes go through omp's
 * own config code (`A1.mcpConfig`), then the open chat reads its servers again (`/mcp reload`). Servers omp found
 * elsewhere (another app's settings) can be turned on or off here, not changed. omp signs in inside a chat, so Sign in
 * again goes through the focused chat: its page opens on this device, and the address the browser ends on is asked for
 * here and in the chat (#2779, #2784).
 */
export function McpServers({
  client,
  folder,
  controller,
}: {
  readonly client: AppClient;
  /** The open folder: its own MCP file is `<folder>/.omp/mcp.json`. */
  readonly folder: FolderPath;
  readonly controller: ChatController | null;
}): ReactNode {
  const [servers, setServers] = useState<readonly McpConfigServer[] | null>(null);
  const [live, setLive] = useState<readonly McpCommandServerSummary[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** The row acting: its key while a switch, Test or a remove runs. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Test's answer by row. */
  const [tested, setTested] = useState<Readonly<Record<string, string>>>({});
  /** The server being signed in to. */
  const [signing, setSigning] = useState<string | null>(null);
  const [editor, setEditor] = useState<{
    readonly key: number;
    readonly open: boolean;
    readonly editing: McpConfigServer | null;
  }>({ key: 0, open: false, editing: null });
  const [removing, setRemoving] = useState<McpConfigServer | null>(null);

  // A read that fails keeps the list shown, and says so.
  const read = useCallback(async (): Promise<void> => {
    const [files, chat] = await Promise.allSettled([
      client.port(McpConfigPort).servers({ folder }),
      controller === null ? Promise.resolve([]) : controller.mcpServers(),
    ]);
    if (files.status === "fulfilled") {
      setServers(files.value.servers);
    } else {
      setServers((shown) => shown ?? []);
      setProblem(`omp's MCP files could not be read: ${words(files.reason)}`);
    }
    setLive(chat.status === "fulfilled" ? chat.value : []);
  }, [client, folder, controller]);
  useEffect(() => {
    void read();
  }, [read]);

  /** After a write: the open chat reads its servers again, and the lists are read again. */
  const changed = async (what: string): Promise<void> => {
    const reload = controller === null ? null : await controller.mcpReload().catch(() => null);
    setDone(
      reload?.message === "MCP servers reloaded."
        ? `${what} This chat has read its MCP servers again.`
        : `${what} Chats started from now on use it.`,
    );
    await read();
  };

  const act = async (key: string, run: () => Promise<string>): Promise<void> => {
    setBusy(key);
    setProblem(null);
    setDone(null);
    try {
      await changed(await run());
    } catch (failure) {
      setProblem(words(failure));
    } finally {
      setBusy(null);
    }
  };

  const save = async (change: McpSave): Promise<void> => {
    await client.port(McpConfigPort).save({ folder, ...change });
    setProblem(null);
    await changed(change.previousName === null ? `${change.name} added.` : `${change.name} saved.`);
  };

  const test = (key: string, name: string, scope: McpConfigServer["scope"]): void => {
    if (controller === null) return;
    setBusy(key);
    setTested(({ [key]: _gone, ...rest }) => rest);
    controller
      .mcpTest(name, scope)
      .then(
        (result) => result.message ?? "Connected.",
        (failure: unknown) => `Not connected: ${words(failure)}`,
      )
      .then((answer) => setTested((shown) => ({ ...shown, [key]: answer })))
      .finally(() => {
        setBusy(null);
        void read();
      });
  };

  const signInAgain = (name: string): void => {
    if (controller === null) return;
    setSigning(name);
    setProblem(null);
    setDone(null);
    controller
      .mcpReauth(name)
      .then((result) => {
        if (result.cancelled) setDone(`Sign-in to ${name} cancelled.`);
        else if (result.status === "disconnected")
          setProblem(`Signed in to ${name} again, but it did not connect.`);
        else setDone(signedInWords(name, result.status));
        void read();
      })
      .catch((failure: unknown) => setProblem(`Could not sign in to ${name}: ${words(failure)}`))
      .finally(() => setSigning(null));
  };

  const openEditor = (editing: McpConfigServer | null): void =>
    setEditor((shown) => ({ key: shown.key + 1, open: true, editing }));

  const elsewhere = live.filter(
    (server) => !(servers ?? []).some((saved) => saved.name === server.name),
  );

  return (
    <section aria-label="MCP servers" className="mt-6" data-tour="mcp-servers">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium text-t3">MCP servers</h3>
        <Button
          size="sm"
          variant="outline"
          className={TOUCH}
          data-tour="mcp-add"
          onClick={() => openEditor(null)}
        >
          <Plus />
          Add a server
        </Button>
      </div>
      <p className="mt-1 text-xs text-pretty text-t3">
        Programs that give omp more tools. Yours reach every folder; a folder's own reach the chats
        in it.
        {controller === null ? " Open a chat to see which connect." : ""}
      </p>
      {servers === null ? (
        <p className="mt-2 text-sm text-t3">Reading omp's MCP servers…</p>
      ) : servers.length === 0 && elsewhere.length === 0 ? (
        <p className="mt-2 text-sm text-pretty text-t3">
          No MCP servers yet. Add one, or paste its JSON from the server's page.
        </p>
      ) : (
        <ul aria-label="Servers" className="mt-1">
          {servers.map((server) => {
            const key = `${server.scope}\u0000${server.name}`;
            const state =
              live.find((each) => each.name === server.name && each.scope === server.scope) ??
              live.find((each) => each.name === server.name);
            const on = server.config.enabled !== false;
            const status = !on
              ? STATUS.disabled
              : state !== undefined
                ? STATUS[state.status]
                : null;
            return (
              <li
                key={key}
                aria-label={server.name}
                className="flex flex-col gap-1.5 border-b border-l1 py-2.5"
              >
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${status?.dot ?? "bg-t4"}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                      <span className="truncate font-medium text-t1">{server.name}</span>
                      <span className="text-xs text-t3">
                        {KIND_WORDS[server.config.type]} ·{" "}
                        {server.scope === "user" ? "every folder" : "this folder"}
                        {status === null
                          ? controller === null
                            ? ""
                            : " · not in this chat yet"
                          : status.words === null
                            ? ""
                            : ` · ${status.words}`}
                      </span>
                    </p>
                    <p
                      className="truncate font-mono text-xs text-t3"
                      title={reachWords(server.config)}
                    >
                      {reachWords(server.config)}
                    </p>
                  </div>
                  <Switch
                    aria-label={`${server.name} on`}
                    className="mt-1"
                    checked={on}
                    disabled={busy !== null}
                    onCheckedChange={(next) =>
                      void act(key, async () => {
                        await client.port(McpConfigPort).setEnabled({
                          folder,
                          scope: server.scope,
                          name: server.name,
                          enabled: next,
                        });
                        return next ? `${server.name} turned on.` : `${server.name} turned off.`;
                      })
                    }
                  />
                </div>
                <div className="flex flex-wrap items-center gap-1 pl-5">
                  {controller !== null && on && commandable(server.name) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className={TOUCH}
                      disabled={busy !== null}
                      onClick={() => test(key, server.name, server.scope)}
                    >
                      {busy === key ? "Testing…" : "Test"}
                    </Button>
                  )}
                  {controller !== null &&
                    on &&
                    server.config.type !== "stdio" &&
                    commandable(server.name) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className={TOUCH}
                        disabled={signing !== null}
                        onClick={() => signInAgain(server.name)}
                      >
                        {signing === server.name ? "Waiting…" : "Sign in again"}
                      </Button>
                    )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className={TOUCH}
                    disabled={busy !== null}
                    onClick={() => openEditor(server)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={`text-bad-ink ${TOUCH}`}
                    disabled={busy !== null}
                    onClick={() => setRemoving(server)}
                  >
                    Remove
                  </Button>
                  {tested[key] !== undefined && (
                    <span role="status" className="text-xs text-pretty text-t2">
                      {tested[key]}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
          {elsewhere.map((server) => {
            const key = `elsewhere\u0000${server.name}`;
            const status = STATUS[server.status];
            return (
              <li
                key={key}
                aria-label={server.name}
                className="flex items-start gap-3 border-b border-l1 py-2.5"
              >
                <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${status.dot}`} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="truncate font-medium text-t1">{server.name}</span>
                    <span className="text-xs text-t3">
                      {KIND_WORDS[server.transport]}
                      {status.words === null ? "" : ` · ${status.words}`}
                    </span>
                  </p>
                  <p className="text-xs text-pretty text-t3">
                    Found by omp in another app's settings: it can be turned on or off here.
                  </p>
                </div>
                <Switch
                  aria-label={`${server.name} on`}
                  className="mt-1"
                  checked={server.enabled}
                  disabled={busy !== null}
                  onCheckedChange={(next) =>
                    void act(key, async () => {
                      await client.port(McpConfigPort).setEnabled({
                        folder,
                        scope: server.scope,
                        name: server.name,
                        enabled: next,
                      });
                      return next ? `${server.name} turned on.` : `${server.name} turned off.`;
                    })
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
      {signing !== null && controller !== null && (
        <SignInProgress controller={controller} name={signing} />
      )}
      {done !== null && signing === null && (
        <p role="status" className="mt-2 text-sm text-pretty text-t2">
          {done}
        </p>
      )}
      {problem !== null && (
        <p role="alert" className="mt-2 text-xs text-pretty text-bad-ink">
          {problem}
        </p>
      )}
      <McpServerEditor
        key={editor.key}
        open={editor.open}
        onOpenChange={(open) => setEditor((shown) => ({ ...shown, open }))}
        editing={editor.editing}
        scope="user"
        hasFolder
        onSave={save}
      />
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name ?? ""}?</AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              omp drops it from{" "}
              {removing?.scope === "project" ? "this folder's MCP file" : "your MCP file"}, with its
              settings and keys. To have it back, add it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const gone = removing;
                setRemoving(null);
                if (gone === null) return;
                void act(`${gone.scope}\u0000${gone.name}`, async () => {
                  await client
                    .port(McpConfigPort)
                    .remove({ folder, scope: gone.scope, name: gone.name });
                  return `${gone.name} removed.`;
                });
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
