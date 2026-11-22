import type { AppClient } from "@omp-app/client";
import { type FolderPath, SessionFileStore, type ThreadId } from "@omp-app/contracts";
import { type ReactNode, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { titleOf } from "../../sidebar/title";

/** How many of the workspace's recent chats the list offers. */
const RECENT = 20;

/** A chat that may be given access: its id and its name as the chat list shows it. */
interface Pick {
  readonly threadId: ThreadId;
  readonly name: string;
}

/**
 * Agent access, given by the person without an agent's asking (2026-11-22): a chat picked from the workspace's recent
 * chats (the one open beside the panel first), and a folder of theirs, to read or also to change. Each goes through
 * this computer's agent and asks the person's password, as allowing a request does.
 */
export function DirectGrants({
  client,
  folder,
  current,
  allowed,
  disabled,
  onGiveChat,
  onShareFolder,
}: {
  readonly client: AppClient;
  /** The workspace whose recent chats are offered. */
  readonly folder: FolderPath;
  /** The chat open beside the panel, offered first; null when none is. */
  readonly current: ThreadId | null;
  /** The chats with access already: not offered. */
  readonly allowed: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onGiveChat: (chat: Pick) => void;
  readonly onShareFolder: (path: string, write: boolean) => void;
}): ReactNode {
  const pathId = useId();
  const [recent, setRecent] = useState<readonly Pick[]>([]);
  const [picked, setPicked] = useState<string>("");
  const [path, setPath] = useState("");

  useEffect(() => {
    let live = true;
    client
      .port(SessionFileStore)
      .listSessions({ folder, limit: RECENT })
      .then(({ sessions }) => {
        if (live)
          setRecent(sessions.map((session) => ({ threadId: session.id, name: titleOf(session) })));
      })
      // No list: only the chat open beside the panel is offered.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, folder]);

  // The chat open beside the panel first, named "This chat"; then the recent ones, none twice, none with access.
  const here = current === null ? undefined : recent.find((each) => each.threadId === current);
  const choices = [
    ...(current === null
      ? []
      : [
          {
            threadId: current,
            name: here?.name ?? "This chat",
            label: `This chat: ${here?.name ?? "the open chat"}`,
          },
        ]),
    ...recent
      .filter((each) => each.threadId !== current)
      .map((each) => ({ ...each, label: each.name })),
  ].filter((each) => !allowed.has(each.threadId));
  const chosen = choices.find((each) => each.threadId === picked) ?? choices[0];

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div>
        <h4 className="text-xs font-medium text-t2">Give a chat access</h4>
        <p className="mt-0.5 text-xs text-t3">
          It can then run commands here whenever agent access is on, without asking first.
        </p>
        {choices.length === 0 ? (
          <p className="mt-1 text-xs text-t3">Every recent chat here already has access.</p>
        ) : (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Select
              items={choices.map((each) => ({ value: each.threadId, label: each.label }))}
              value={chosen?.threadId ?? ""}
              onValueChange={(next) => {
                if (typeof next === "string") setPicked(next);
              }}
            >
              <SelectTrigger
                aria-label="Chat to give access"
                size="sm"
                className="max-w-full min-w-0 flex-1 justify-between dark:bg-transparent"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((each) => (
                  <SelectItem key={each.threadId} value={each.threadId}>
                    {each.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              className="max-sm:h-11"
              disabled={disabled || chosen === undefined}
              onClick={() => {
                if (chosen !== undefined)
                  onGiveChat({ threadId: chosen.threadId, name: chosen.name });
              }}
            >
              Give access
            </Button>
          </div>
        )}
      </div>
      <form
        aria-label="Share a folder"
        onSubmit={(event) => {
          event.preventDefault();
          if (path.trim() !== "") onShareFolder(path.trim(), false);
        }}
      >
        <label htmlFor={pathId} className="text-xs font-medium text-t2">
          Share a folder
        </label>
        <p className="mt-0.5 text-xs text-t3">
          A folder in your home, as <code>~/projects/app</code> or a full path. Agents can use it
          whenever agent access is on.
        </p>
        <Input
          id={pathId}
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="~/projects/app"
          spellCheck={false}
          autoCapitalize="off"
          className="mt-1 h-8 font-mono text-xs max-sm:h-11"
        />
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            type="submit"
            size="sm"
            className="h-auto min-h-7 whitespace-normal py-1 max-sm:min-h-11"
            disabled={disabled || path.trim() === ""}
          >
            Share, reading only
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-auto min-h-7 whitespace-normal py-1 max-sm:min-h-11"
            disabled={disabled || path.trim() === ""}
            onClick={() => onShareFolder(path.trim(), true)}
          >
            Share, reading and changes
          </Button>
        </div>
        <p className="mt-1 text-xs text-t3">
          Changed files can include ones that run later, such as a project's scripts or Git hooks.
        </p>
      </form>
    </div>
  );
}
