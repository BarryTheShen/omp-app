import type { KEYS } from "../keys/table";

export type KeyId = keyof typeof KEYS;

/** What moves a tour on from a step. */
export type TourAction =
  /** The popover's Next button. */
  | { readonly kind: "next" }
  /** A click on the highlighted element. */
  | { readonly kind: "click" }
  /** A key of that binding (any of its alternatives). */
  | { readonly kind: "keys"; readonly key: KeyId }
  /** An element matching the selector exists. */
  | { readonly kind: "appears"; readonly selector: string }
  /** No element matches the selector. */
  | { readonly kind: "disappears"; readonly selector: string };

export interface TourStep {
  /** A CSS selector; null is a centred popover. */
  readonly target: string | null;
  readonly title: string;
  /** `{keyId}` becomes a keycap; `<b>` is allowed, no other markup. */
  readonly text: string;
  readonly action: TourAction;
  /**
   * The popover sits in the middle of the window instead of beside the target: for a target as big as the workspace
   * there is no room beside it, and driver.js would put the popover at the bottom, over the message box.
   */
  readonly centred?: true;
  /** Only when the desktop window's bridge exists. */
  readonly desktopOnly?: true;
  /** Only on a phone's layout (`isPhone`). */
  readonly phoneOnly?: true;
  /** Only on a tablet (`isTablet`): a touch screen wider than a phone. */
  readonly tabletOnly?: true;
  /**
   * The dimmed page stays usable during this step: its action ends outside the highlighted element (a chat dragged
   * from the list onto a pane).
   */
  readonly throughOverlay?: true;
}

export interface Tour {
  readonly id: string;
  readonly title: string;
  readonly minutes: number;
  /** Opens a new tab with a new chat first, so nothing the tour has you try touches your chats. */
  readonly sandbox: boolean;
  readonly steps: readonly TourStep[];
}

const part = (name: string): string => `[data-tour="${name}"]`;
const next: TourAction = { kind: "next" };
const keys = (key: KeyId): TourAction => ({ kind: "keys", key });

const CHAT_LIST = part("chat-list");
const SEARCH_CHATS = part("search-chats");
const TABS = part("tabs");
const WORKSPACE = part("workspace");
const MESSAGE_BOX = part("message-box");
const MENU = part("composer-menu");
const AGENT_HUB = '[aria-label="Agent Hub"]';
const PALETTE = part("palette");
const KEY_LIST = part("keys");
const SETTINGS_SHEET = part("settings-sheet");

const PANES: Tour = {
  id: "workspace-2026-10-30",
  title: "Your chats, tabs and panes",
  minutes: 3,
  sandbox: true,
  steps: [
    {
      target: CHAT_LIST,
      title: "Your chats",
      text: "The chats in this folder, newest first. Chats waiting for an approval or an answer move up under <b>Needs you</b>; pinned chats come next.",
      action: next,
    },
    {
      target: SEARCH_CHATS,
      title: "Find a chat",
      text: "Type here to narrow the list.",
      action: next,
    },
    {
      target: TABS,
      title: "A tab to try things in",
      text: "This tour opened a new tab with an empty chat, so nothing you try touches your chats. {nextTab} and {previousTab} move between tabs; {renameTab} names one.",
      action: next,
    },
    {
      target: TABS,
      title: "More windows",
      text: "In the desktop window, {newWindow} opens another window on the same server, with one empty tab of its own. Closing a window leaves the others open.",
      action: next,
      desktopOnly: true,
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Split the screen",
      text: "Press {splitRight} to open a new chat to the right.",
      action: keys("splitRight"),
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Move between panes",
      text: "{focusPane} goes to the pane in that direction; {cyclePane} to the next one. Try one.",
      action: keys("focusPane"),
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Zoom",
      text: "Press {zoom} to let this pane fill the tab.",
      action: keys("zoom"),
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Zoom back",
      text: "Press {zoom} again to bring the other pane back.",
      action: keys("zoom"),
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Close a pane",
      text: "Press {closePane} to close this one.",
      action: keys("closePane"),
    },
    {
      target: CHAT_LIST,
      title: "Several chats at once",
      text: "Alt+click a chat to open it beside the one you're in. {equalize} shares the space equally; {resizePane} makes a pane bigger or smaller.",
      action: next,
    },
    {
      target: part("theme"),
      title: "Light or dark",
      text: "Match the system, or always light or dark.",
      action: next,
    },
    {
      target: TABS,
      title: "Done here",
      text: "Close the tour's tab with {closeTab}.",
      action: keys("closeTab"),
    },
  ],
};

const MESSAGE_BOX_TOUR: Tour = {
  id: "message-box-2026-10-30",
  title: "The message box",
  minutes: 3,
  sandbox: true,
  steps: [
    {
      target: MESSAGE_BOX,
      title: "Write here",
      text: "{send} sends. While omp works, {send} steers it, {followUp} queues a follow-up and {stop} stops it. {newline} starts a new line.",
      action: next,
    },
    {
      target: MESSAGE_BOX,
      title: "omp's commands",
      text: "Type <b>/</b> to see omp's commands.",
      action: { kind: "appears", selector: MENU },
    },
    {
      target: MESSAGE_BOX,
      title: "Mention a file",
      text: "Delete the /, then type <b>@</b> and part of a file name.",
      action: { kind: "appears", selector: `${MENU}[data-kind="file"]` },
    },
    {
      target: MESSAGE_BOX,
      title: "Run a command",
      text: "Clear the box and type <b>!</b>: it becomes a shell command that runs without the model; <b>$</b> runs Python. Clear it again afterwards.",
      action: { kind: "appears", selector: part("shell-mode") },
    },
    {
      target: part("model"),
      title: "The model",
      text: "{model} opens omp's models (or click here). Try it, then {stop} to close the list.",
      action: keys("model"),
    },
    {
      target: part("thinking"),
      title: "Thinking",
      text: "{thinkingLevel} steps through thinking levels (or click the ring). Try it.",
      action: keys("thinkingLevel"),
    },
    {
      target: part("plan"),
      title: "Plan mode",
      text: "{planMode} turns plan mode on: omp plans first and you approve the plan before it changes anything. Try it.",
      action: keys("planMode"),
    },
    {
      target: part("plan"),
      title: "Plan mode off",
      text: "Press {planMode} again to turn it off.",
      action: keys("planMode"),
    },
    {
      target: MESSAGE_BOX,
      title: "Pictures and drafts",
      text: "Paste or drop pictures here. What you type is kept, even across reloads, and you can type before a chat is ready.",
      action: next,
    },
    {
      target: TABS,
      title: "Done here",
      text: "Close the tour's tab with {closeTab}.",
      action: keys("closeTab"),
    },
  ],
};

