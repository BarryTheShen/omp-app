import type { AppClient } from "@omp-app/client";
import { type FolderPath, HostMetadataPort } from "@omp-app/contracts";
import { useCallback, useEffect, useState } from "react";
import { homeOf, storedFolder, storeFolder } from "./folder";

/** The folder the app shows, and what goes with it. */
export interface FolderChoice {
  /** The folder whose chats the sidebar lists, and where New chat starts one. */
  readonly folder: FolderPath;
  /** The home folder on the server's computer, for `~`; null until it is known, or when it cannot be told. */
  readonly home: FolderPath | null;
  /** Why the folder chosen before is not the one shown; null otherwise. */
  readonly notice: string | null;
  readonly choose: (folder: FolderPath) => void;
}

/**
 * The folder chosen last in this browser (a launch link's folder counts as a choice), else the server's launch folder.
 * A chosen folder that can no longer be opened gives way to the launch folder, and a notice says so.
 */
export function useFolder(client: AppClient, launchFolder: FolderPath): FolderChoice {
  const [folder, setFolder] = useState<FolderPath>(() => storedFolder() ?? launchFolder);
  const [home, setHome] = useState<FolderPath | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    client
      .port(HostMetadataPort)
      .read({ folder: launchFolder })
      .then((shown) => {
        if (active) setHome(homeOf(launchFolder, shown.displayPath));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, launchFolder]);

  useEffect(() => {
    if (folder === launchFolder) return;
    let active = true;
    client
      .port(HostMetadataPort)
      .read({ folder })
      .catch(() => {
        if (!active) return;
        storeFolder(null);
        setFolder(launchFolder);
        setNotice(
          `The folder chosen before, ${folder}, could not be opened. This is ${launchFolder}.`,
        );
      });
    return () => {
      active = false;
    };
  }, [client, folder, launchFolder]);

  const choose = useCallback((next: FolderPath) => {
    storeFolder(next);
    setNotice(null);
    setFolder(next);
  }, []);

  return { folder, home, notice, choose };
}
