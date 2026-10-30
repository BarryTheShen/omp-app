import type { AppClient } from "@omp-app/client";
import type { FolderPath } from "@omp-app/contracts";
import { Gauge, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { ChatController } from "../chat/controller";
import { UsagePanel } from "./usage/UsagePanel";

/** What a panel draws from: the app's client, the open folder, and the focused pane's chat (null when none is). */
export interface PanelContext {
  readonly client: AppClient;
  readonly folder: FolderPath;
  readonly chat: ChatController | null;
}

/**
 * A panel of the side column: its tab and what it draws. A new panel is one file under `panels/` and one line below,
 * with a tour of its own.
 */
export interface Panel {
  readonly id: string;
  readonly title: string;
  readonly icon: LucideIcon;
  readonly render: (context: PanelContext) => ReactNode;
}

export const PANELS: readonly Panel[] = [
  {
    id: "usage",
    title: "Usage",
    icon: Gauge,
    render: ({ client, chat }) => <UsagePanel client={client} chat={chat} />,
  },
];