const INSIDE_A_CHAT: Tour = {
  id: "inside-a-chat-2026-10-30",
  title: "Inside a chat",
  minutes: 2,
  sandbox: false,
  steps: [
    {
      target: WORKSPACE,
      centred: true,
      title: "Tool cards",
      text: "{foldTools} opens or folds every tool card. Try it.",
      action: keys("foldTools"),
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Fold them back",
      text: "Press {foldTools} again.",
      action: keys("foldTools"),
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Thinking",
      text: "{foldThinking} shows or hides omp's thinking. Try it.",
      action: keys("foldThinking"),
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Switch it back",
      text: "Press {foldThinking} again.",
      action: keys("foldThinking"),
    },
    {
      target: MESSAGE_BOX,
      title: "The Agent Hub",
      text: "{agentHub} opens the Agent Hub: each subagent of this chat with its live log, Kill, and a message to it while it runs.",
      action: { kind: "appears", selector: AGENT_HUB },
    },
    {
      target: AGENT_HUB,
      title: "Close the Hub",
      text: "Press {agentHub} again to close it.",
      action: { kind: "disappears", selector: AGENT_HUB },
    },
    {
      target: part("todos"),
      title: "Todos",
      text: "When omp keeps a todo list, this pill shows how far it got; click it for the checklist.",
      action: next,
    },
    {
      target: MESSAGE_BOX,
      title: "Goals",
      text: "In the palette ({palette}), “Set a goal for this chat…” gives omp an objective and a token budget. The goal chip then offers Pause, Resume and Drop.",
      action: next,
    },
    {
      target: MESSAGE_BOX,
      title: "When omp asks",
      text: "Approvals and questions appear above the box: {followUp} approves, {stop} denies, and questions mark the recommended answer.",
      action: next,
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Fixing a turn",
      text: "A failed request offers Retry ({retry}) and Switch model. Hover your own message for Edit: it sends again from there.",
      action: next,
    },
  ],
};

const PALETTE_AND_SETTINGS: Tour = {
  id: "palette-settings-2026-10-30",
  title: "Palette, keys and settings",
  minutes: 2,
  sandbox: false,
  steps: [
    {
      target: WORKSPACE,
      centred: true,
      title: "The palette",
      text: "{palette} opens the palette: commands, files, chats and models. Try it.",
      action: { kind: "appears", selector: PALETTE },
    },
    {
      target: PALETTE,
      title: "Narrow it",
      text: "The tabs at the top narrow it to one kind; type to search. {stop} closes it.",
      action: { kind: "disappears", selector: PALETTE },
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Every key",
      text: "{shortcuts} lists every key in the app. Try it.",
      action: { kind: "appears", selector: KEY_LIST },
    },
    {
      target: KEY_LIST,
      title: "Close the list",
      text: "{stop} closes it.",
      action: { kind: "disappears", selector: KEY_LIST },
    },
    {
      target: part("settings"),
      title: "Settings",
      text: "{settings} or this gear opens settings: the app's own, then every omp setting, with search. Changed ones get a dot and Reset. Try it.",
      action: { kind: "appears", selector: SETTINGS_SHEET },
    },
    {
      target: SETTINGS_SHEET,
      title: "Your servers",
      text: "In the desktop window, App → Server switches between your servers.",
      action: next,
      desktopOnly: true,
    },
    {
      target: SETTINGS_SHEET,
      title: "Close settings",
      text: "{stop} closes settings.",
      action: { kind: "disappears", selector: SETTINGS_SHEET },
    },
  ],
};

const FOLDER = part("folder");
const FOLDER_MENU = part("folder-menu");

const FOLDERS: Tour = {
  id: "folders-2026-10-30",
  title: "Folders",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: FOLDER,
      title: "Your folder",
      text: "omp works in a folder, and the list shows that folder's chats. New chat starts one here.",
      action: next,
    },
    {
      target: FOLDER,
      title: "Switch folders",
      text: "Click here: it lists the folders that have chats, and <b>Open a folder…</b> takes any path.",
      action: { kind: "appears", selector: FOLDER_MENU },
    },
    {
      target: FOLDER_MENU,
      title: "Pick one",
      text: "Pick a folder to see its chats, or press {stop} to stay here. The app remembers the folder you pick.",
      action: { kind: "disappears", selector: FOLDER_MENU },
    },
  ],
};

const MODELS_AND_ROLES: Tour = {
  id: "models-roles-2026-10-30",
  title: "Models and roles",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: part("model"),
      title: "Roles",
      text: "{nextRole} switches this chat to the next role's model, as in omp: its roles, such as smol, default and slow. Try it.",
      action: keys("nextRole"),
    },
    {
      target: part("model"),
      title: "And back",
      text: "The roles showed above the box for a moment, the one in use filled; the chip names it. {previousRole} goes back.",
      action: keys("previousRole"),
    },
    {
      target: part("model"),
      title: "Any model",
      text: "{model} picks any model for this chat only (or click here). {modelHub} sets which model each role uses.",
      action: next,
    },
  ],
};

const MODEL_MENU = part("model-menu");

/**
 * The model menu's own steps act inside the menu (a click on the tour's Next lands outside it and closes it), so the
 * only Next is the last step's.
 */
const MODEL_MENU_TOUR: Tour = {
  id: "model-menu-2026-10-30",
  title: "Your model menu",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: part("model"),
      title: "The model menu",
      text: "Click the model, or press {model}.",
      action: { kind: "appears", selector: MODEL_MENU },
    },
    {
      target: part("model-star"),
      title: "Star a model",
      text: "Starred models come first, under <b>Favorites</b>, on every device you use. Click the star (or press {starModel}) to star or unstar the highlighted model.",
      action: { kind: "click" },
    },
    {
      target: MODEL_MENU,
      title: "Favorites, Recent, then the rest",
      text: "After your stars come the models omp used last, then each provider's models, newest first. The eye beside a model hides it ({hideModel}): hidden models wait folded at the bottom, and the search still finds them.",
      action: next,
    },
  ],
};

const BTW_PANEL = part("btw-panel");
const SIDE_PANEL_RAIL = part("side-panel-rail");
const SIDE_PANEL = part("side-panel");

