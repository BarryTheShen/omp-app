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

  const write = useCallback(
    async (key: string, value: ConfigWriteValue | "unset"): Promise<void> => {
      const port = client.port(ConfigStore);
      const attempt = () => {
        const target = { key, layer, folder, expectedRevision: revision.current };
        return value === "unset" ? port.unset(target) : port.write({ ...target, value });
      };
      let result: Awaited<ReturnType<typeof attempt>>;
      try {
        result = await attempt();
      } catch (failure) {
        // Another write or a hand edit changed the file first: this one applies to the file as it is now.
        if (!(failure instanceof AppFailure) || failure.appError.code !== "conflict") throw failure;
        await read();
        result = await attempt();
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
