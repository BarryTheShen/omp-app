import type { AppClient } from "@omp-app/client";
import { SecretStore, type SecretsChanged, type SecretsList } from "@omp-app/contracts";
import { useCallback, useEffect, useState } from "react";
import { writeClipboard } from "../clipboard";
import { follow } from "../follow";

const words = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/** How long a name this page saved is its own: the notice for a secret saved elsewhere leaves it out. */
const OWN_MS = 30_000;
const savedHere = new Map<string, number>();

/** Notes a secret this page saved, so the notice of secrets saved elsewhere (a chat's command) leaves it out. */
export function markSavedHere(name: string): void {
  savedHere.set(name, Date.now());
}

export function wasSavedHere(name: string): boolean {
  const at = savedHere.get(name);
  return at !== undefined && Date.now() - at < OWN_MS;
}

/** omp's saved secrets (`A1.secretStore`): read once, then every change from anywhere. */
export function useSecrets(client: AppClient): {
  readonly list: SecretsList | null;
  readonly problem: string | null;
  readonly read: () => Promise<void>;
} {
  const [list, setList] = useState<SecretsList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const read = useCallback(async (): Promise<void> => {
    try {
      setList(await client.port(SecretStore).list({}));
      setProblem(null);
    } catch (failure) {
      setProblem(`omp's secrets could not be read: ${words(failure)}`);
    }
  }, [client]);
  useEffect(() => {
    void read();
    return follow(client.subscribe(SecretStore, "changed"), (changed: SecretsChanged) => {
      setList(changed.list);
      setProblem(null);
    });
  }, [client, read]);
  return { list, problem, read };
}

/** Copies a saved secret's value: it goes from the server to the clipboard, never into a chat. */
export function copySecret(client: AppClient, name: string): Promise<void> {
  return writeClipboard(
    client
      .port(SecretStore)
      .reveal({ name })
      .then((revealed) => revealed.value),
  );
}

/** What opens "Add a secret" in a chat's message box: its button, its ＋ row, or the palette. */
export class AddSecretToggle {
  #open = false;
  readonly #listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): boolean => this.#open;

  show(): void {
    this.#set(true);
  }

  hide(): void {
    this.#set(false);
  }

  #set(open: boolean): void {
    if (this.#open === open) return;
    this.#open = open;
    for (const listener of [...this.#listeners]) listener();
  }
}