const SIDE_QUESTIONS: Tour = {
  id: "side-questions-2026-10-30",
  title: "Side questions",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: MESSAGE_BOX,
      title: "Ask on the side",
      text: "Type <b>/btw</b>, take it from the menu with Enter, and press Enter again: the side panel opens on the BTW history, where omp keeps this chat's side questions.",
      action: { kind: "appears", selector: BTW_PANEL },
    },
    {
      target: BTW_PANEL,
      title: "Your side questions",
      text: "<b>/btw</b> with a question asks omp about this chat on the side, also while it works: the answer comes here, beside the chat, and stays out of it. <b>Follow up</b> asks more, <b>Copy answer</b> copies it. Put the panel away and an answer still coming goes on; the chat says when it is ready.",
      action: next,
    },
    {
      target: SIDE_PANEL_RAIL,
      title: "Find it again",
      text: "<b>/btw</b> opens it again, as do its button on this rail and {palette}.",
      action: next,
    },
  ],
};

const SIDE_PANEL_TOUR: Tour = {
  id: "side-panel-2026-10-30",
  title: "Side panel and usage",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: SIDE_PANEL_RAIL,
      title: "Side panel",
      text: "This rail at the right edge opens the side panel beside your chats, on the panel you click; {sidePanel} shows and hides it too. Click <b>Usage</b>, the first one.",
      action: { kind: "appears", selector: SIDE_PANEL },
    },
    {
      target: SIDE_PANEL,
      title: "Usage",
      text: "The chat you are in: how full its context is, and its messages, tokens and cost, as omp's <b>/session</b> counts them, read again after every reply. Below, your accounts' limits and when they reset.",
      action: next,
    },
    {
      target: SIDE_PANEL_RAIL,
      title: "Hide it",
      text: "Click the panel's button again, or {sidePanel}; the palette has it too. It stays as you leave it.",
      action: { kind: "disappears", selector: SIDE_PANEL },
    },
  ],
};

const MODEL_HUB = part("model-hub");

const MODEL_HUB_TOUR: Tour = {
  id: "model-hub-2026-10-30",
  title: "A model for each role",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: MESSAGE_BOX,
      title: "Models",
      text: "{modelHub} opens omp's Models: which model each of omp's roles uses. Try it.",
      action: { kind: "appears", selector: MODEL_HUB },
    },
    {
      target: MODEL_HUB,
      title: "Each role's model",
      text: "The roles are on the left, each with its model (<b>auto</b> is omp's own pick). Choosing a model on the right gives it to the role: <b>Default</b> also switches this chat; the others serve {nextRole} and omp's own work (subagents, commit messages, …). The chips set the role's thinking, <b>Clear role</b> hands it back to omp. {stop} closes it; the palette has it too.",
      action: { kind: "disappears", selector: MODEL_HUB },
    },
  ],
};

const AGENTS_PROGRESS_TOUR: Tour = {
  id: "agents-progress-2026-10-30",
  title: "Agents and progress",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: SIDE_PANEL_RAIL,
      title: "The side panel",
      text: "This rail at the right edge, or {sidePanel}, shows the side panel. Try it.",
      action: { kind: "appears", selector: SIDE_PANEL },
    },
    {
      target: SIDE_PANEL_RAIL,
      title: "Four panels",
      text: "<b>Usage</b>; <b>Agents</b>: the chat's subagents (a click opens the Agent Hub on one); <b>Progress</b>: its goal, omp's todo list and plan mode; and <b>BTW history</b>: its side questions. They follow the chat you are in.",
      action: next,
    },
    {
      target: SIDE_PANEL_RAIL,
      title: "Hide it",
      text: "Click the panel's button again, or {sidePanel}.",
      action: { kind: "disappears", selector: SIDE_PANEL },
    },
  ],
};

const NOTES_TOUR: Tour = {
  id: "notes-2026-10-30",
  title: "Notes above the box",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: MESSAGE_BOX,
      title: "omp's short notes",
      text: "omp's short notes now show just above the message box for a few seconds, then fade, as in Tern: a side answer ready, only one role model, an action that failed. What a command prints, and why a chat could not open, still stay in the chat. Windows and menus now open with Tern's short pop.",
      action: next,
    },
  ],
};

const INBOX_BUTTON = part("inbox-button");
const INBOX = part("inbox");

const INBOX_TOUR: Tour = {
  id: "inbox-2026-10-30",
  title: "Your inbox",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: INBOX_BUTTON,
      title: "The inbox",
      text: "Chats waiting for you, and turns that end while you are in another pane, tab or window, gather behind this bell, as in Tern; the number counts them. Open it.",
      action: { kind: "appears", selector: INBOX },
    },
    {
      target: INBOX,
      title: "Back to a chat",
      text: "A row takes you to its chat, and looking at a chat clears what it finished with. <b>Clear</b> empties the finished rows; a chat waiting for your answer stays until you answer it.",
      action: next,
    },
  ],
};

const SIDE_RAIL_TOUR: Tour = {
  id: "side-rail-2026-10-30",
  title: "The side panel on the right",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: SIDE_PANEL_RAIL,
      title: "One button per panel",
      text: "The side panel's buttons are on this rail at the right edge, where the panel opens: <b>Usage</b>, <b>Agents</b>, <b>Progress</b> and the new <b>BTW history</b>. A button opens the panel on its panel; the same button again puts it away. Click <b>BTW history</b>, the last one.",
      action: { kind: "appears", selector: BTW_PANEL },
    },
    {
      target: BTW_PANEL,
      title: "Side questions beside the chat",
      text: "<b>/btw</b> no longer covers the screen: its questions and answers stay here, next to the chat, which you can keep reading and using.",
      action: next,
    },
  ],
};

const JOBS_PANEL = part("jobs-panel");

const JOBS_TOUR: Tour = {
  id: "jobs-2026-10-31",
  title: "Background jobs",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: SIDE_PANEL_RAIL,
      title: "A Jobs panel",
      text: "Click <b>Jobs</b> on this rail: the side panel opens on this chat's background jobs.",
      action: { kind: "appears", selector: JOBS_PANEL },
    },
    {
      target: JOBS_PANEL,
      title: "What runs in the background",
      text: "The commands and subagents omp sends to the background, while they run and for a few minutes after. Click a command for its output; <b>Cancel job</b> there stops one of this chat's own. A subagent opens in the Agent Hub.",
      action: next,
    },
  ],
};

const FILES_PANEL = part("files-panel");

/** #2782: the chat folder's files in the side panel. */
const FILES_TOUR: Tour = {
  id: "files-2026-11-01",
  title: "Files",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: SIDE_PANEL_RAIL,
      title: "A Files panel",
      text: "Click <b>Files</b> on this rail: the side panel opens on the chat folder's files, from any device.",
      action: { kind: "appears", selector: FILES_PANEL },
    },
    {
      target: FILES_PANEL,
      title: "See, change and hand over files",
      text: "Click a file to see it below the list; text has <b>Edit</b> and <b>Save</b>, and a file changed on disk since you opened it is never overwritten without asking. Drop files here to upload them. A row's menu makes, renames, deletes (with Undo), downloads, and puts a file's name in your chat.",
      action: next,
    },
  ],
};

