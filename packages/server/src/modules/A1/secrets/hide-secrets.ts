import { AppFailure } from "@omp-app/contracts";
import type { ConfigStoreService } from "../config";
import type { HideSecretsSetting } from "./store";

/** omp's setting that hides secrets from the AI (its Settings → Providers → Privacy → Hide Secrets). */
const KEY = "secrets.enabled";

/** A write that found the file changed since it was read is tried again on the file as it is: this many times. */
const ATTEMPTS = 3;

/** omp's Hide Secrets through the app's config store, so omp's file, its watchers and the Settings page stay one. */
export function hideSecretsThrough(config: ConfigStoreService): HideSecretsSetting {
  const read = async (): Promise<{ readonly on: boolean; readonly revision: string }> => {
    const listed = await config.list({ folder: null, prefix: KEY });
    const entry = listed.entries.find((candidate) => candidate.key === KEY);
    return {
      on: entry !== undefined && !entry.secret && entry.value === true,
      revision: listed.revision,
    };
  };
  return {
    isOn: async () => (await read()).on,
    turnOn: async () => {
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const { on, revision } = await read();
        if (on) return;
        try {
          await config.write({
            key: KEY,
            layer: "global",
            value: { secret: false, value: true },
            folder: null,
            expectedRevision: revision,
          });
          return;
        } catch (failure) {
          if (!(failure instanceof AppFailure && failure.appError.code === "conflict"))
            throw failure;
        }
      }
      throw new AppFailure({
        code: "conflict",
        message:
          "Hide Secrets could not be turned on: omp's settings kept changing. Turn it on in Settings → Providers, under Privacy.",
        retryable: true,
      });
    },
    onChange: (listener) =>
      config.onChanged(null, (change) => {
        if (change.key === KEY) listener();
      }),
  };
}
