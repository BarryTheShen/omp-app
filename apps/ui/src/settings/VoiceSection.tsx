import type { AppClient } from "@omp-app/client";
import {
  type SpeechLanguage,
  type SpeechServer,
  type SpeechServerApi,
  type SpeechServerInput,
  type SpeechSettings,
  type SpeechTestResult,
  SpeechToTextPort,
} from "@omp-app/contracts";
import { Plus, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { canCapture } from "../voice/capture";
import { RecentRecordings } from "../voice/RecentRecordings";
import { useVoiceSettings } from "../voice/useVoice";

const LANGUAGES: readonly { value: SpeechLanguage; label: string }[] = [
  { value: "auto", label: "As spoken (mixed is fine)" },
  { value: "zh", label: "Chinese" },
  { value: "en", label: "English" },
];
const APIS: readonly { value: SpeechServerApi; label: string }[] = [
  { value: "chat-audio", label: "Chat with audio (llama.cpp)" },
  { value: "transcriptions", label: "Transcriptions (vLLM, OpenAI)" },
];
const KEEP: readonly { value: string; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

/** A server being edited: its fields, and a key typed in (empty keeps the kept one). */
interface Draft {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly api: SpeechServerApi;
  readonly model: string;
  readonly hasKey: boolean;
  readonly key: string;
  readonly removeKey: boolean;
}

const draftOf = (server: SpeechServer): Draft => ({ ...server, key: "", removeKey: false });

function inputOf(draft: Draft): SpeechServerInput {
  const { id, name, url, api, model } = draft;
  return {
    id,
    name: name.trim() === "" ? id : name.trim(),
    url: url.trim(),
    api,
    model: model.trim(),
    ...(draft.key !== "" ? { key: draft.key } : draft.removeKey ? { key: null } : {}),
  };
}

function Choice<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly choices: readonly { value: T; label: string }[];
  readonly onChange: (value: T) => void;
}): ReactNode {
  return (
    <Select
      items={choices}
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next as T);
      }}
    >
      <SelectTrigger
        aria-label={label}
        size="sm"
        className="min-w-40 justify-between dark:bg-transparent"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {choices.map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Settings → App → Voice input (V259): off until a transcription server is named. The app ships no model: the user runs
 * one (vLLM, llama.cpp's `llama-server`, or any OpenAI-style service) and names it here; the servers are tried in
 * order. Kept on the server, the same for every device.
 */
export function VoiceSection({ client }: { readonly client: AppClient }): ReactNode {
  const read = useVoiceSettings(client);
  const [drafts, setDrafts] = useState<readonly Draft[] | null>(null);
  const [tests, setTests] = useState<Readonly<Record<string, SpeechTestResult | "testing">>>({});
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState(false);
  if (read === null) return null;
  const settings = read.settings;
  const servers = drafts ?? settings.servers.map(draftOf);
  const editing = drafts !== null;

  const save = async (
    change: Partial<SpeechSettings>,
    nextServers?: readonly Draft[],
  ): Promise<void> => {
    setError(null);
    try {
      await client.port(SpeechToTextPort).setSettings({
        settings: {
          enabled: change.enabled ?? settings.enabled,
          language: change.language ?? settings.language,
          context: change.context ?? settings.context,
          keepDays: change.keepDays ?? settings.keepDays,
          servers: (nextServers ?? settings.servers.map(draftOf)).map(inputOf),
        },
        expectedRevision: read.revision,
      });
      if (nextServers !== undefined) setDrafts(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const edit = (id: string, change: Partial<Draft>): void =>
    setDrafts(servers.map((each) => (each.id === id ? { ...each, ...change } : each)));
  const test = (id: string): void => {
    setTests((before) => ({ ...before, [id]: "testing" }));
    void client
      .port(SpeechToTextPort)
      .test({ serverId: id })
      .then(
        (result) => setTests((before) => ({ ...before, [id]: result })),
        (failure: unknown) =>
          setTests((before) => ({
            ...before,
            [id]: {
              ok: false,
              error: failure instanceof Error ? failure.message : String(failure),
              ms: 0,
            },
          })),
      );
  };

  return (
    <section aria-label="Voice input settings">
      <h3 className="mt-6 text-xs font-medium text-t3">Voice input</h3>
      <div className="flex items-center gap-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-t1">Voice input</p>
          <p className="mt-0.5 text-xs text-t3">
            A microphone in the message box: what you say goes to your own transcription server, and
            the text comes back into the box. Each part is kept until its text is in, so a failure
            loses nothing. Alt+V starts it.
            {!canCapture() && " This browser can't record (it needs the app's https address)."}
          </p>
        </div>
        <Switch
          aria-label="Voice input"
          checked={settings.enabled}
          disabled={!settings.enabled && settings.servers.length === 0}
          onCheckedChange={(next) => void save({ enabled: next })}
        />
      </div>
      <div className="py-2">
        <p className="text-sm text-t1">Transcription servers</p>
        <p className="mt-0.5 text-xs text-t3">
          Tried in order: the next one when the one before fails. The address ends in /v1.
        </p>
        <ul className="mt-2 flex flex-col gap-2">
          {servers.map((server, place) => {
            const result = tests[server.id];
            return (
              <li key={server.id} className="rounded-lg border border-l2 p-2.5">
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    aria-label="Name"
                    placeholder="Name (my GPU)"
                    value={server.name}
                    onChange={(event) => edit(server.id, { name: event.target.value })}
                  />
                  <Input
                    aria-label="Address"
                    placeholder="http://gpu-box:8080/v1"
                    value={server.url}
                    onChange={(event) => edit(server.id, { url: event.target.value })}
                  />
                  <Choice
                    label="API"
                    value={server.api}
                    choices={APIS}
                    onChange={(api) => edit(server.id, { api })}
                  />
                  <Input
                    aria-label="Model"
                    placeholder="Model (may be empty)"
                    value={server.model}
                    onChange={(event) => edit(server.id, { model: event.target.value })}
                  />
                  <Input
                    aria-label="Key"
                    type="password"
                    autoComplete="off"
                    placeholder={
                      server.hasKey && !server.removeKey
                        ? "Key kept (type to change)"
                        : "Key (if it needs one)"
                    }
                    value={server.key}
                    onChange={(event) => edit(server.id, { key: event.target.value })}
                  />
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={editing || result === "testing"}
                      title={editing ? "Save first" : "Sends a second of silence"}
                      onClick={() => test(server.id)}
                    >
                      {result === "testing" ? "Testing…" : "Test"}
                    </Button>
                    {server.hasKey && !server.removeKey && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => edit(server.id, { removeKey: true })}
                      >
                        Remove key
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      className="ml-auto text-t3 hover:text-bad-ink"
                      aria-label={`Remove ${server.name || `server ${place + 1}`}`}
                      onClick={() => setDrafts(servers.filter((each) => each.id !== server.id))}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                {result !== undefined && result !== "testing" && (
                  <p className={`mt-1.5 text-xs ${result.ok ? "text-ok-ink" : "text-bad-ink"}`}>
                    {result.ok
                      ? `Works: answered in ${result.ms} ms.`
                      : `Failed: ${result.error ?? "no answer"}`}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={servers.length >= 4}
            onClick={() =>
              setDrafts([
                ...servers,
                {
                  id: crypto.randomUUID().slice(0, 8),
                  name: "",
                  url: "",
                  api: "chat-audio",
                  model: "",
                  hasKey: false,
                  key: "",
                  removeKey: false,
                },
              ])
            }
          >
            <Plus /> Add a server
          </Button>
          {editing && (
            <>
              <Button type="button" size="sm" onClick={() => void save({}, servers)}>
                Save servers
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setDrafts(null)}>
                Undo changes
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-t1">Language</p>
          <p className="mt-0.5 text-xs text-t3">
            As spoken keeps Chinese and English as you mix them.
          </p>
        </div>
        <Choice
          label="Language"
          value={settings.language}
          choices={LANGUAGES}
          onChange={(language) => void save({ language })}
        />
      </div>
      <div className="py-2">
        <p className="text-sm text-t1">Words to recognise</p>
        <p className="mt-0.5 text-xs text-t3">
          Names and jargon the server should expect (omp, Kubernetes, Claude). Sent with each part.
        </p>
        <textarea
          aria-label="Words to recognise"
          className="mt-2 w-full rounded-md border border-l2 bg-transparent px-2.5 py-1.5 text-sm text-t1 outline-none focus:border-l4"
          rows={2}
          maxLength={2000}
          defaultValue={settings.context}
          onBlur={(event) => {
            if (event.target.value !== settings.context) void save({ context: event.target.value });
          }}
        />
      </div>
      <div className="flex items-center gap-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-t1">Keep recordings for</p>
          <p className="mt-0.5 text-xs text-t3">Each recording's audio and text, on the server.</p>
        </div>
        <Choice
          label="Keep recordings for"
          value={String(settings.keepDays)}
          choices={KEEP}
          onChange={(days) => void save({ keepDays: Number(days) })}
        />
      </div>
      <div className="border-b border-l1 pb-3">
        <Button type="button" size="sm" variant="outline" onClick={() => setRecent(true)}>
          Recent recordings
        </Button>
      </div>
      {error !== null && <p className="pt-2 text-xs text-bad-ink">{error}</p>}
      <RecentRecordings client={client} open={recent} onOpenChange={setRecent} />
    </section>
  );
}