const PAUSED_ROW = part("paused");

const PAUSE_TOUR: Tour = {
  id: "pause-2026-10-31",
  title: "Pause a chat",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: MESSAGE_BOX,
      title: "Pause a chat",
      text: "Type <b>/pause</b> here and send it. Every agent of this chat (the main one, its subagents and the advisor) holds at its next step, as omp's /pause does; a reply or tool already under way finishes. While omp works, <b>Pause</b> sits beside “esc to stop”.",
      action: { kind: "appears", selector: PAUSED_ROW },
    },
    {
      target: PAUSED_ROW,
      title: "Paused",
      text: "The clock counts how long. Messages you send now wait. Click <b>Resume</b>, or press Esc, Enter or Space in the empty box, to go on.",
      action: { kind: "disappears", selector: PAUSED_ROW },
    },
    {
      target: SIDE_PANEL_RAIL,
      title: "Every chat at once",
      text: "<b>Pause all chats</b> is at the top of the side panel's <b>Jobs</b>, and in the palette ({palette}), with <b>Resume all chats</b>.",
      action: next,
    },
  ],
};

const PAUSE_LIST_TOUR: Tour = {
  id: "pause-list-2026-10-31",
  title: "Paused chats in the list",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: CHAT_LIST,
      title: "Paused chats",
      text: "A paused chat has a pause mark before its title here, in every window that shows the list, also when the chat is open somewhere else. Pause a chat with <b>/pause</b>, or <b>Pause</b> beside “esc to stop”.",
      action: next,
    },
  ],
};

/** The shown tab holds more than one pane. */
const SPLIT_TAB = "[data-tab][data-split]:not([hidden])";

const ARRANGE_TOUR: Tour = {
  id: "arrange-2026-10-30",
  title: "Arrange your windows",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: CHAT_LIST,
      title: "Drag a chat into a split",
      text: "Drag a chat from this list onto the chat on the right: guides appear in its middle. Let go on an arrow and it opens on that side; on the middle guide it takes that chat's place. The guide it will take lights up while you drag.",
      action: { kind: "appears", selector: SPLIT_TAB },
      throughOverlay: true,
    },
    {
      target: SIDE_PANEL_RAIL,
      title: "The side panel is a pane too",
      text: "Click <b>Usage</b>, or press {sidePanel}: the side panel opens as a pane at the right of your chats.",
      action: { kind: "appears", selector: SIDE_PANEL },
    },
    {
      target: SIDE_PANEL,
      title: "Size it as you like",
      text: "Drag the line between it and the chat to make it wider or narrower, or drag its title to move it, as with a chat. Each tab keeps its own, also after a reload.",
      action: next,
    },
  ],
};

const WHATS_NEW_BUTTON = part("whats-new-button");
const WHATS_NEW_LIST = part("whats-new-list");

const WHATS_NEW_TOUR: Tour = {
  id: "whats-new-2026-10-30",
  title: "Updates and their tours",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: WHATS_NEW_BUTTON,
      title: "Every update in one place",
      text: "This button lists each update of the app, newest first, with the tours it brought. Open it.",
      action: { kind: "appears", selector: WHATS_NEW_LIST },
    },
    {
      target: WHATS_NEW_LIST,
      title: "Take any tour again",
      text: "Each update has its date, a line on what it added, and its tours; a tour you took says <b>Taken</b>. After an update, a card at the foot of your chat list names its new tours, and <b>Take the tours</b> shows them one after another.",
      action: next,
    },
  ],
};

const IPHONE_TOUR: Tour = {
  id: "iphone-2026-10-30",
  title: "omp on your iPhone",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: WORKSPACE,
      centred: true,
      title: "On your Home Screen",
      text: "On an iPhone, open the app's address in Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>. omp then opens from its icon, full screen, and keeps clear of the notch and the home bar. The first time it opens, pair it: allow it on a device that is already paired, or enter a one-time code.",
      action: next,
    },
    {
      target: MESSAGE_BOX,
      title: "Typing on a phone",
      text: "The message box stays above the keyboard while you type, and the page no longer zooms in when you tap a field.",
      action: next,
    },
  ],
};

const PHONE_TOUR: Tour = {
  id: "phone-2026-10-31",
  title: "Your phone's controls",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: part("phone-keys"),
      title: "The keys a phone lacks",
      text: "Under the box: <b>⚡</b> quick prompts, the model, the thinking level and plan mode, then <b>/</b> commands, <b>@</b> files, <b>!</b> the shell, and <b>↑ ↓</b> for what you sent. A key leaves the keyboard up; the row scrolls sideways.",
      action: next,
    },
    {
      target: part("quick-prompts-key"),
      title: "Quick prompts",
      text: "<b>⚡</b> puts your quick prompts where the keyboard was, and <b>⌨</b> brings the keyboard back. Open them.",
      action: { kind: "appears", selector: part("quick-panel") },
    },
    {
      target: part("quick-panel"),
      title: "One tap answers",
      text: "Tap a prompt to send it as it is, or hold it to put it in the box and change it first. <b>Sent</b> lists what you sent in this chat; a tap puts one back in the box.",
      action: next,
    },
    {
      target: part("phone-top-bar"),
      title: "Your chats",
      text: "The app opens on a new chat. <b>Chats</b> opens the list, and the pencil starts another chat. In the list, hold a chat to pin, rename or delete it.",
      action: next,
    },
  ],
};

const PROVIDER_ACCOUNTS = part("provider-accounts");

const PROVIDER_ACCOUNTS_TOUR: Tour = {
  id: "provider-accounts-2026-10-31",
  title: "Your provider accounts",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: part("settings"),
      title: "Settings",
      text: "{settings} or this gear opens settings. Open them.",
      action: { kind: "appears", selector: SETTINGS_SHEET },
    },
    {
      target: part("settings-tab-providers"),
      title: "Providers",
      text: "Your sign-ins are at the top of <b>Providers</b>. Open it.",
      action: { kind: "appears", selector: part("provider-sign-in") },
    },
    {
      target: PROVIDER_ACCOUNTS,
      title: "Your accounts",
      text: "Each provider you are signed in to lists the accounts omp keeps for it, and which one this chat uses. <b>Sign out</b> removes one account; the others stay.",
      action: next,
    },
    {
      target: part("provider-sign-in"),
      title: "Another account",
      text: "Sign in here to any provider, also one you use already: that adds another account. <b>Add another account</b> beside a provider does the same.",
      action: next,
    },
    {
      target: SETTINGS_SHEET,
      title: "Close settings",
      text: "{stop} closes settings.",
      action: { kind: "disappears", selector: SETTINGS_SHEET },
    },
  ],
};

