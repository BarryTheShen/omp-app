import type { AppClient } from "@omp-app/client";
import type { FolderPath, WorkspaceRelativePath } from "@omp-app/contracts";
import {
  Bot,
  FolderTree,
  Gauge,
  Layers,
  ListChecks,
  type LucideIcon,
  MessageCircleQuestion,
  Network,
} from "lucide-react";
import type { ReactNode } from "react";
import type { ChatController } from "../chat/controller";
import { AgentsPanel } from "./agents/AgentsPanel";
import { BtwPanel } from "./btw/BtwPanel";
import { FilesPanel } from "./files/FilesPanel";
import { JobsPanel } from "./jobs/JobsPanel";
import { PortsPanel } from "./ports/PortsPanel";
import { ProgressPanel } from "./progress/ProgressPanel";
import { UsagePanel } from "./usage/UsagePanel";

/**
 * What a panel draws from: the app's client, the open folder, the focused pane's chat (null when none is), and the
 * app's dialogs a panel may open.
 */
export interface PanelContext {
  readonly client: AppClient;
  readonly folder: FolderPath;
  readonly chat: ChatController | null;
  /** Opens the goal dialog for a chat (the palette's "Set a goal for this chat…"). */
  readonly openGoal: (chat: ChatController) => void;
  /** Opens a file of the folder as a pane beside the chats (the Files panel's Open as tab); none on a phone. */
  readonly openFileTab?: (path: WorkspaceRelativePath) => void;
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

/**
 * The panels in their order: usage, the subagents, the goal and the checklist, the background jobs, then the side
 * questions.
 */
export const PANELS: readonly Panel[] = [
  {
    id: "usage",
    title: "Usage",
    icon: Gauge,
    render: ({ client, chat }) => <UsagePanel client={client} chat={chat} />,
  },
  {
    id: "agents",
    title: "Agents",
    icon: Bot,
    render: ({ chat }) => <AgentsPanel chat={chat} />,
  },
  {
    id: "progress",
    title: "Progress",
    icon: ListChecks,
    render: ({ chat, openGoal }) => <ProgressPanel chat={chat} openGoal={openGoal} />,
  },
  {
    id: "jobs",
    title: "Jobs",
    icon: Layers,
    render: ({ client, chat }) => <JobsPanel client={client} chat={chat} />,
  },
  {
    id: "btw",
    title: "BTW history",
    icon: MessageCircleQuestion,
    render: ({ chat }) => <BtwPanel chat={chat} />,
  },
  {
    id: "files",
    title: "Files",
    icon: FolderTree,
    render: ({ client, folder, chat, openFileTab }) => (
      <FilesPanel
        client={client}
        folder={folder}
        chat={chat}
        {...(openFileTab === undefined ? {} : { openFileTab })}
      />
    ),
  },
  {
    id: "ports",
    title: "Ports",
    icon: Network,
    render: ({ client }) => <PortsPanel client={client} />,
  },
];
