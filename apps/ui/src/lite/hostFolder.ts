import type { AppClient } from "@omp-app/client";
import { AppPort, type FolderPath } from "@omp-app/contracts";
import { useEffect, useState } from "react";
import { embed, useEmbed } from "./embed";

/** Where the panel's chats run, or why they cannot yet. */
export type PanelFolder =
  | { readonly kind: "ready"; readonly folder: FolderPath }
  | { readonly kind: "waiting" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * The folder the lite view's chats run in: the one the full app chose (`chosen`), or, when the framing app's `hello` says
 * the project's files are on its own computer (`files`, VS Code on a laptop), the server's folder for that project
 * (`A0.app.hostFolder`), whose chats work on the host's files through the host's tools. In a frame, the view waits for
 * the host's `hello` first, so a chat never starts in the wrong folder.
 */
export function usePanelFolder(client: AppClient, chosen: FolderPath): PanelFolder {
  const { host, files } = useEmbed();
  const [helloSettled, setHelloSettled] = useState(() => embed === null || host !== null);
  const [asked, setAsked] = useState<PanelFolder>({ kind: "waiting" });

  useEffect(() => {
    if (helloSettled || embed === null) return;
    let live = true;
    void embed.helloSettled().then(() => {
      if (live) setHelloSettled(true);
    });
    return () => {
      live = false;
    };
  }, [helloSettled]);

  const project = files?.project;
  const id = files?.id;
  useEffect(() => {
    if (host === null || project === undefined || id === undefined) return;
    let live = true;
    client
      .port(AppPort)
      .hostFolder({ host, project, id })
      .then(
        (answer) => {
          if (live) setAsked({ kind: "ready", folder: answer.folder });
        },
        (failure: unknown) => {
          if (!live) return;
          const text = failure instanceof Error ? failure.message : String(failure);
          setAsked({
            kind: "failed",
            // A server from before host folders does not know the method.
            message: text.includes("Unknown method")
              ? "This app server cannot work on files on another computer yet; it needs an update."
              : `The project's folder could not be made: ${text}`,
          });
        },
      );
    return () => {
      live = false;
    };
  }, [client, host, project, id]);

  if (!helloSettled) return { kind: "waiting" };
  if (files === null) return { kind: "ready", folder: chosen };
  return asked;
}