/** #2784: a sign-in shows its page to open or copy, takes its code or address in Settings or the chat, and can stop. */
const SIGN_IN_PAGE_TOUR: Tour = {
  id: "sign-in-page-2026-11-02",
  title: "Signing in from any device",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: part("settings"),
      title: "Settings",
      text: "{settings} or this gear opens settings. Open them.",
      action: { kind: "appears", selector: SETTINGS_SHEET },
    },
    {
      target: part("settings-tab-providers"),
      title: "Providers",
      text: "Sign-in is at the top of <b>Providers</b>. Open it.",
      action: { kind: "appears", selector: part("provider-sign-in") },
    },
    {
      target: part("provider-sign-in"),
      title: "Sign in",
      text: "Pick a provider and <b>Sign in</b>. Its page shows here with <b>Open</b> and <b>Copy link</b>, for any browser on any device. When the provider asks for a code, or for the address your browser ends on, paste it here, or in the chat, where the same question shows with the page. <b>Cancel sign-in</b> stops it.",
      action: next,
    },
    {
      target: SETTINGS_SHEET,
      title: "Close settings",
      text: "{stop} closes settings.",
      action: { kind: "disappears", selector: SETTINGS_SHEET },
    },
  ],
};

const DEVICES = part("devices");

const DEVICES_TOUR: Tour = {
  id: "devices-2026-10-31",
  title: "Paired devices",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: part("settings"),
      title: "Settings",
      text: "{settings} or this gear opens settings. Open them.",
      action: { kind: "appears", selector: SETTINGS_SHEET },
    },
    {
      target: part("settings-tab-app"),
      title: "App",
      text: "The devices are under <b>App</b>, this app's own settings. Click it.",
      action: { kind: "click" },
    },
    {
      target: DEVICES,
      title: "Devices",
      text: "Each phone, computer or browser that opens the app is paired once, and listed here with when it last connected. <b>Rename</b> it, or <b>Remove</b> one you lost: its windows close, and it pairs again to come back.",
      action: next,
    },
    {
      target: part("pair-new-device"),
      title: "A new device",
      text: "<b>Pair a new device</b> makes a one-time code and its QR code: scan it with the new device's camera, or enter the code there. A new device can also ask: every paired device then shows its request with 6 digits to compare, to allow or deny.",
      action: next,
    },
    {
      target: SETTINGS_SHEET,
      title: "Close settings",
      text: "{stop} closes settings.",
      action: { kind: "disappears", selector: SETTINGS_SHEET },
    },
  ],
};

const CONNECTION_TOUR: Tour = {
  id: "connection-2026-11-02",
  title: "The connection",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: part("connection"),
      title: "Connected or not",
      text: "This shows the link to the app's server: a green dot and <b>Connected</b>; amber and <b>Reconnecting…</b> while it comes back; red and <b>Disconnected</b> when the server turned this page away. Click it to reconnect at once.",
      action: next,
    },
    {
      target: part("connection"),
      title: "A link that went quiet",
      text: "A link can die without closing, after a phone sleeps for example. The app asks the server every 30 seconds, and at once when you come back to it; when no answer comes, it drops the link and opens a new one.",
      action: next,
    },
  ],
};

const PAIRED_ONLY_TOUR: Tour = {
  id: "paired-only-2026-11-02",
  title: "Only paired devices",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: part("settings"),
      title: "Settings",
      text: "{settings} or this gear opens settings. Open them.",
      action: { kind: "appears", selector: SETTINGS_SHEET },
    },
    {
      target: part("settings-tab-app"),
      title: "App",
      text: "The devices are under <b>App</b>. Click it.",
      action: { kind: "click" },
    },
    {
      target: DEVICES,
      title: "Only these get in",
      text: "Only the devices listed here reach the app. Its link with the key in it opens the app on the server's own computer only; any other phone, computer or browser opens the app's address and pairs once. <b>Remove</b> a device and it stays out until it pairs again.",
      action: next,
    },
    {
      target: part("pair-new-device"),
      title: "Pairing a device",
      text: "<b>Pair a new device</b> shows a one-time code and its QR code for the new device. Or the new device asks, and a paired device allows it after comparing 6 digits.",
      action: next,
    },
    {
      target: SETTINGS_SHEET,
      title: "Close settings",
      text: "{stop} closes settings.",
      action: { kind: "disappears", selector: SETTINGS_SHEET },
    },
  ],
};

const THEME_GALLERY = part("theme-gallery");

const THEMES_TOUR: Tour = {
  id: "themes-2026-10-31",
  title: "Themes",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: part("settings"),
      title: "Settings",
      text: "{settings} or this gear opens settings. Open them.",
      action: { kind: "appears", selector: SETTINGS_SHEET },
    },
    {
      target: part("settings-tab-app"),
      title: "App",
      text: "The themes are under <b>App</b>, this app's own settings. Click it.",
      action: { kind: "click" },
    },
    {
      target: THEME_GALLERY,
      title: "Every theme",
      text: "Each card is a small picture of the app in that theme. Point at one and the whole app shows in it; move away and yours comes back. A click keeps it: a dark theme as your dark theme, a light one as your light theme.",
      action: next,
    },
    {
      target: `${SETTINGS_SHEET} ${part("theme")}`,
      title: "Light, Dark or the system's",
      text: "The sun shows your light theme and the moon your dark one; the screen, <b>Match the system</b>, follows your computer's setting.",
      action: next,
    },
    {
      target: SETTINGS_SHEET,
      title: "Close settings",
      text: "{stop} closes settings. The palette ({palette}) lists every theme too: type <b>Theme</b>, and the one you highlight shows.",
      action: { kind: "disappears", selector: SETTINGS_SHEET },
    },
  ],
};

const ZOOM_TOUR: Tour = {
  id: "zoom-2026-10-31",
  title: "Zoom the window",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: null,
      title: "Larger or smaller",
      text: "{zoomIn} draws the whole window larger, as a browser's zoom does, and {zoomOut} smaller. Press {zoomIn}.",
      action: keys("zoomIn"),
      desktopOnly: true,
    },
    {
      target: null,
      title: "Back to 100%",
      text: "{zoomReset} brings it back to 100%. The window keeps the zoom you leave it at for the next start. Press {zoomReset}.",
      action: keys("zoomReset"),
      desktopOnly: true,
    },
  ],
};

