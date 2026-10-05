import { z } from "zod";
import { definePort } from "../../core/envelope";
import { FolderPath } from "../../core/ids";
import { PathText } from "./shared";

/** The local host's first DNS component, suitable for a compact status segment. */
export const Hostname = z.string().min(1).max(255);
export const HostMetadata = z.strictObject({
  hostname: Hostname,
  displayPath: PathText.max(4096),
});
export type HostMetadata = z.infer<typeof HostMetadata>;

export const HostMetadataReadArgs = z.strictObject({ folder: FolderPath });
export type HostMetadataReadArgs = z.infer<typeof HostMetadataReadArgs>;

export const HostMetadataPort = definePort({
  name: "A1.hostMetadata",
  methods: {
    read: {
      args: HostMetadataReadArgs,
      result: HostMetadata,
      capability: "host.metadata",
    },
  },
  events: {},
});
