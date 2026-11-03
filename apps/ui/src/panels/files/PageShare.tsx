import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type FolderPath,
  type Share,
  SharesPort,
  type WorkspaceRelativePath,
} from "@omp-app/contracts";
import { ExternalLink } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { useShareLink } from "../../shares/link";

/**
 * An HTML file of the folder as a page of its own (#2788): Share as a page opens its folder to the paired devices, so
 * its styles, scripts and pictures load with it; then Open in browser is a one-time link into it on this device. A
 * server from before shares shows neither.
 */
export function PageShare({
  client,
  folder,
  path,
}: {
  readonly client: AppClient;
  readonly folder: FolderPath;
  readonly path: WorkspaceRelativePath;
}): ReactNode {
  /** undefined while looking; null when the page is not shared (or shares are not there). */
  const [share, setShare] = useState<Share | null | undefined>(undefined);
  const [available, setAvailable] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    client
      .port(SharesPort)
      .list({})
      .then(
        (list) => {
          if (!live) return;
          setAvailable(list.address !== null);
          setShare(
            list.shares.find(
              (entry) => entry.kind === "page" && entry.folder === folder && entry.path === path,
            ) ?? null,
          );
        },
        () => {
          if (!live) return;
          setAvailable(false);
          setShare(null);
        },
      );
    return () => {
      live = false;
    };
  }, [client, folder, path]);
  if (share === undefined || !available) return null;
  if (share === null)
    return (
      <Button
        variant="ghost"
        size="sm"
        title={problem ?? "Opens this page's folder to your paired devices"}
        onClick={() =>
          client
            .port(SharesPort)
            .sharePage({ folder, path })
            .then(setShare, (failure: unknown) =>
              setProblem(
                failure instanceof AppFailure ? failure.appError.message : String(failure),
              ),
            )
        }
      >
        Share as a page
      </Button>
    );
  return <OpenPage client={client} share={share} />;
}

function OpenPage({
  client,
  share,
}: {
  readonly client: AppClient;
  readonly share: Share;
}): ReactNode {
  const { url, used } = useShareLink(client, share.id);
  if (url === null)
    return (
      <Button variant="ghost" size="sm" disabled>
        <ExternalLink /> Open in browser
      </Button>
    );
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={used}
      className={buttonVariants({ variant: "ghost", size: "sm" })}
    >
      <ExternalLink /> Open in browser
    </a>
  );
}