const CHAT_DETAILS_TOUR: Tour = {
  id: "chat-details-2026-10-31",
  title: "A chat's details on the phone",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: part("chat-details-button"),
      title: "This chat's details",
      text: "On a phone, ⓘ opens this chat's usage, agents, progress, jobs and side questions as a screen of their own. Tap it.",
      action: { kind: "click" },
      phoneOnly: true,
    },
    {
      target: SIDE_PANEL,
      title: "One screen, named tabs",
      text: "The tabs at the top switch between them; ‹ Chat brings you back to the chat as you left it.",
      action: next,
      phoneOnly: true,
    },
  ],
};

const PHONE_SETTINGS_TOUR: Tour = {
  id: "phone-settings-2026-10-31",
  title: "Settings on the phone",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: part("settings"),
      title: "Settings",
      text: "On a phone, Settings fill the screen, as your phone's own do. Tap the gear.",
      action: { kind: "appears", selector: SETTINGS_SHEET },
      phoneOnly: true,
    },
    {
      target: part("settings-tab-app"),
      title: "One section at a time",
      text: "Each section opens a screen of its own; ‹ Settings goes back, Done closes them. The App section holds the theme and What's new. Tap App.",
      action: { kind: "click" },
      phoneOnly: true,
    },
  ],
};

const PANE_MODE_TOUR: Tour = {
  id: "pane-mode-2026-10-31",
  title: "Pane mode",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: WORKSPACE,
      centred: true,
      title: "A second pane",
      text: "Pane mode works on panes, so first press {splitRight} to open a new chat to the right.",
      action: keys("splitRight"),
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Pane mode",
      text: "Press {paneMode}. Until it ends, plain keys work on the panes, in any browser and on any keyboard: no Super key needed.",
      action: keys("paneMode"),
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Go, resize, share",
      text: "← → ↑ ↓ go to the pane in that direction, with Shift they make it larger or smaller, = shares the space and [ ] go to the previous or next pane. Esc ends it, as do 3 seconds without a key; {paneMode} starts it again.",
      action: next,
    },
  ],
};

/** #2790: dropping where you let go. A second pane first, so there is a pane to move and one to drop on. */
const DROP_TOUR: Tour = {
  id: "drop-2026-11-02",
  title: "Dropping chats and panes",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: WORKSPACE,
      centred: true,
      title: "A second pane",
      text: "Press {splitRight} to open a new chat to the right, so there is a pane to move.",
      action: keys("splitRight"),
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Drag a chat or a pane",
      text: "Drag a chat from the list, or a pane by the grip ⠿ at the start of its title, and let go anywhere on a pane. A label where it will land says what the drop does.",
      action: next,
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Where it lands",
      text: "Near a pane's edge it splits that pane on that side; in its middle, a chat from the list takes its place. Along the window's own edges it makes a column or row the whole length of that side.",
      action: next,
    },
  ],
};

/** #2781: the app continues a chat a usage limit stopped. Nothing to try on demand, so the steps tell it. */
const USAGE_CONTINUE_TOUR: Tour = {
  id: "usage-continue-2026-11-01",
  title: "Continuing after a usage limit",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: null,
      title: "When a usage limit stops a chat",
      text: "The app now continues the chat by itself a minute after the limit resets, even with every window closed. The failed request says when: <b>Continues by itself at</b> and the time.",
      action: next,
    },
    {
      target: null,
      title: "Continue now, or not",
      text: "<b>Continue now</b> tries again at once. <b>Don't continue</b> leaves the chat stopped, and so do Stop and a pause. In the chat list such a chat has a clock for its mark.",
      action: next,
    },
  ],
};

/** #2781 part 3: a marked chat pauses at its share of its provider's 5-hour window and goes on at the reset. */
const USAGE_PAUSE_TOUR: Tour = {
  id: "usage-pause-2026-11-02",
  title: "Pausing chats at a usage limit",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: SIDE_PANEL_RAIL,
      title: "Usage",
      text: "Click <b>Usage</b>, the first button on this rail.",
      action: { kind: "appears", selector: SIDE_PANEL },
    },
    {
      target: part("usage-pause"),
      title: "Pause at the limit",
      text: "Mark a chat here, and it pauses as <b>/pause</b> does once its provider's 5-hour window reaches this percent: 95 unless you type another. When the window resets, it goes on by itself. Only the chats you mark pause, each at its own percent, and a paused chat says why and when it goes on.",
      action: next,
    },
    {
      target: SIDE_PANEL_RAIL,
      title: "Hide it",
      text: "Click <b>Usage</b> again to hide the side panel.",
      action: { kind: "disappears", selector: SIDE_PANEL },
    },
  ],
};

/** #2779 D6.2: signing in to an MCP server again from the device in use, in Settings → Tools. */
const MCP_SIGN_IN_TOUR: Tour = {
  id: "mcp-sign-in-2026-11-01",
  title: "Signing in to an MCP server",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: part("settings"),
      title: "Settings",
      text: "{settings} or this gear opens settings. Try it.",
      action: { kind: "appears", selector: SETTINGS_SHEET },
    },
    {
      target: SETTINGS_SHEET,
      title: "MCP servers",
      text: "Under <b>Tools</b>, <b>MCP servers</b> lists omp's servers. <b>Sign in again</b>, beside a server reached over the network, opens its sign-in page on this device, wherever the server runs.",
      action: next,
    },
    {
      target: SETTINGS_SHEET,
      title: "Finish here",
      text: "After you sign in, your browser shows a page that cannot load. Paste its address into the box that appears under the list, then <b>Finish sign-in</b>.",
      action: next,
    },
    {
      target: SETTINGS_SHEET,
      title: "Close settings",
      text: "{stop} closes settings.",
      action: { kind: "disappears", selector: SETTINGS_SHEET },
    },
  ],
};

/** #2770 D1 part 3: on the phone, menus come up from the foot of the screen, and a held message offers Copy and Edit. */
const PHONE_TOUCH_TOUR: Tour = {
  id: "phone-touch-2026-11-01",
  title: "Menus and messages on the phone",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: null,
      title: "Menus from the foot of the screen",
      text: "On a phone every menu comes up from the foot of the screen, its rows a thumb's size: the model menu, a chat's menu, a setting's choices. A tap above one closes it.",
      action: next,
      phoneOnly: true,
    },
    {
      target: null,
      title: "Hold a message",
      text: "Touch and hold one of your messages for <b>Copy</b> and <b>Edit</b>. A reply's thinking and its tools open with a tap.",
      action: next,
      phoneOnly: true,
    },
  ],
};

