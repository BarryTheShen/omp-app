import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type ConfigEntry,
  ConfigStore,
  type FolderPath,
  type PortClient,
} from "@omp-app/contracts";
import { z } from "zod";
import type { ShareSettings } from "./confirm";

/** The three `share.*` keys omp reads when `/share` runs (`commands/settings.ts:8-54`). */
const SHARE_KEYS = {
  serverUrl: "share.serverUrl",
  store: "share.store",
  redactSecrets: "share.redactSecrets",
} as const;

const ShareSettingsSchema = z.strictObject({
  serverUrl: z.string().min(1),
  store: z.enum(["blob", "gist"]),
  redactSecrets: z.boolean(),
});

type ConfigReader = Pick<PortClient<typeof ConfigStore>, "read">;

/** Reads the settings in force now. It rejects when one cannot be read, so a question is never asked without its destination. */
export type ShareSettingsReader = () => Promise<ShareSettings>;

/** The settings as omp will use them for the chat's folder, read through the typed config store (A1). */
export function createShareSettingsReader({
  client,
  folder,
}: {
  readonly client: Pick<AppClient, "port">;
  /** Read at each request, so the question names the folder the chat is in at that moment. */
  readonly folder: () => FolderPath | null;
}): ShareSettingsReader {
  const config: ConfigReader = client.port(ConfigStore);
  return async () => {
    const scope = folder();
    const [serverUrl, store, redactSecrets] = await Promise.all([
      readShareValue(config, SHARE_KEYS.serverUrl, scope),
      readShareValue(config, SHARE_KEYS.store, scope),
      readShareValue(config, SHARE_KEYS.redactSecrets, scope),
    ]);
    const parsed = ShareSettingsSchema.safeParse({ serverUrl, store, redactSecrets });
    if (!parsed.success) throw unreadable();
    return parsed.data;
  };
}

async function readShareValue(
  config: ConfigReader,
  key: string,
  folder: FolderPath | null,
): Promise<unknown> {
  let entry: ConfigEntry;
  try {
    entry = await config.read({ key, folder });
  } catch (error) {
    if (error instanceof AppFailure) throw error;
    throw unreadable(error);
  }
  return entry.secret ? undefined : entry.value;
}

function unreadable(cause?: unknown): AppFailure {
  return new AppFailure(
    {
      code: "unavailable",
      message: "The share settings could not be read, so nothing was shared.",
      retryable: true,
    },
    cause === undefined ? undefined : { cause },
  );
}
