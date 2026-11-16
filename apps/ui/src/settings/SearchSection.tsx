import type { AppClient } from "@omp-app/client";
import {
  ChatSearchPort,
  type ChatSearchState,
  type ChatSearchTest,
  type SetChatSearchSettingsArgs,
} from "@omp-app/contracts";
import { type ReactNode, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

const words = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/** While the index is brought up to date, the section reads how far it is this often. */
const FOLLOW_MS = 5_000;

/** How far the index is, in words: "312 of 348 chats indexed; indexing now", or what stopped it. */
export function indexWords(status: ChatSearchState["status"]): string {
  if (status.problem !== null) return `Indexing stopped: ${status.problem}`;
  if (status.chats === 0)
    return status.indexing ? "Looking for chats to index…" : "No chat indexed yet.";
  const count = `${status.indexed} of ${status.chats} ${status.chats === 1 ? "chat" : "chats"} indexed`;
  return status.indexing ? `${count}; indexing now.` : `${count}.`;
}

/** What a test of the service came to, in words. */
export function testWords(test: ChatSearchTest): string {
  return test.ok
    ? `It answered in ${test.ms} ms with vectors of ${test.dimensions} numbers.`
    : `It did not answer: ${test.message}`;
}

/**
 * Settings → App → Search by meaning: on or off; the embedding service's address, model and key (kept on the server,
 * never shown again); Test; and how far the index of every chat's talk is.
 */
export function SearchSection({ client }: { readonly client: AppClient }): ReactNode {
  const [state, setState] = useState<ChatSearchState | null>(null);
  const [address, setAddress] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [test, setTest] = useState<ChatSearchTest | "testing" | null>(null);
  const ids = { address: useId(), model: useId(), key: useId() };

  useEffect(() => {
    let alive = true;
    client
      .port(ChatSearchPort)
      .state({})
      .then(
        (next) => {
          if (!alive) return;
          setState(next);
          setAddress(next.settings.address);
          setModel(next.settings.model);
        },
        (failure: unknown) =>
          alive && setProblem(`Search by meaning could not be read: ${words(failure)}`),
      );
    return () => {
      alive = false;
    };
  }, [client]);

  // While search by meaning is on, how far the index is is read again until it is up to date.
  const following =
    state?.settings.enabled === true &&
    (state.status.indexing || state.status.indexed < state.status.chats);
  useEffect(() => {
    if (!following) return;
    let alive = true;
    const timer = setInterval(() => {
      client
        .port(ChatSearchPort)
        .state({})
        .then(
          (next) => alive && setState(next),
          () => undefined,
        );
    }, FOLLOW_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, following]);

  const save = (change: SetChatSearchSettingsArgs, failed: string): void => {
    setSaving(true);
    setProblem(null);
    client
      .port(ChatSearchPort)
      .setSettings(change)
      .then(
        (next) => {
          setState(next);
          if (change.key !== undefined) setKey("");
        },
        (failure: unknown) => setProblem(`${failed}: ${words(failure)}`),
      )
      .finally(() => setSaving(false));
  };

  const runTest = (): void => {
    setTest("testing");
    client
      .port(ChatSearchPort)
      .test({})
      .then(
        (result) => setTest(result),
        (failure: unknown) => setTest({ ok: false, ms: 0, message: words(failure) }),
      );
  };

  const settings = state?.settings;
  const changed =
    settings !== undefined &&
    (address.trim() !== settings.address || model.trim() !== settings.model || key !== "");

  return (
    <section aria-label="Search by meaning" data-tour="search-by-meaning">
      <h3 className="mt-6 text-xs font-medium text-t3">Search by meaning</h3>
      {settings !== undefined && state !== null && (
        <>
          <div className="flex items-center gap-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-t1">Search chats by meaning</p>
              <p className="mt-0.5 text-xs text-t3">
                The sidebar's Search and the palette also find the chats whose talk is closest to
                your words, not only their titles. What you and omp wrote in each chat is sent to
                the embedding service below; tool output is not.
              </p>
            </div>
            <Switch
              aria-label="Search chats by meaning"
              checked={settings.enabled}
              disabled={
                saving || (!settings.enabled && (settings.address === "" || settings.model === ""))
              }
              onCheckedChange={(enabled) => save({ enabled }, "The switch was not saved")}
            />
          </div>
          <form
            className="grid gap-2 py-2"
            onSubmit={(event) => {
              event.preventDefault();
              save(
                {
                  address: address.trim(),
                  model: model.trim(),
                  ...(key === "" ? {} : { key }),
                },
                "The service was not saved",
              );
            }}
          >
            <label htmlFor={ids.address} className="grid gap-1 text-xs text-t2">
              Address (an OpenAI-style /embeddings service)
            </label>
            <Input
              id={ids.address}
              value={address}
              placeholder="https://embed.example.com/v1"
              spellCheck={false}
              onChange={(event) => setAddress(event.target.value)}
            />
            <label htmlFor={ids.model} className="grid gap-1 text-xs text-t2">
              Model
            </label>
            <Input
              id={ids.model}
              value={model}
              placeholder="qwen3-embedding-0.6b"
              spellCheck={false}
              onChange={(event) => setModel(event.target.value)}
            />
            <label htmlFor={ids.key} className="grid gap-1 text-xs text-t2">
              Key{" "}
              {settings.hasKey
                ? "(one is kept; type a new one to replace it)"
                : "(if the service asks for one)"}
            </label>
            <Input
              id={ids.key}
              type="password"
              value={key}
              autoComplete="off"
              placeholder={settings.hasKey ? "••••••••" : ""}
              onChange={(event) => setKey(event.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button type="submit" size="sm" variant="secondary" disabled={saving || !changed}>
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={test === "testing" || settings.address === "" || settings.model === ""}
                onClick={runTest}
              >
                {test === "testing" ? "Testing…" : "Test"}
              </Button>
              {settings.hasKey && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => save({ key: "" }, "The key was not removed")}
                >
                  Remove the key
                </Button>
              )}
            </div>
          </form>
          {test !== null && test !== "testing" && (
            <p role="status" className="text-xs text-t2">
              {testWords(test)}
            </p>
          )}
          {settings.enabled && (
            <p role="status" className="py-2 text-xs text-t2">
              {indexWords(state.status)}
            </p>
          )}
        </>
      )}
      {problem !== null && (
        <p role="alert" className="py-1 text-xs text-bad-ink">
          {problem}
        </p>
      )}
    </section>
  );
}