/** #2779 D1 part 4: on a tablet, the controls a finger takes are full-size and a pane's divider is easy to take. */
const TABLET_TOUCH_TOUR: Tour = {
  id: "tablet-touch-2026-11-01",
  title: "On a tablet",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: null,
      title: "Full-size controls",
      text: "On a tablet the chat list's rows, the message box's buttons, the panes' title bars and Settings are a finger's size, and the buttons that show on pointing are always shown.",
      action: next,
      tabletOnly: true,
    },
    {
      target: null,
      title: "Resize the panes",
      text: "Drag the line between two panes to resize them: a touch anywhere close to it takes it.",
      action: next,
      tabletOnly: true,
    },
  ],
};

/** #2775: on an Apple device's keyboard ⌘ does what Ctrl does, and the keys read ⌘. */
const COMMAND_KEYS_TOUR: Tour = {
  id: "command-keys-2026-11-02",
  title: "⌘ on an iPad or a Mac",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: WORKSPACE,
      centred: true,
      title: "⌘ does what Ctrl does",
      text: "With an iPad's keyboard or on a Mac, every Ctrl key works with ⌘ too: ⌘⇧T opens a tab, ⌘P switches the model's role. {shortcuts} lists every key, shown with ⌘ there. Try it.",
      action: { kind: "appears", selector: KEY_LIST },
    },
    {
      target: KEY_LIST,
      title: "Close the list",
      text: "{stop} closes it.",
      action: { kind: "disappears", selector: KEY_LIST },
    },
  ],
};

const ATTACH_IMAGES = part("attach-images");

/** #2783: a picture from the device's picker, on a phone or a tablet. */
const ATTACH_IMAGES_TOUR: Tour = {
  id: "attach-images-2026-11-01",
  title: "Photos in a message",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: ATTACH_IMAGES,
      title: "Attach a photo",
      text: "Tap here to add photos or pictures to your message, from your library, the camera or your files. They go with the next message you send.",
      action: next,
    },
  ],
};

/** An update of the app: when it came, what it added in one line, and the tours that show it. */
export interface Update {
  readonly id: string;
  /** When it came out: an ISO time with its offset, shown in the reader's own time. */
  readonly when: string;
  readonly summary: string;
  readonly tours: readonly Tour[];
}

/**
 * Every update that brought tours, newest first: the What's new list, and the card offers what came since the reader
 * last looked. Each update that changes the app adds itself at the top, with its tour.
 */
