import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type ConfigEntry,
  ConfigStore,
  type ConfigWriteLayer,
  type ConfigWriteValue,
  type FolderPath,
} from "@omp-app/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { follow } from "../follow";
import type { Entries } from "./model";

/** The entries with `key`'s entry replaced, or taken out when there is none. */
function withEntry(entries: Entries, key: string, entry: ConfigEntry | undefined): Entries {
  const next = new Map(entries);
  if (entry === undefined) next.delete(key);
  else next.set(key, entry);
  return next;
}

/** Where the page reads and writes: every folder's settings file (`global`), or one folder's (`project`). */
export interface ConfigScope {
  readonly layer: ConfigWriteLayer;
  readonly folder: FolderPath | null;
}

export interface Config {
  readonly entries: Entries;
  readonly loaded: boolean;
  /** Why the settings could not be read. */
  readonly problem: string | null;
  /**
   * Writes one setting to the scope's file (a value, or a secret's set or unset), or with `"unset"` takes it out of
   * the file, so a lower layer or omp's default applies again.
   */
  readonly write: (key: string, value: ConfigWriteValue | "unset") => Promise<void>;
}

const words = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/** The settings in force for a scope, kept current by the config store's changes (another page's, a hand edit). */
export function useConfig(client: AppClient, scope: ConfigScope): Config {
  const { layer, folder } = scope;
  const [state, setState] = useState<{
    readonly entries: Entries;
    readonly loaded: boolean;
    readonly problem: string | null;
  }>({ entries: new Map(), loaded: false, problem: null });
  /** The scope's revision that every write is compared against. */
  const revision = useRef<string | null>(null);
  /** The entries as last shown, for a write to remember what it replaces. */
  const shownEntries = useRef(state.entries);
  useEffect(() => {
    shownEntries.current = state.entries;
  }, [state.entries]);
  const read = useCallback(async (): Promise<void> => {
    const listed = await client.port(ConfigStore).list({ folder });
    revision.current = listed.revision;
    setState({
      entries: new Map(listed.entries.map((entry) => [entry.key, entry])),
      loaded: true,
      problem: null,
    });
  }, [client, folder]);

  useEffect(() => {
    let active = true;
    setState({ entries: new Map(), loaded: false, problem: null });
    read().catch((failure: unknown) => {
      if (active) setState({ entries: new Map(), loaded: true, problem: words(failure) });
    });
    const stop = follow(
      client.subscribe(ConfigStore, "changed", { scope: folder ?? "global" }),
      (change: {
        readonly key: string;
        readonly revision: string;
        readonly entry: ConfigEntry;
      }) => {
        if (!active) return;
        revision.current = change.revision;
        setState((current) => ({
          ...current,
          entries: new Map(current.entries).set(change.key, change.entry),
        }));
      },
    );
    return () => {
      active = false;
      stop();
    };
  }, [client, folder, read]);

  /**
   * A value shows at once, as this scope's file will hold it, so a switch or a choice moves when it is clicked; the
   * server's entry replaces it when the write is done, and a write that fails puts back what was shown before (unless
   * something newer, another page's change, came meanwhile). A secret and Reset wait for the server, which alone knows
   * what applies after them.
   */
  const write = useCallback(
    async (key: string, value: ConfigWriteValue | "unset"): Promise<void> => {
      const port = client.port(ConfigStore);
      const before = shownEntries.current.get(key);
      const shown: ConfigEntry | undefined =
        value === "unset" || value.secret
          ? undefined
          : {
              key,
              secret: false,
              value: value.value,
              source: layer,
              overrides: before?.overrides ?? [],
            };
      const show = (): void => {
        if (shown !== undefined)
          setState((current) => ({ ...current, entries: withEntry(current.entries, key, shown) }));
      };
      const attempt = () => {
        const target = { key, layer, folder, expectedRevision: revision.current };
        return value === "unset" ? port.unset(target) : port.write({ ...target, value });
      };
      show();
      let result: Awaited<ReturnType<typeof attempt>>;
      try {
        try {
          result = await attempt();
        } catch (failure) {
          // Another write or a hand edit changed the file first: this one applies to the file as it is now.
          if (!(failure instanceof AppFailure) || failure.appError.code !== "conflict")
            throw failure;
          await read();
          show();
          result = await attempt();
        }
      } catch (failure) {
        if (shown !== undefined)
          setState((current) =>
            current.entries.get(key) === shown
              ? { ...current, entries: withEntry(current.entries, key, before) }
              : current,
          );
        throw failure;
      }
      revision.current = result.revision;
      setState((current) => ({
        ...current,
        entries: new Map(current.entries).set(key, result.entry),
      }));
    },
    [client, layer, folder, read],
  );

  return { ...state, write };
}
