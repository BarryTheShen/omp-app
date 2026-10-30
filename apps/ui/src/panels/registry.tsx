import type { AppClient } from "@omp-app/client";
import type { FolderPath } from "@omp-app/contracts";
import { Bot, Gauge, ListChecks, type LucideIcon, MessageCircleQuestion } from "lucide-react";
import type { ReactNode } from "react";
import type { ChatController } from "../chat/controller";
import { AgentsPanel } from "./agents/AgentsPanel";
import { BtwPanel } from "./btw/BtwPanel";
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

/** The panels in their order: usage, the subagents, the goal and the checklist, then the side questions. */
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
    id: "btw",
    title: "BTW history",
    icon: MessageCircleQuestion,
    render: ({ chat }) => <BtwPanel chat={chat} />,
  },
];