export const UPDATES: readonly Update[] = [
  {
    id: "2026-11-02-drop",
    when: "2026-11-02T15:25:00-06:00",
    summary:
      "Dragging lands where you let go again, without the arrows: near a pane's edge it splits there, in its middle a chat takes its place, along the window's edges it runs the whole side, and a label says which.",
    tours: [DROP_TOUR],
  },
  {
    id: "2026-11-02-connection",
    when: "2026-11-02T15:10:00-06:00",
    summary:
      "The foot of the chat list shows whether the app is connected, reconnecting or disconnected, and a click reconnects at once. A link that stops answering is noticed and opened again.",
    tours: [CONNECTION_TOUR],
  },
  {
    id: "2026-11-02-paired-only",
    when: "2026-11-02T11:38:00-06:00",
    summary:
      "Only paired devices reach the app: its link opens it on the server's own computer only, and every other device pairs once with a code.",
    tours: [PAIRED_ONLY_TOUR],
  },
  {
    id: "2026-11-02-usage-pause",
    when: "2026-11-02T11:14:00-06:00",
    summary:
      "Mark a chat in Usage to pause it when its provider's 5-hour window reaches its own percent (95 unless you change it); it goes on when the window resets.",
    tours: [USAGE_PAUSE_TOUR],
  },
  {
    id: "2026-11-02-command-keys",
    when: "2026-11-02T10:12:00-06:00",
    summary:
      "With an iPad's keyboard or on a Mac, every Ctrl key works with ⌘ too, and the app lists its keys with ⌘.",
    tours: [COMMAND_KEYS_TOUR],
  },
  {
    id: "2026-11-02-sign-in-page",
    when: "2026-11-02T03:03:00-06:00",
    summary:
      "A sign-in shows its page with Open and Copy link, takes the code or address it asks for in Settings or in the chat, and Cancel sign-in stops it.",
    tours: [SIGN_IN_PAGE_TOUR],
  },
  {
    id: "2026-11-02-attach-images",
    when: "2026-11-02T02:45:00-06:00",
    summary:
      "On a phone or a tablet, the message box has a button that adds photos or pictures to your message from the device's own picker.",
    tours: [ATTACH_IMAGES_TOUR],
  },
  {
    id: "2026-11-02-files",
    when: "2026-11-02T02:40:00-06:00",
    summary:
      "A Files panel in the side panel: the chat folder's files from any device, with previews, an editor whose saves stop and ask when the file changed on disk, uploads, downloads, and deletes you can undo.",
    tours: [FILES_TOUR],
  },
  {
    id: "2026-11-01-tablet-touch",
    when: "2026-11-01T22:32:00-06:00",
    summary:
      "On a tablet the chat list, the message box, the panes' title bars, the side panels and Settings have controls a finger's size, and a pane's divider can be dragged from close to its line.",
    tours: [TABLET_TOUCH_TOUR],
  },
  {
    id: "2026-11-01-phone-touch",
    when: "2026-11-01T18:30:00-06:00",
    summary:
      "On a phone, menus come up from the foot of the screen with rows a thumb's size, and a tap above one closes it; hold one of your messages for Copy and Edit; a reply's thinking and tool rows and the tours card are full-size too.",
    tours: [PHONE_TOUCH_TOUR],
  },
  {
    id: "2026-11-01-mcp-sign-in",
    when: "2026-11-01T15:14:00-06:00",
    summary:
      "Settings → Tools → MCP servers: Sign in again signs in to an MCP server from the device you use, its page opening there and the address your browser ends on pasted in place; a provider's sign-in page now opens on another device too.",
    tours: [MCP_SIGN_IN_TOUR],
  },
  {
    id: "2026-11-01-usage-continue",
    when: "2026-11-01T10:42:00-06:00",
    summary:
      "A chat a usage limit stopped now continues by itself a minute after the limit resets, even with every window closed: the failed request says when, with Continue now and Don't continue, and the chat list marks it with a clock.",
    tours: [USAGE_CONTINUE_TOUR],
  },
  {
    id: "2026-10-31-phone-settings",
    when: "2026-10-31T22:50:00-05:00",
    summary:
      "On a phone, Settings fill the screen: the sections as rows with ›, each a screen with ‹ Settings and Done; the theme and What's new moved there from the list's ⋯ menu, which is gone.",
    tours: [PHONE_SETTINGS_TOUR],
  },
  {
    id: "2026-10-31-chat-details",
    when: "2026-10-31T22:40:00-05:00",
    summary:
      "On a phone, a chat's details (usage, agents, progress, jobs, side questions) open from ⓘ in its top bar as a screen of their own, with named tabs; the list's ⋯ menu no longer holds them.",
    tours: [CHAT_DETAILS_TOUR],
  },
  {
    id: "2026-10-31-pane-mode",
    when: "2026-10-31T22:25:00-05:00",
    summary:
      "Pane mode, without Super: Ctrl+Shift+Space, then the arrows go between panes, Shift+arrows resize, = shares the space and [ ] cycle.",
    tours: [PANE_MODE_TOUR],
  },
  {
    id: "2026-10-31-zoom",
    when: "2026-10-31T21:50:00-05:00",
    summary:
      "In the desktop window, Ctrl + and Ctrl − zoom the whole window and Ctrl 0 brings it back to 100%; the window keeps its zoom for the next start.",
    tours: [ZOOM_TOUR],
  },
  {
    id: "2026-10-31-pause-list",
    when: "2026-10-31T21:40:00-05:00",
    summary: "The chat list marks a paused chat, in every window, wherever the chat is open.",
    tours: [PAUSE_LIST_TOUR],
  },
  {
    id: "2026-10-31-themes",
    when: "2026-10-31T21:10:00-05:00",
    summary:
      "33 themes, each readable throughout: Catppuccin, Tokyo Night, Rosé Pine, Nord, Gruvbox, Dracula, Solarized, Everforest, Kanagawa, One, Ayu and GitHub. Settings → App shows them as cards; point at one to see the app in it.",
    tours: [THEMES_TOUR],
  },
  {
    id: "2026-10-31-pause",
    when: "2026-10-31T17:10:00-05:00",
    summary:
      "Pause a chat with /pause or the Pause button: every agent holds at its next step until you resume. Pause all chats in the Jobs tab and the palette.",
    tours: [PAUSE_TOUR],
  },
  {
    id: "2026-10-31-phone",
    when: "2026-10-31T12:45:00-05:00",
    summary:
      "On a phone: the app opens on a new chat, a key row and quick prompts above the keyboard, and a tidier chat list.",
    tours: [PHONE_TOUR],
  },
  {
    id: "2026-10-31-devices",
    when: "2026-10-31T05:58:00-05:00",
    summary:
      "Pair a phone or another computer with a code or a QR code; Settings → App → Devices lists them and removes one.",
    tours: [DEVICES_TOUR],
  },
  {
    id: "2026-10-31-jobs",
    when: "2026-10-31T05:20:00-05:00",
    summary:
      "A Jobs panel: the commands and subagents omp runs in the background, their output, and Cancel job.",
    tours: [JOBS_TOUR],
  },
  {
    id: "2026-10-31-provider-accounts",
    when: "2026-10-31T01:52:00-05:00",
    summary:
      "Several accounts for one provider in Settings → Providers: add another, sign one out.",
    tours: [PROVIDER_ACCOUNTS_TOUR],
  },
  {
    id: "2026-10-30-iphone",
    when: "2026-10-30T23:30:00-05:00",
    summary:
      "omp on an iPhone: add it to the Home Screen, clear of the notch and the home bar, the message box above the keyboard.",
    tours: [IPHONE_TOUR],
  },
  {
    id: "2026-10-30-whats-new",
    when: "2026-10-30T22:40:00-05:00",
    summary:
      "This list of updates and their tours; after an update, its card names the new tours and shows them one after another.",
    tours: [WHATS_NEW_TOUR],
  },
  {
    id: "2026-10-30-arrange",
    when: "2026-10-30T21:47:00-05:00",
    summary:
      "Drag a chat from the list into a split; the side panel is a pane you size like a chat.",
    tours: [ARRANGE_TOUR],
  },
  {
    id: "2026-10-30-model-menu",
    when: "2026-10-30T18:44:00-05:00",
    summary:
      "A model menu with Favorites, Recent and each provider's newest models; hide the ones you never use.",
    tours: [MODEL_MENU_TOUR],
  },
  {
    id: "2026-10-30-side-rail",
    when: "2026-10-30T14:12:00-05:00",
    summary: "Side questions stay beside the chat, and a rail at the right edge opens each panel.",
    tours: [SIDE_RAIL_TOUR],
  },
  {
    id: "2026-10-30-inbox",
    when: "2026-10-30T10:06:00-05:00",
    summary: "An inbox: a bell for the chats that need you.",
    tours: [INBOX_TOUR],
  },
  {
    id: "2026-10-30-notes",
    when: "2026-10-30T09:30:00-05:00",
    summary:
      "omp's short notes show above the message box, and windows open with Tern's short pop.",
    tours: [NOTES_TOUR],
  },
  {
    id: "2026-10-30-agents-progress",
    when: "2026-10-30T09:19:00-05:00",
    summary:
      "The side panel gains Agents and Progress: the subagents, the goal, the todo list and plan mode.",
    tours: [AGENTS_PROGRESS_TOUR],
  },
  {
    id: "2026-10-30-model-hub",
    when: "2026-10-30T09:18:00-05:00",
    summary: "A model and a thinking level for each of omp's roles.",
    tours: [MODEL_HUB_TOUR],
  },
  {
    id: "2026-10-30-side-panel",
    when: "2026-10-30T08:41:00-05:00",
    summary: "A side panel beside your chats, with Usage first.",
    tours: [SIDE_PANEL_TOUR],
  },
  {
    id: "2026-10-30-side-questions",
    when: "2026-10-30T08:37:00-05:00",
    summary: "Ask omp a side question with /btw, also while it works.",
    tours: [SIDE_QUESTIONS],
  },
  {
    id: "2026-10-30-roles",
    when: "2026-10-30T05:02:00-05:00",
    summary: "Switch the chat to another role's model, as in omp.",
    tours: [MODELS_AND_ROLES],
  },
  {
    id: "2026-10-30-folders",
    when: "2026-10-30T03:36:00-05:00",
    summary: "Switch folders from the top of the chat list.",
    tours: [FOLDERS],
  },
  {
    id: "2026-10-30-tours",
    when: "2026-10-30T03:26:00-05:00",
    summary: "Click-through tours of the basics.",
    tours: [PANES, MESSAGE_BOX_TOUR, INSIDE_A_CHAT, PALETTE_AND_SETTINGS],
  },
];

/** Every tour, oldest first: the palette's order. */
export const TOURS: readonly Tour[] = [...UPDATES].reverse().flatMap((update) => update.tours);
