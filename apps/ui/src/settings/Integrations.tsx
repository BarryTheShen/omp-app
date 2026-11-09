import type { AppClient } from "@omp-app/client";
import { AppPort, type Embedders } from "@omp-app/contracts";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

/** The kinds of panel a switch allows, each as the sources the server takes for it (`frame-ancestors.ts`). */
const KINDS = [
  {
    label: "Firefox and Zen extensions",
    detail: "An extension's side panel, such as the app's own for Zen.",
    sources: ["moz-extension:"],
  },
  {
    label: "Chrome and Edge extensions",
    detail: "An extension's side panel in Chrome, Edge and other Chromium browsers.",
    sources: ["chrome-extension:"],
  },
  {
    label: "VS Code",
    detail: "A panel in VS Code and its forks.",
    sources: ["vscode-webview:", "vscode-file:"],
  },
] as const;

const KIND_SOURCES = new Set<string>(KINDS.flatMap((kind) => kind.sources));

const failureText = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/**
 * Settings → App → Integrations: the apps that may show omp app in a panel (the lite view in a frame), by kind or by
 * address, saved on the server and counted from the panel's next load. Those named when the app started
 * (`OMP_APP_FRAME_ANCESTORS`) are listed, not changed here. Every panel still pairs once, as any device.
 */
export function Integrations({ client }: { readonly client: AppClient }): ReactNode {
  const [embedders, setEmbedders] = useState<Embedders | null>(null);
  const [older, setOlder] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [address, setAddress] = useState("");

  useEffect(() => {
    let live = true;
    client
      .port(AppPort)
      .embedders({})
      .then(
        (read) => {
          if (live) setEmbedders(read);
        },
        (failure: unknown) => {
          if (!live) return;
          // A server from before this setting does not know the method.
          if (failureText(failure).includes("Unknown method")) setOlder(true);
          else setProblem(`Could not read them: ${failureText(failure)}`);
        },
      );
    return () => {
      live = false;
    };
  }, [client]);

  const save = (sources: readonly string[]): Promise<boolean> => {
    setProblem(null);
    return client
      .port(AppPort)
      .setEmbedders({ sources: [...sources] })
      .then(
        (next) => {
          setEmbedders(next);
          return true;
        },
        (failure: unknown) => {
          setProblem(failureText(failure));
          return false;
        },
      );
  };

  const saved = embedders?.saved ?? [];
  const toggle = (sources: readonly string[], on: boolean): void => {
    const rest = saved.filter((source) => !sources.includes(source));
    void save(on ? [...rest, ...sources] : rest);
  };
  const add = (event: FormEvent): void => {
    event.preventDefault();
    const text = address.trim();
    if (text === "") return;
    void save([...saved, text]).then((done) => {
      if (done) setAddress("");
    });
  };
  const addresses = saved.filter((source) => !KIND_SOURCES.has(source));

  return (
    <section aria-label="Integrations" data-tour="integrations">
      <h3 className="mt-6 text-xs font-medium text-t3">Integrations</h3>
      <p className="mt-2 text-sm text-t2">
        Apps that may show omp app in a panel: a browser extension, an editor, another app's side
        panel. Each panel still pairs once, as any device.
      </p>
      {older ? (
        <p className="py-3 text-sm text-t3">
          This app server cannot change these yet; it needs an update.
        </p>
      ) : embedders === null ? (
        <p className="py-3 text-sm text-t3">{problem ?? "Reading them…"}</p>
      ) : (
        <>
          <ul aria-label="Kinds of panel" className="mt-1 flex flex-col">
            {KINDS.map((kind) => {
              const on = kind.sources.every(
                (source) => saved.includes(source) || embedders.fixed.includes(source),
              );
              const fixed = kind.sources.every((source) => embedders.fixed.includes(source));
              return (
                <li key={kind.label} className="flex items-center gap-4 border-b border-l1 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-t1">{kind.label}</p>
                    <p className="mt-0.5 text-xs text-t3">{kind.detail}</p>
                  </div>
                  <Switch
                    aria-label={kind.label}
                    checked={on}
                    disabled={fixed}
                    onCheckedChange={(checked) => toggle(kind.sources, checked)}
                  />
                </li>
              );
            })}
          </ul>
          {(addresses.length > 0 ||
            embedders.fixed.some((source) => !KIND_SOURCES.has(source))) && (
            <ul aria-label="Pages that may show it" className="mt-1 flex flex-col">
              {embedders.fixed
                .filter((source) => !KIND_SOURCES.has(source))
                .map((source) => (
                  <li
                    key={`fixed:${source}`}
                    className="flex items-center gap-3 border-b border-l1 py-3 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-t1">{source}</span>
                    <span className="text-xs text-t3">Set when the app started</span>
                  </li>
                ))}
              {addresses.map((source) => (
                <li
                  key={source}
                  className="flex items-center gap-3 border-b border-l1 py-3 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-t1">{source}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${source}`}
                    onClick={() => void save(saved.filter((each) => each !== source))}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={add}>
            <Input
              aria-label="Another page's address"
              placeholder="https://notes.example.com"
              className="min-w-0 flex-1 basis-64 font-mono"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
            <Button type="submit" size="sm" variant="outline" disabled={address.trim() === ""}>
              Add
            </Button>
          </form>
        </>
      )}
      {problem !== null && embedders !== null && (
        <p role="alert" className="mt-2 text-sm text-bad-ink">
          {problem}
        </p>
      )}
    </section>
  );
}
