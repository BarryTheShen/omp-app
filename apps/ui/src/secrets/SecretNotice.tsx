import type { AppClient } from "@omp-app/client";
import { SecretStore, type SecretsChanged } from "@omp-app/contracts";
import { KeyRound, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { follow } from "../follow";
import { copySecret, wasSavedHere } from "./secrets";

/** Under the connection banner's place, so both can show at once. */
const PLACE =
  "fixed top-[calc(var(--safe-top)+3.75rem)] max-sm:top-[calc(var(--safe-top)+2.75rem+3.5rem)] left-[calc(50%+(var(--safe-left)-var(--safe-right))/2)] z-50 flex w-max max-w-[min(calc(90vw-var(--safe-left)-var(--safe-right)),560px)] -translate-x-1/2 items-center gap-2 rounded-lg border border-l3 bg-popover py-1.5 pr-1.5 pl-3.5 text-[0.8125rem] text-t1 shadow-lg";

const words = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/**
 * A secret saved somewhere other than this page (a chat's `… | omp-app secret add NAME`, a terminal, by hand): the
 * way a chat hands a value back without its AI seeing it. It stays until dismissed, with Copy for one secret; the
 * value goes from the server to the clipboard. All of them are in Settings → Providers → Secrets.
 */
export function SecretNotice({ client }: { readonly client: AppClient }): ReactNode {
  const [names, setNames] = useState<readonly string[]>([]);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(
    () =>
      follow(client.subscribe(SecretStore, "changed"), (changed: SecretsChanged) => {
        const elsewhere = changed.added.filter((name) => !wasSavedHere(name));
        if (elsewhere.length > 0) {
          setNames((shown) => [...shown.filter((name) => !elsewhere.includes(name)), ...elsewhere]);
          setSaid(null);
        }
        // One removed meanwhile is not offered for copying.
        const saved = new Set(changed.list.secrets.map((secret) => secret.name));
        setNames((shown) => shown.filter((name) => saved.has(name)));
      }),
    [client],
  );
  if (names.length === 0) return null;
  const [only] = names;
  return (
    <div role="status" aria-label="Saved secret" className={PLACE}>
      <KeyRound aria-hidden className="size-4 shrink-0 text-t3" />
      <span className="min-w-0 truncate">
        {said ??
          (names.length === 1
            ? `Saved a secret: ${only}. The AI only sees its placeholder.`
            : `Saved ${names.length} secrets: ${names.join(", ")}.`)}
      </span>
      {names.length === 1 && only !== undefined && (
        <Button
          size="sm"
          variant="ghost"
          className="max-sm:h-11 tablet:h-11"
          onClick={() =>
            void copySecret(client, only).then(
              () => setSaid(`${only} copied.`),
              (failure: unknown) => setSaid(`Could not copy ${only}: ${words(failure)}`),
            )
          }
        >
          Copy
        </Button>
      )}
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Dismiss"
        className="max-sm:size-11 tablet:size-11"
        onClick={() => {
          setNames([]);
          setSaid(null);
        }}
      >
        <X />
      </Button>
    </div>
  );
}
