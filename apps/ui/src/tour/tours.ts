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
      text: "Drag a chat from this list onto the chat on the right and let go: on an edge it splits there, in the middle it goes beside it. Where it will land lights up while you drag.",
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
      text: "On an iPhone, open the app's link in Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>. omp then opens from its icon, full screen and already connected, and keeps clear of the notch and the home bar.",
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
    id: "2026-10-31-themes",
    when: "2026-10-31T21:20:00-05:00",
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
