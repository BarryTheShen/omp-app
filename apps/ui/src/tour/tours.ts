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
  /** Not on a phone's layout: a step that points at a part a phone does not have (the side panel's rail). */
  readonly notOnPhone?: true;
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
const TRANSCRIPT = part("transcript");
const MENU = part("composer-menu");
const AGENT_HUB = '[aria-label="Agent Hub"]';
const PALETTE = part("palette");
const KEY_LIST = part("keys");
const SETTINGS_SHEET = part("settings-sheet");
const DASHBOARD = part("dashboard");

const PANES: Tour = {
  id: "workspace-2026-10-30",
  title: "Your chats, workspaces and windows",
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
      title: "A workspace to try things in",
      text: "This tour opened a new workspace with a new chat, so nothing you try touches your chats. {nextTab} and {previousTab} move between workspaces; {renameTab} names one.",
      action: next,
    },
    {
      target: TABS,
      title: "More windows",
      text: "In the desktop window, {newWindow} opens another app window on the same server, with a workspace of its own. Closing one leaves the others open.",
      action: next,
      desktopOnly: true,
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Split the screen",
      text: "Press {splitRight} to split: a blank window opens to the right.",
      action: keys("splitRight"),
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Move between windows",
      text: "{focusPane} goes to the window in that direction; {cyclePane} to the next one. Try one.",
      action: keys("focusPane"),
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Zoom",
      text: "Press {zoom} to let this window fill the workspace.",
      action: keys("zoom"),
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Zoom back",
      text: "Press {zoom} again to bring the other window back.",
      action: keys("zoom"),
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Close a window",
      text: "Press {closePane} to close this one.",
      action: keys("closePane"),
    },
    {
      target: CHAT_LIST,
      title: "Several chats at once",
      text: "Click a chat to open it in a workspace of its own, or in the blank window you're in; Alt+click opens it beside the window you're in. Drag one onto a blank window to fill it, or near a window's edge to split it. {equalize} shares the space equally; {resizePane} makes a window bigger or smaller.",
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
      text: "Close the tour's workspace with {closeTab}.",
      action: keys("closeTab"),
    },
  ],
};

/**
 * On a phone the box's settings, photos and files are behind ＋ (#2837): a tour that points at one taps ＋ first. The
 * sheet stays open while the tour goes on inside it.
 */
const PLUS_SHEET = part("plus-sheet");
const PLUS_STEP: TourStep = {
  target: part("plus"),
  title: "＋",
  text: "On a phone the box's settings, photos and files are behind <b>＋</b>. Tap it.",
  action: { kind: "appears", selector: PLUS_SHEET },
  phoneOnly: true,
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
    PLUS_STEP,
    {
      target: part("model"),
      title: "The model",
      text: "{model} opens omp's models (or click here). Try it, then {stop} to close the list.",
      action: keys("model"),
    },
    {
      target: part("thinking"),
      title: "Thinking",
      text: "{thinkingLevel} steps to the next thinking level; a click on the level lists them all to pick one. Try the key.",
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
      text: "Close the tour's workspace with {closeTab}.",
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
    PLUS_STEP,
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
    PLUS_STEP,
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
      text: "Type <b>/btw</b>, take it from the menu with Enter, and press Enter again: the side panel opens on <b>Questions</b>, on its <b>Side questions</b> tab, where omp keeps this chat's side questions.",
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

/** Questions omp asks without waiting, answered in the Questions panel. */
const ASYNC_QUESTIONS_TOUR: Tour = {
  id: "async-questions-2026-11-07",
  title: "Questions omp asks without waiting",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: SIDE_PANEL_RAIL,
      title: "Questions for you",
      text: "omp can ask you something it does not need at once, and keep working. The question waits in the <b>Questions</b> panel, under <b>Questions for you</b>, with what omp wants you to know; its button on this rail counts the questions waiting in the chat you are in. Pick a choice or write your own, add a note if you like, and <b>Send answer</b>: it goes into the chat as your message, between omp's steps. <b>Skip</b> leaves it unanswered: nothing goes to omp for it.",
      action: next,
    },
  ],
};

/** The side panel's BTW history became Questions. */
const QUESTIONS_PANEL_TOUR: Tour = {
  id: "questions-panel-2026-11-07",
  title: "The Questions panel",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: SIDE_PANEL_RAIL,
      title: "Questions",
      text: "The side panel's <b>BTW history</b> is now <b>Questions</b>: the questions omp asks you, under <b>Questions for you</b>, and your <b>/btw</b> side questions, under <b>Side questions</b>. Its button on this rail counts the questions waiting for you, and <b>/btw</b> opens it on your side questions, also while questions wait.",
      action: next,
    },
  ],
};

/** The answers to omp's questions go to omp together. */
const ANSWERS_TOGETHER_TOUR: Tour = {
  id: "answers-together-2026-11-07",
  title: "Answers go together",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: SIDE_PANEL_RAIL,
      title: "Answers go together",
      text: "Your answers to omp's questions wait in <b>Questions</b> under <b>Ready to send</b>, where <b>Change</b> still changes them. They go to omp together, as one message, once every open question has an answer or a skip; <b>Send answers</b> sends the ready ones sooner.",
      action: next,
    },
  ],
};

/** Enter in a question's written answer moves on; only the button or Ctrl+Enter sends (2026-11-11). */
const ENTER_MOVES_ON_TOUR: Tour = {
  id: "questions-enter-2026-11-11",
  title: "Enter moves to the next question",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: SIDE_PANEL_RAIL,
      title: "Enter moves on",
      text: "In the <b>Questions</b> panel, Enter in an answer you write (your own answer, or a box to write in) finishes it and moves to the next question, then to the button that sends: it never sends the card by itself, so the questions after it are still yours to answer. The button sends, and so does Ctrl+Enter (⌘+Enter on a Mac) from anywhere in the card. Shift+Enter starts a new line.",
      action: next,
    },
  ],
};

/** Answers to separate asks wait for each other too (2026-11-07). */
const ANSWERS_ACROSS_ASKS_TOUR: Tour = {
  id: "answers-across-asks-2026-11-07",
  title: "Answers to separate asks",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: SIDE_PANEL_RAIL,
      title: "Answers to separate asks",
      text: "When omp asks you questions at different times, your answers now wait for each other in <b>Questions</b>, under <b>Ready to send</b>. <b>Send answers</b> sends the ones you have answered, as one message; the questions you have not answered stay open. Once every open question has an answer or a skip, they go by themselves.",
      action: next,
    },
  ],
};

/** Settings search on a phone (2026-11-09): the field stays, the results show under it. */
const SETTINGS_SEARCH_TOUR: Tour = {
  id: "settings-search-2026-11-09",
  title: "Search the settings",
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
      target: `${SETTINGS_SHEET} [aria-label="Search settings"]`,
      title: "Search",
      text: "Type what you look for: each letter narrows the settings. On a phone the results show under the field as you type, with where a change is saved above them; empty the field to see the sections again.",
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

/** The dashboard as a page of the workspace (2026-11-09, D7). */
const DASHBOARD_PAGE_TOUR: Tour = {
  id: "dashboard-page-2026-11-09",
  title: "The dashboard is a page",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: part("dashboard-button"),
      title: "The dashboard",
      text: "The dashboard is a page of its own now: {dashboard} or this button opens it as a workspace in front, as a new chat opens, and brings it back where it is open. Open it.",
      action: { kind: "appears", selector: DASHBOARD },
    },
    {
      target: `${DASHBOARD} [aria-label="Dashboard parts"]`,
      title: "Its parts",
      text: "This bar goes to each part. Being a pane, the dashboard can sit beside a chat too: drag its tab to a window's edge. It stays where you leave it across reloads.",
      action: next,
    },
  ],
};

/** The dashboard's questions, to-do list, statistics and SiYuan copy (2026-11-09, D7). */
const DASHBOARD_PARTS_TOUR: Tour = {
  id: "dashboard-parts-2026-11-09",
  title: "Questions and the to-do list",
  minutes: 2,
  sandbox: false,
  steps: [
    {
      target: part("dashboard-button"),
      title: "The dashboard",
      text: "{dashboard} opens the dashboard. Open it.",
      action: { kind: "appears", selector: DASHBOARD },
    },
    {
      target: `${DASHBOARD} [aria-label="Questions"]`,
      title: "Every chat's questions",
      text: "What any chat's agent asked without waiting shows here, under the chat's name. Answer as in the chat: an answer waits for its chat's other questions, then they all go to the chat as your message, and the question leaves the list.",
      action: next,
    },
    {
      target: `${DASHBOARD} [aria-label="To-do list"]`,
      title: "One to-do list",
      text: "One list for you and your chats' agents, kept across chats. Add, tick, start, edit and order items; each change says who made it, and <b>Undo</b> takes it back. Agents have it as their tool <b>shared_todos</b>: they read and add, start and finish items, and drop rather than delete.",
      action: next,
    },
    {
      target: `${DASHBOARD} [aria-label="Copy in SiYuan"]`,
      title: "A copy in SiYuan",
      text: "Keep a copy at the end of a SiYuan page: it is rewritten after each change, and an item ticked there is done here too.",
      action: next,
    },
    {
      target: `${DASHBOARD} [aria-label="Statistics"]`,
      title: "Statistics in brief",
      text: "omp's own statistics for 24 hours, 7 days or 30 days: requests, cost, tokens, the cache, failures, the cost of each hour or day, and the models that cost the most. The full page is one click away.",
      action: next,
    },
  ],
};

/** What waits on the dashboard's button, and the new ways to add to the to-do list (2026-11-09, D7h). */
const DASHBOARD_EXTRAS_TOUR: Tour = {
  id: "dashboard-extras-2026-11-09",
  title: "What waits for you",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: part("dashboard-button"),
      title: "What waits",
      text: "This button counts what waits for you: every chat's questions with no answer yet, and the to-dos due today or before. A chat's menu has <b>Add to the to-do list</b>, the palette has <b>Add a to-do</b>, and the list copies as Markdown.",
      action: next,
    },
  ],
};

/** Skip means no answer (2026-11-09). */
const SKIP_TOUR: Tour = {
  id: "skip-2026-11-09",
  title: "Skip means no answer",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: SIDE_PANEL_RAIL,
      title: "Skip",
      text: "In <b>Questions</b>, <b>Skip</b> now means no answer: nothing goes to omp for a question you skip. Your answers to the other questions still go to omp together, as one message; when every question that goes is a skip, no message goes at all.",
      action: next,
    },
  ],
};

/** The lite view finds a chat and opens it in the desktop app (2026-11-09). */
const LITE_FIND_TOUR: Tour = {
  id: "lite-find-2026-11-09",
  title: "The panel: find a chat, open it in the desktop app",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: TRANSCRIPT,
      title: "In a panel",
      text: "In another app's panel, a click on the chat's name lists the folder's recent chats, and <b>Find a chat</b> there finds any of its chats by its title. The arrow beside it opens the chat in the full app: <b>Open in the desktop app</b>, in the menu beside the arrow, opens it in the desktop app's window instead, and the panel keeps that choice. The desktop app takes such links from this update's package on.",
      action: next,
    },
  ],
};

/** omp app in VS Code: its extension, for the folder open there (2026-11-09). */
const VSCODE_TOUR: Tour = {
  id: "vscode-2026-11-09",
  title: "omp app in VS Code",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: TRANSCRIPT,
      title: "VS Code",
      text: "In VS Code, install <b>omp-app-vscode</b> from this release's files (Extensions → ⋯ → Install from VSIX) and give it this app's address. Its chat sits in VS Code's right-hand side bar, beside the other chat panels (Ctrl+Alt+B shows it), and works on the folder open there, on that computer: each change shows as a diff to accept or reject, and each command asks first.",
      action: next,
    },
  ],
};

/** VS Code's panel on the right, and what it says when it cannot show the app (2026-11-09). */
const VSCODE_RIGHT_TOUR: Tour = {
  id: "vscode-right-2026-11-09",
  title: "VS Code's panel on the right",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: TRANSCRIPT,
      title: "VS Code's panel",
      text: "With this release's <b>omp-app-vscode</b>, VS Code shows omp app in its right-hand side bar, beside its other chat panels (Ctrl+Alt+B shows it). When the panel cannot show the app, it says why instead of staying blank: the address cannot be reached, or the app is older than the extension. Click <b>Try again</b> in the panel once that is fixed.",
      action: next,
    },
  ],
};

/** Panels need no switch: pairing is the lock (2026-11-12). */
const INTEGRATIONS_GONE_TOUR: Tour = {
  id: "integrations-gone-2026-11-12",
  title: "Panels need no switch",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: TRANSCRIPT,
      title: "Panels need no switch",
      text: "Settings → App → Integrations is gone. Browser extensions (Firefox, Zen, Chrome) and VS Code may always show omp app in a panel, and each panel still pairs once before it is signed in, so pairing is the lock.",
      action: next,
    },
  ],
};

/** A setting's switch or choice moves when it is clicked (2026-11-12). */
const SETTINGS_AT_ONCE_TOUR: Tour = {
  id: "settings-at-once-2026-11-12",
  title: "Settings move when clicked",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: TRANSCRIPT,
      title: "Settings move when clicked",
      text: "In Settings, a switch, a choice or a menu shows its new value as soon as you click it, instead of after the server has written it to omp's settings file. If the server cannot save it, the setting goes back and its row says why. Scrolling up a long chat after omp renamed it no longer waits while the server reads the whole chat again.",
      action: next,
    },
  ],
};

/** A pairing request from a panel inside another app says so, and which app (2026-11-12). */
const PAIRING_ORIGIN_TOUR: Tour = {
  id: "pairing-origin-2026-11-12",
  title: "Panels say which app they are inside",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: TRANSCRIPT,
      title: "Panels say which app they are inside",
      text: "When a panel inside another app (a browser extension, VS Code) asks to pair, the prompt now says <b>In a panel inside</b> that app and that the panel will hold the device's key, and whether that app paired before and as which device. Settings → App → Devices shows the same under a request and under a device that paired from a panel. A one-time code in an address (<b>#pair=</b>, what a QR code opens) is used only by a page of its own, never inside another app's frame.",
      action: next,
    },
  ],
};

/** omp's statistics answer at once (2026-11-12). */
const STATS_AT_ONCE_TOUR: Tour = {
  id: "stats-at-once-2026-11-12",
  title: "Statistics answer at once",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: TRANSCRIPT,
      title: "Statistics answer at once",
      text: "The dashboard's overview and Statistics, and Usage → This chat, no longer wait while omp's statistics page reads the chats: the page now keeps reading them as they change, so the numbers are current when they are asked for. When a long reading still runs after ten seconds, they show the numbers of the reading before it instead of waiting on, and after the app restarts its statistics page starts by itself a little later, before the dashboard opens.",
      action: next,
    },
  ],
};

/** A device that pairs is named for what it is and the computer it is on (2026-11-12). */
const DEVICE_NAMES_TOUR: Tour = {
  id: "device-names-2026-11-12",
  title: "Devices named for where they are",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: TRANSCRIPT,
      title: "Devices named for where they are",
      text: 'A device you pair is now named for what it is and the computer it is on, as "Zen sidebar on my-laptop", "VS Code on my-laptop", "Firefox on my-laptop" or "Home Screen app on my-phone", instead of "Linux · Firefox". The computer\'s name is the one Tailscale knows it by, or the system\'s (Linux, iPhone) when the app cannot tell. You can still change the name while pairing and in Settings → App → Devices.',
      action: next,
    },
  ],
};

/** Lists answer at once after a long chat changes (2026-11-12). */
const LONG_CHATS_TOUR: Tour = {
  id: "long-chats-2026-11-12",
  title: "Lists answer at once",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: TRANSCRIPT,
      title: "Lists answer at once",
      text: "The running chats, the chat list and a chat's name no longer wait while the server reads a long chat again after omp renamed it: the list shows it as it was, the server reads it once in the background, and the list updates when that is done.",
      action: next,
    },
  ],
};

/** A panel's key goes in its connection's handshake, and the sidebar's tools know the app by each of its names (2026-11-12). */
const PANEL_KEY_TOUR: Tour = {
  id: "panel-key-2026-11-12",
  title: "Panel keys stay out of addresses",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: TRANSCRIPT,
      title: "Panel keys stay out of addresses",
      text: "The Firefox and Zen sidebar and VS Code's panel now sign in with their key in the connection's handshake, not in its address, which a proxy in between may write to its log. Nothing changes for you: a panel open during the update keeps working, and signs in the new way the next time it loads. The sidebar's tools also stay off omp app's pages under any of its names on the same computer (localhost or 127.0.0.1).",
      action: next,
    },
  ],
};

/** The Firefox and Zen sidebar's safety fixes, after a security review (2026-11-11). */
const ZEN_SAFETY_TOUR: Tour = {
  id: "zen-safety-2026-11-11",
  title: "A safer browser panel",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: TRANSCRIPT,
      title: "The browser panel is safer",
      text: "In the Firefox and Zen sidebar, the chat's tools never act on omp app's own pages, so a chat cannot answer its own approval; clicking a field no longer says what it holds; the tab's address goes with your messages without its query and fragment; and the browser's key goes only to the address it paired with. It needs this release's <b>omp-app-zen</b>.",
      action: next,
    },
  ],
};

/** Copying in VS Code's panel, through VS Code (2026-11-11). */
const VSCODE_COPY_TOUR: Tour = {
  id: "vscode-copy-2026-11-11",
  title: "Copy in VS Code's panel",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: TRANSCRIPT,
      title: "Copy works in VS Code",
      text: "In VS Code's panel, a code block's <b>Copy</b>, a message's and the other Copy buttons now put the text in your clipboard: VS Code lets only its own pages write the clipboard, so the panel hands the text to VS Code. It needs this release's <b>omp-app-vscode</b>.",
      action: next,
    },
  ],
};

/** Another server, in Settings → App → Server; the banner's Change server and the desktop's page lead there (2026-11-09). */
const CHANGE_SERVER_TOUR: Tour = {
  id: "change-server-2026-11-09",
  title: "Change the server",
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
      text: "Click <b>App</b>.",
      action: { kind: "click" },
    },
    {
      target: part("server"),
      title: "The server",
      text: "The server this app is connected to, and another one by its address; in the desktop app, the servers it opened before are a click away too. While the connection is lost, the banner's <b>Change server</b> opens this. In the desktop app, the page for a server that does not answer has <b>Try again</b>, those servers and a field for another address.",
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

/** The message box's row in a narrow window (2026-11-09). */
const ONE_ROW_TOUR: Tour = {
  id: "one-row-2026-11-09",
  title: "The message box in a narrow window",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: MESSAGE_BOX,
      title: "One row, whatever the width",
      text: "On a computer, the model, the thinking level, Plan and Send stay on one row under the message box. In a narrow window, such as another app's side panel, the model's name shortens and the thinking level and Plan show only their icons; Send stays at the end of the row.",
      action: next,
    },
  ],
};

/** omp's questions as one card, on omp 18.18.5 (2026-11-10). */
const OMP_FORM_TOUR: Tour = {
  id: "omp-form-2026-11-10",
  title: "omp's questions in one card",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: MESSAGE_BOX,
      title: "Every question in one card",
      text: "When omp asks, its questions come above the message box as one card, in the order asked, each under its heading: round marks, tick boxes, lists, boxes to write in and pictures. What omp ticked for you is already ticked, <b>Other…</b> takes your own answer, and omp's checks show under a question. <b>Submit</b> or Enter sends them all; <b>Skip</b> or Esc leaves them unanswered; <b>Hide</b> folds the card to one line.",
      action: next,
    },
  ],
};

/** The Questions panel holds all a chat waits on you for: cards per ask, Read all, plans, omp's questions (2026-11-10). */
const EVERYTHING_THAT_WAITS_TOUR: Tour = {
  id: "everything-that-waits-2026-11-10",
  title: "Everything that waits for you",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: part("chat-details-button"),
      title: "Questions: everything that waits",
      text: "On a phone, a chat's <b>Questions</b> are in its details: tap ⓘ in the top bar (or the counts in its place).",
      action: { kind: "click" },
      phoneOnly: true,
    },
    {
      target: SIDE_PANEL,
      title: "All a chat waits on you for",
      text: "The <b>Questions</b> tab holds all the chat waits on you for, and its count shows on the tab: a plan omp proposes in plan mode, with <b>Approve</b> and <b>Keep planning</b>; omp's questions that stop the chat; and the questions it asks without waiting, one card per ask, with the recommended answers already picked, <b>Skip</b> on each and one button at the foot. A long question or plan shows its start and <b>Read all</b>, which opens it on the whole screen. Answer here or in the chat: the chat's own card closes with it.",
      action: next,
      phoneOnly: true,
    },
    {
      target: SIDE_PANEL_RAIL,
      title: "Questions: everything that waits",
      text: "<b>Questions</b> now holds all a chat waits on you for, and its button counts it: a plan omp proposes in plan mode, with <b>Approve</b> and <b>Keep planning</b>; omp's questions that stop the chat; and the questions it asks without waiting, one card per ask, with the recommended answers already picked, <b>Skip</b> on each and one button at the foot. A long question or plan shows its start and <b>Read all</b>, which opens it wide over the app. Answer in either place: the chat's own card closes with it. The dashboard lists omp's questions too.",
      action: next,
      notOnPhone: true,
    },
  ],
};

/** A long chat's earlier messages: read before the top, shown under way, and where the chat began (2026-11-10). */
const EARLIER_MESSAGES_TOUR: Tour = {
  id: "earlier-messages-2026-11-10",
  title: "Earlier messages in a long chat",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: TRANSCRIPT,
      title: "Scroll up to the beginning",
      text: "In a long chat, scroll up: its earlier messages are read about two screens before you reach the top, and the top says <b>Loading earlier messages…</b> while they are. If a read fails, it says so with <b>Try again</b>, and reads them again by itself once the connection is back. Once the chat's first message shows, the top says <b>Beginning of the chat</b>, with the day it began.",
      action: next,
    },
  ],
};

/** Secrets the AI is shown only as placeholders (omp's Hide Secrets), from the message box (2026-11-11). */
const SECRETS_TOUR: Tour = {
  id: "secrets-2026-11-11",
  title: "Secrets as placeholders",
  minutes: 1,
  sandbox: false,
  steps: [
    PLUS_STEP,
    {
      target: part("add-secret"),
      title: "Add a secret",
      text: "Paste a key or a password here, with a name. The AI is shown its placeholder, not the value: your message gets the placeholder, shown as a lock and the name, and omp puts the value in a command that uses it. When the AI saves a value for you, a notice offers <b>Copy</b>. Your secrets are in Settings → Providers → <b>Secrets</b>.",
      action: next,
    },
  ],
};

/** Secrets kept from the AI more thoroughly, after a review of Hide Secrets (2026-11-11). */
const SECRETS_GUARD_TOUR: Tour = {
  id: "secrets-guard-2026-11-11",
  title: "Secrets, guarded more closely",
  minutes: 1,
  sandbox: false,
  steps: [
    PLUS_STEP,
    {
      target: part("add-secret"),
      title: "Where a secret stays hidden",
      text: "A saved secret is now hidden in everything the AI is sent: the notes about commands that finished in the background, its own instructions, its summaries. A secret you remove stops working at once, also in chats already running. And a picture in the AI's reply is a link you choose to open, so nothing in a reply is fetched by itself.",
      action: next,
    },
  ],
};

/** A secret goes only into commands, and a running chat takes a new one in with no restart (2026-11-11). */
const SECRETS_COMMANDS_TOUR: Tour = {
  id: "secrets-commands-2026-11-11",
  title: "Secrets go only into commands",
  minutes: 1,
  sandbox: false,
  steps: [
    PLUS_STEP,
    {
      target: part("add-secret"),
      title: "Only commands get a secret",
      text: "A saved secret is filled in only for commands (bash, eval), whose text you read in full in the card. Any other tool the AI calls with a secret's placeholder, such as writing a file, fetching a page or an MCP tool, is refused, so a secret cannot slip into a web request or a file unseen. A secret you save while a chat runs works in it at once, with no restart, and the chat keeps the command with the placeholder.",
      action: next,
    },
  ],
};

/** On an iPhone or an iPad, a swipe up stops at the top of what is loaded (2026-11-11). */
const SWIPE_STOPS_TOUR: Tour = {
  id: "swipe-stops-2026-11-11",
  title: "A swipe up a long chat on an iPhone",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: TRANSCRIPT,
      title: "It stops at what is loaded",
      text: "On an iPhone or an iPad, a swipe up a long chat stops at the top of the messages loaded, where the top says <b>Loading earlier messages…</b>. They go in as soon as the scroll rests, with your place kept, and the next swipe goes on.",
      action: next,
    },
  ],
};

/** A side panel in a narrow window: the chat list steps aside so the chat keeps its room (2026-11-10). */
const LIST_STEPS_ASIDE_TOUR: Tour = {
  id: "list-steps-aside-2026-11-10",
  title: "Room for the chat beside a side panel",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: SIDE_PANEL_RAIL,
      title: "The chat list steps aside",
      text: "In a narrow window, a side panel no longer squeezes the chat: the chat list and the panel take turns. While the panel is open, the list steps aside, and it comes back when the panel closes. The button before the tabs or {chatList} brings the list back and closes the panel.",
      action: next,
      notOnPhone: true,
    },
  ],
};

/** Save debug log, in Settings → App and the palette (2026-11-08). */
const DEBUG_LOG_TOUR: Tour = {
  id: "debug-log-2026-11-08",
  title: "Save the debug log",
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
      text: "The debug log is under <b>App</b>, this app's own settings. Click it.",
      action: { kind: "click" },
    },
    {
      target: part("debug-log"),
      title: "Debug log",
      text: "When something goes wrong, <b>Save debug log</b> downloads what the app did as one file: its versions, the last lines of its log and the page's errors. Attach it to an issue. The palette has it too: {palette}, then <b>debug</b>.",
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

/** #2838 part 3: presets and roles of one's own in omp's Models. */
const PRESETS_TOUR: Tour = {
  id: "model-presets-2026-11-06",
  title: "Presets and roles of your own",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: MESSAGE_BOX,
      title: "Models",
      text: "{modelHub} opens omp's Models. Try it.",
      action: { kind: "appears", selector: MODEL_HUB },
    },
    {
      target: `${MODEL_HUB} [data-tour="model-presets"]`,
      title: "Presets",
      text: "A preset keeps every role's model and the default thinking level under a name. <b>Save as…</b> keeps them as they are; picking a preset puts them back and moves this chat to its default model. Under the roles, <b>New role…</b> names a role of your own: the first model you give it creates it. {stop} closes Models.",
      action: { kind: "disappears", selector: MODEL_HUB },
    },
  ],
};

/** #2838 part 2: a role's fallbacks in omp's Models. */
const FALLBACKS_TOUR: Tour = {
  id: "role-fallbacks-2026-11-06",
  title: "Fallbacks for a role",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: MESSAGE_BOX,
      title: "Models",
      text: "{modelHub} opens omp's Models. Try it.",
      action: { kind: "appears", selector: MODEL_HUB },
    },
    {
      target: `${MODEL_HUB} [data-tour="role-fallbacks"]`,
      title: "Fallbacks",
      text: "When the picked role's model fails (an outage, a usage limit), omp tries these models instead, in order. <b>Add a fallback…</b> adds one of the models the role takes; the arrows change the order and × removes one. omp keeps them in its own settings, so the terminal uses them too. {stop} closes Models.",
      action: { kind: "disappears", selector: MODEL_HUB },
    },
  ],
};

/** omp's web search engines, their keys and the order a search tries them, in Models → Web search (#11, #12). */
const SEARCH_ENGINES_TOUR: Tour = {
  id: "search-engines-2026-11-10",
  title: "Web search engines and their keys",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: MESSAGE_BOX,
      title: "Models",
      text: "{modelHub} opens omp's Models. Try it.",
      action: { kind: "appears", selector: MODEL_HUB },
    },
    {
      target: `${MODEL_HUB} [data-role="web"]`,
      title: "Web search",
      text: "omp's web search is a role with engines instead of models. Pick <b>Web search</b>.",
      action: { kind: "click" },
    },
    {
      target: `${MODEL_HUB} [data-tour="search-order"]`,
      title: "The order",
      text: "What a web search tries, in order: the first engine, then the next whenever one fails. Without fallbacks of your own, omp's default list follows the first. The arrows move an engine, × takes it out, and <b>Back to omp's default fallbacks</b> drops your list.",
      action: next,
    },
    {
      target: `${MODEL_HUB} [data-tour="search-engines"]`,
      title: "Every engine, with its key",
      text: "Every search engine omp has, by whether it can search now; each says where its key comes from. Open one for its key: typed hidden, kept in omp's own store and checked with a real search, with <b>Replace key</b> and <b>Remove key</b> once saved. <b>Test search</b> runs one search with it alone; <b>Search with this first</b> and <b>Add as a fallback</b> put it in the order. {stop} closes Models.",
      action: { kind: "disappears", selector: MODEL_HUB },
    },
  ],
};

/** #2838 part 4: a model's compaction limit in omp's Models. */
const COMPACTION_LIMIT_TOUR: Tour = {
  id: "compaction-limit-2026-11-06",
  title: "When a model's chats compact",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: MESSAGE_BOX,
      title: "Models",
      text: "{modelHub} opens omp's Models. Try it.",
      action: { kind: "appears", selector: MODEL_HUB },
    },
    {
      target: `${MODEL_HUB} [data-tour="compaction-limit"]`,
      title: "Compaction limit",
      text: "This line says when chats on the picked role's model compact, and what decides it. <b>Compaction limit…</b> (or K on the role) sets the model's own limit: a token base the policy scales (400k), a fixed point (f400k) or a share of the window (80%); omp says where that compacts as you type, and empty goes back to omp's setting. A limit that opens the model's larger window asks first. {stop} closes Models.",
      action: { kind: "disappears", selector: MODEL_HUB },
    },
  ],
};

/** #2838 part 5: omp's Models view in the app's Models. */
const MODELS_VIEW_TOUR: Tour = {
  id: "models-view-2026-11-06",
  title: "Every model, by provider and kind",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: MESSAGE_BOX,
      title: "Models",
      text: "{modelHub} opens omp's Models. Try it.",
      action: { kind: "appears", selector: MODEL_HUB },
    },
    {
      target: `${MODEL_HUB} [aria-label="View"]`,
      title: "Roles or models",
      text: "<b>Models</b> lists every model omp has, as its Models view does: Recent, All models and each provider with its count, then the providers not signed in, with how to sign in (Sign in, for one with a sign-in page). Kind tabs and the search narrow the list. Pick a model, then a role under the list to give it that role; a lit role clears it. {stop} closes Models.",
      action: { kind: "disappears", selector: MODEL_HUB },
    },
  ],
};

/**
 * #2838: omp's roles in the model menu, and its model panel from there. Like the model menu's tour, the steps inside
 * the menu act there (a click on the tour's Next lands outside the menu and closes it).
 */
const ROLES_MENU_TOUR: Tour = {
  id: "roles-menu-2026-11-06",
  title: "Roles in the model menu",
  minutes: 1,
  sandbox: true,
  steps: [
    PLUS_STEP,
    {
      target: part("model"),
      title: "The model menu",
      text: "Click or tap the model. With two roles or more, the roles {nextRole} switches between (smol, default, slow, …) are at the top of the menu: a pick switches this chat to the role's model and the thinking level it names. In the list below, a model a role uses carries the role's name.",
      action: { kind: "appears", selector: MODEL_MENU },
    },
    {
      target: part("model-roles-link"),
      title: "Roles and models",
      text: "<b>Roles and models…</b> opens omp's model panel at this chat's role: which model and thinking level each role uses, for this project or everywhere. Settings → Model has it too, and on a computer {modelHub}. Click or tap it.",
      action: { kind: "appears", selector: MODEL_HUB },
    },
    {
      target: MODEL_HUB,
      title: "omp's model panel",
      text: "The roles are on the left, the picked role's models on the right: choosing one gives it to the role. Close the panel when you're done.",
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
      text: "<b>Usage</b>; <b>Agents</b>: the chat's subagents (a click opens the Agent Hub on one); <b>Progress</b>: its goal, omp's todo list and plan mode; and <b>Questions</b>: its side questions, and what omp asks you. They follow the chat you are in.",
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
      text: "Chats waiting for you, and turns that end while you are in another window or workspace, gather behind this bell, as in Tern; the number counts them. Open it.",
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
      text: "The side panel's buttons are on this rail at the right edge, where the panel opens: <b>Usage</b>, <b>Agents</b>, <b>Progress</b> and <b>Questions</b>, among others. A button opens the panel on its panel; the same button again puts it away. Click <b>Questions</b>, the one with the question mark.",
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
const SPLIT_TAB = "[data-tab][data-split]:not([data-hidden])";

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
      title: "The side panel is a window too",
      text: "Click <b>Usage</b>, or press {sidePanel}: the side panel opens as a window at the right of your chats.",
      action: { kind: "appears", selector: SIDE_PANEL },
    },
    {
      target: SIDE_PANEL,
      title: "Size it as you like",
      text: "Drag the line between it and the chat to make it wider or narrower, or drag its title to move it, as with a chat. Each workspace keeps its own, also after a reload.",
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
      target: part("quick-prompts-key"),
      title: "Your quick prompts",
      text: "Beside Send, <b>⚡</b> puts your quick prompts in the keyboard's place, and <b>⌨</b> brings the keyboard back. Tap <b>⚡</b>.",
      action: { kind: "appears", selector: part("quick-panel") },
    },
    {
      target: part("quick-panel"),
      title: "One tap answers",
      text: "Tap a prompt to send it as it is, or hold it to put it in the box and change it first. <b>Sent</b> lists what you sent in this chat; a tap puts one back in the box.",
      action: next,
    },
    {
      target: part("plus"),
      title: "＋ for the rest",
      text: "<b>＋</b> holds a photo or file, the quick prompts, and this chat's model, thinking level, plan mode and goal. The empty box names the model and its level.",
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

/** #2837: on a phone, ＋ holds what the box does besides typing. */
const PHONE_PLUS_TOUR: Tour = {
  id: "phone-plus-2026-11-06",
  title: "＋ on the phone",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: part("plus"),
      title: "＋ beside the box",
      text: "On a phone, <b>＋</b> holds a photo or file, the quick prompts, and this chat's model, thinking level, plan mode and goal. Tap it.",
      action: { kind: "appears", selector: PLUS_SHEET },
      phoneOnly: true,
    },
    {
      target: PLUS_SHEET,
      title: "One sheet",
      text: "Pick what you need: the model and the thinking level open their own lists over it. Tap above the sheet to close it.",
      action: { kind: "disappears", selector: PLUS_SHEET },
      phoneOnly: true,
    },
  ],
};

/** #2837: on a phone, ⚡ sits beside Send. */
const PHONE_QUICK_KEY_TOUR: Tour = {
  id: "phone-quick-key-2026-11-06",
  title: "⚡ beside Send",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: part("quick-prompts-key"),
      title: "Your quick prompts",
      text: "On a phone, <b>⚡</b> sits beside Send. Tap it: your quick prompts take the keyboard's place.",
      action: { kind: "appears", selector: part("quick-panel") },
      phoneOnly: true,
    },
    {
      target: part("quick-panel"),
      title: "One tap answers",
      text: "Tap a prompt to send it as it is, or hold it to put it in the box and change it first. <b>⌨</b> beside Send brings the keyboard back.",
      action: next,
      phoneOnly: true,
    },
  ],
};

/** A side panel that names its app: that app's context and line stay in the panel. A page of its own: one step. */
const LITE_HOST_NAME_TOUR: Tour = {
  id: "lite-host-name-2026-11-07",
  title: "Your notes app's context stays in its panel",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: null,
      title: "Only from its side panel",
      text: "A message you send from your notes app's side panel takes along what that app has open, when its extension adds it, and the line saying so shows in that panel. Messages from the full app don't take it along, and the full app doesn't show that line.",
      action: next,
      centred: true,
    },
  ],
};

/** #2845: the lite view at a computer's layout, and its assistant's start. A page of its own: the step stands alone. */
const LITE_ASSISTANT_TOUR: Tour = {
  id: "lite-assistant-2026-11-06",
  title: "The side panel as your notes app's assistant",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: null,
      title: "A computer's chat in the side panel",
      text: "On a computer the side panel keeps the full chat at any width: the message box with the model, thinking level, plan mode, attach, <b>/</b> and <b>@</b>, at a computer's sizes. Its empty chat greets you as the notes app's assistant: the app can set the greeting, suggestions you click to send, and the box's text.",
      action: next,
      centred: true,
    },
  ],
};

/** #2844: the lite view in its host's look. It is a page of its own, so the step stands alone. */
const LITE_HOST_LOOK_TOUR: Tour = {
  id: "lite-host-look-2026-11-06",
  title: "The side panel in your notes app's look",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: null,
      title: "In your notes app's look",
      text: "In another app's side panel the chat takes that app's look: the colours, font and text size it puts in the address (<b>bg</b>, <b>surface</b>, <b>fg</b>, <b>muted</b>, <b>border</b>, <b>accent</b>, <b>font</b>, <b>fontSize</b>). The list of tools omp mounts when a chat starts stays out of it; a warning or an error shows as one line.",
      action: next,
      centred: true,
    },
  ],
};

/** Math drawn by KaTeX: nothing to point at in a sandbox chat, so the step stands alone. */
const MATH_DRAWN_TOUR: Tour = {
  id: "math-drawn-2026-11-06",
  title: "Math, drawn whole",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: null,
      title: "Math, drawn whole",
      text: "Math in replies is drawn in its own fonts, the same on every device: a boxed result has its frame, a brace spans what it is under, and roots, integrals and fractions are drawn whole.",
      action: next,
      centred: true,
    },
  ],
};

/** #2843: the lite view, one chat for another app's side panel. It is a page of its own, so the step stands alone. */
const LITE_VIEW_TOUR: Tour = {
  id: "lite-view-2026-11-06",
  title: "A chat in another app's side panel",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: null,
      title: "One chat, in another app's side panel",
      text: "Another app, such as your notes app, can show a chat of this app in its side panel: point it at this app's address followed by <b>/lite</b>. It has the chat and its message box, your recent chats in its title's menu, New chat, and a button that opens the chat here. Browser extensions and VS Code may always show it; any other page must be named on the computer the app runs on.",
      action: next,
      centred: true,
    },
  ],
};

/** #2846: `@` mentions of names with spaces, quoted or as words. */
const MENTION_SPACES_TOUR: Tour = {
  id: "mention-spaces-2026-11-07",
  title: "Names with spaces after @",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: MESSAGE_BOX,
      title: "Names with spaces",
      text: "Type <b>@</b> and a name that has spaces, such as a file or a note: the menu keeps searching past each space while something matches, and closes once nothing does. <b>@\"</b> starts a name in quotes, as in omp's terminal. The row you pick replaces all you typed.",
      action: next,
    },
  ],
};

/** #2842: an omp extension's lines beside the message box. */
const EXTENSION_WIDGETS_TOUR: Tour = {
  id: "extension-widgets-2026-11-06",
  title: "Your extensions' lines",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: MESSAGE_BOX,
      title: "Lines from your extensions",
      text: "An omp extension can show a few lines next to the message box, as in omp's terminal: above it, or below it when it asks, such as which notes go with your next message. It changes or clears them as it goes.",
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
      text: "Each card is a small picture of the app in that theme. A click makes it yours: a dark theme as your dark theme, a light one as your light theme.",
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
      text: "{stop} closes settings. The palette ({palette}) lists every theme too: type <b>Theme</b> and pick one.",
      action: { kind: "disappears", selector: SETTINGS_SHEET },
    },
  ],
};

/** Themes change on a click only: pointing at one no longer redraws the app in it (2026-11-12). */
const THEME_CLICK_TOUR: Tour = {
  id: "theme-click-2026-11-12",
  title: "Themes change on a click",
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
      text: "The themes are under <b>App</b>. Click it.",
      action: { kind: "click" },
    },
    {
      target: THEME_GALLERY,
      title: "Click a theme to use it",
      text: "Pointing at a card changes nothing now; a click makes it your theme. Showing a theme redraws every open chat, which made pointing across the cards slow.",
      action: next,
    },
    {
      target: SETTINGS_SHEET,
      title: "Close settings",
      text: "{stop} closes settings. In the palette ({palette}), moving through the theme rows changes nothing either; Enter picks one.",
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

/** #2836 D6: omp's statistics on the dashboard. */
const STATS_TOUR: Tour = {
  id: "dashboard-stats-2026-11-06",
  title: "omp's statistics",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: part("dashboard-button"),
      title: "The dashboard",
      text: "{dashboard} opens the dashboard. Open it.",
      action: { kind: "appears", selector: DASHBOARD },
    },
    {
      target: `${DASHBOARD} [aria-label="Statistics"]`,
      title: "omp's statistics",
      text: "<b>Show omp's statistics</b> starts omp's own statistics page on the server (what /stats shows: requests, costs, models, tools and errors) and shares it; <b>Open omp's statistics</b> then opens it here, on a phone too. Its first start reads every chat, so it can take a minute.",
      action: next,
    },
  ],
};

/** #2836 D5b: what the rules did, and whether a held chat's prompt cache is still warm. */
const ACTIVITY_TOUR: Tour = {
  id: "dashboard-activity-2026-11-06",
  title: "What the rules did",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: part("dashboard-button"),
      title: "The dashboard",
      text: "{dashboard} opens the dashboard. Open it.",
      action: { kind: "appears", selector: DASHBOARD },
    },
    {
      target: `${DASHBOARD} [aria-label="Activity"]`,
      title: "Activity",
      text: "<b>Activity</b> lists what the rules did, newest first: each chat they paused, held again or continued, and the ones you continued, skipped or resumed by hand, with the time, the rule and the condition. In the <b>Queue</b>, a held chat says whether its prompt cache is likely still warm (paused under 5 minutes ago) or is written again when it continues.",
      action: next,
    },
  ],
};

/** #2836 D5: the dashboard. */
const DASHBOARD_TOUR: Tour = {
  id: "dashboard-2026-11-06",
  title: "Your dashboard",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: part("dashboard-button"),
      title: "The dashboard",
      text: "Your usage windows and their pace, the rules that pause chats on conditions, and the chats they hold. {dashboard} opens it from anywhere. Open it.",
      action: { kind: "appears", selector: DASHBOARD },
    },
    {
      target: `${DASHBOARD} [aria-label="Rules"]`,
      title: "Rules",
      text: "A rule pauses the chats you pick while a condition holds: a window at a percent, the pace heading past a line before the window resets, or hours of the day. They stop at their next step and continue once none holds. A chat you resume by hand runs on until the condition next starts.",
      action: next,
    },
    {
      target: `${DASHBOARD} [aria-label="Queue"]`,
      title: "The queue",
      text: "The chats the rules hold, in the order they continue: one at a time, three minutes apart, so a window that resets is not spent at once. <b>Continue now</b> lets one go out of its turn; <b>Skip</b> leaves it paused for you.",
      action: next,
    },
  ],
};

/** #2836 D1b: an HTML file the chat writes opens as a page, from the write's card. */
const PAGE_FROM_CHAT_TOUR: Tour = {
  id: "page-from-chat-2026-11-06",
  title: "A page the chat wrote",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: null,
      title: "Open what the chat wrote",
      text: "When omp writes an HTML file in this chat's folder, open the write's card in the chat: <b>Share as a page</b> makes it a page of its own on your paired devices, then <b>Open in browser</b> shows it with its styles, scripts and pictures. Ports lists it under Pages, with <b>Stop sharing</b>.",
      action: next,
      centred: true,
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
      text: "On a phone, ⓘ in the top bar opens this chat's usage, agents, progress, jobs and side questions as a screen of their own. While omp keeps a to-do list or the chat has agents, the button shows their counts in place of ⓘ. Tap it.",
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

/** #2837: on a phone, omp's to-do list and the chat's agents show in the top bar, not in a row above the message box. */
const PHONE_TOP_TOUR: Tour = {
  id: "phone-top-2026-11-06",
  title: "The to-do list and agents on the phone",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: part("chat-details-button"),
      title: "Up in the top bar",
      text: "On a phone, while omp keeps a to-do list or the chat has agents, this button shows how far the list got and how many agents are running, where ⓘ was. The row above the message box is gone. Tap it.",
      action: { kind: "click" },
      phoneOnly: true,
    },
    {
      target: SIDE_PANEL,
      title: "Progress first",
      text: "It opens the chat's details at Progress, or at Agents when there is no list. ‹ Chat brings you back to the chat as you left it.",
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
  title: "Window mode",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: WORKSPACE,
      centred: true,
      title: "A second window",
      text: "Window mode works on windows, so first press {splitRight} to split: a blank window opens to the right.",
      action: keys("splitRight"),
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Window mode",
      text: "Press {paneMode}. Until it ends, plain keys work on the windows, in any browser and on any keyboard: no Super key needed.",
      action: keys("paneMode"),
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Go, resize, share",
      text: "← → ↑ ↓ go to the window in that direction, with Shift they make it larger or smaller, = shares the space and [ ] go to the previous or next window. Esc ends it, as do 3 seconds without a key; {paneMode} starts it again.",
      action: next,
    },
  ],
};

/** #2790: dropping where you let go. A second pane first, so there is a pane to move and one to drop on. */
const DROP_TOUR: Tour = {
  id: "drop-2026-11-02",
  title: "Dropping chats and windows",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: WORKSPACE,
      centred: true,
      title: "A second window",
      text: "Press {splitRight} to split: a blank window opens to the right, to drop a chat on.",
      action: keys("splitRight"),
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Drag a chat or a window",
      text: "Drag a chat from the list, or a window by the grip ⠿ at the start of its title, and let go anywhere on a window. A label where it will land says what the drop does.",
      action: next,
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Where it lands",
      text: "A blank window it fills. Near a window's edge it splits that window on that side; in its middle, a chat from the list takes its place. Along the workspace's own edges it makes a column or row the whole length of that side.",
      action: next,
    },
  ],
};

const NEW_WORKSPACE = part("new-workspace");
const BLANK_WINDOW = "[data-blank-window]";

/** #2791: workspaces as tabs on top, made of windows; a window is blank until a chat fills it. */
const WORKSPACES_TOUR: Tour = {
  id: "workspaces-2026-11-02",
  title: "Workspaces and windows",
  minutes: 2,
  sandbox: false,
  steps: [
    {
      target: NEW_WORKSPACE,
      title: "A new workspace",
      text: "Click <b>New workspace</b>. A workspace is a tab on top with windows of its own, and it starts as one blank window.",
      action: { kind: "click" },
    },
    {
      target: BLANK_WINDOW,
      title: "A blank window",
      text: "It holds only <b>New chat</b>, which starts a chat in it. Or click a chat in the list, or drag one onto it: the chat fills the window.",
      action: next,
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "More windows",
      text: "Press {splitRight} to split: the new window is blank, and {splitDown} splits downward. A new chat never takes another's place: when the window you're in shows a chat, the new one opens in a workspace of its own.",
      action: keys("splitRight"),
    },
    {
      target: TABS,
      title: "Your workspaces",
      text: "Each workspace is a tab here, named after its first chat. Click one to show it, double-click to rename it, drag it to move it; <b>+</b> adds one. Closing a window or a workspace leaves its chats running, in the list.",
      action: next,
    },
    {
      target: TABS,
      title: "Done here",
      text: "Close this workspace with {closeTab}.",
      action: keys("closeTab"),
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

/** #13: a provider's accounts in Usage, their shares added up as `omp usage` does, and each account's own lines. */
const USAGE_ACCOUNTS_TOUR: Tour = {
  id: "usage-accounts-2026-11-10",
  title: "Usage for each of your accounts",
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
      target: `${SIDE_PANEL} section[aria-label="Your accounts"]`,
      title: "Each account",
      text: "With two or more accounts on a provider, each window's line adds up what they used, as <b>omp usage</b> does: how many accounts' worth is used and left, and when the fullest one resets. <b>Each account</b> opens every account's own lines, each under its email as <b>omp usage</b> shows it.",
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

/** #14: a chat's own part of its provider's 5-hour window and its budget; a provider's chats paused at once. */
const USAGE_BUDGET_TOUR: Tour = {
  id: "usage-budget-2026-11-11",
  title: "A chat's budget, and a provider's chats",
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
      target: `${SIDE_PANEL} [data-tour="usage-budget"]`,
      title: "Its own budget",
      text: "Once a chat has replied, this says how much of its provider's 5-hour window the chat used itself: the window's growth between the app's readings, split by what each chat spent. <b>Pause this chat after its own part</b> pauses it there, as /pause does, until the window resets, while your other chats go on.",
      action: next,
    },
    {
      target: `${SIDE_PANEL} section[aria-label="Your accounts"]`,
      title: "A provider's chats",
      text: "Under each provider, <b>Pause chats</b> and <b>Continue chats</b> act on all its running chats at once. On the dashboard, a rule can pause every chat, or every chat on one provider, also those started later.",
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

/** #19: This chat's figures, the whole chat's from omp's statistics and those in its context from omp's /session. */
const USAGE_THIS_CHAT_TOUR: Tour = {
  id: "usage-this-chat-2026-11-11",
  title: "This chat's figures",
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
      target: `${SIDE_PANEL} section[aria-label="This chat"]`,
      title: "This chat",
      text: "Once the chat has replied, <b>The whole chat</b> shows what it spent, omp's replies, its tool calls, subagents and tokens over its whole history, as omp's statistics count them. <b>In its context now</b> shows omp's /session figures: when omp compacts a chat, a summary takes the place of its older messages, so those count only what came since.",
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

/** #14: the dashboard's Tasks, and Queue for later beside Send (on a phone, in ＋). */
const TASKS_TOUR: Tour = {
  id: "tasks-2026-11-11",
  title: "Queued tasks",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: part("dashboard-button"),
      title: "The dashboard",
      text: "{dashboard} opens the dashboard. Open it.",
      action: { kind: "appears", selector: DASHBOARD },
    },
    {
      target: `${DASHBOARD} [aria-label="Tasks"]`,
      title: "Tasks",
      text: "A task is a message for a chat, or a new chat in a folder, that the server sends as soon as the chat is free, after its provider's 5-hour window resets, or at a time: never while the chat works, is paused or a rule holds it. A chat's tasks go one at a time, in this order: the arrows change it, and <b>Send now</b> lets one go. In a chat, <b>Queue for later</b> beside Send (on a phone, in <b>＋</b>) makes the typed message a task.",
      action: next,
    },
  ],
};

/** #15: the dashboard's overview, its chats, and its graphs of use and spend. */
const DASHBOARD_OVERVIEW_TOUR: Tour = {
  id: "dashboard-overview-2026-11-11",
  title: "The dashboard at a glance",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: part("dashboard-button"),
      title: "The dashboard",
      text: "{dashboard} opens the dashboard. Open it.",
      action: { kind: "appears", selector: DASHBOARD },
    },
    {
      target: `${DASHBOARD} [aria-label="Overview"]`,
      title: "At a glance",
      text: "What you spent in the last 24 hours and 7 days, the tokens and failures of the last 24 hours, your chats by what they do, and each window as a half ring, coloured as it fills: calm, then warning from 75%, then danger from 90%.",
      action: next,
    },
    {
      target: `${DASHBOARD} [aria-label="Chats"]`,
      title: "Every running chat",
      text: "What each chat does, the model it answers with, and its part of its provider's 5-hour window with what it spent there. <b>Pause</b> and <b>Continue</b> work as /pause does in the chat.",
      action: next,
    },
    {
      target: `${DASHBOARD} [aria-label="Over the day"]`,
      title: "Over the day",
      text: "Each window's use over the last day, from the server's readings, and below it each window split among the chats that used it. Statistics draws the cost of each hour or day the same way.",
      action: next,
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

/** #16: MCP servers added, edited, turned off and on, and removed in Settings → Tools. */
const MCP_SERVERS_TOUR: Tour = {
  id: "mcp-servers-2026-11-11",
  title: "Editing MCP servers",
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
      text: "Under <b>Tools</b>, <b>MCP servers</b> lists the servers in your MCP file, for every folder, and this folder's own: how omp reaches each, a switch to turn it off and on, <b>Test</b>, <b>Edit</b> and <b>Remove</b>.",
      action: next,
    },
    {
      target: SETTINGS_SHEET,
      title: "Add a server",
      text: "<b>Add a server</b> takes the command that starts it or its address, or, in its <b>JSON</b> tab, the server's JSON from its page. Saved keys never come back to the page: an edit keeps them unless you type a new one.",
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

/** #17: a reply's link to a file of the chat's folder opens it in the app's own viewer. */
const FILE_LINKS_TOUR: Tour = {
  id: "file-links-2026-11-11",
  title: "Links to files in replies",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: TRANSCRIPT,
      title: "Links to files",
      text: "When a reply links to a file of this chat's folder, such as a report it wrote, a click opens the file here, beside the chat (on a phone, over the screen), read over the app's own connection: nothing is put on the network for it. A link out of the folder is not opened, and the app says where it pointed. Links to web pages open in a new tab.",
      action: next,
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
      text: "On a tablet the chat list's rows, the message box's buttons, the windows' title bars and Settings are a finger's size, and the buttons that show on pointing are always shown.",
      action: next,
      tabletOnly: true,
    },
    {
      target: null,
      title: "Resize the windows",
      text: "Drag the line between two windows to resize them: a touch anywhere close to it takes it.",
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
      text: "With an iPad's keyboard or on a Mac, every Ctrl key works with ⌘ too: ⌘⇧T opens a workspace, ⌘P switches the model's role. {shortcuts} lists every key, shown with ⌘ there. Try it.",
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

const ATTACH_FILES = part("attach-files");

const THINKING_MENU = '[data-slot="dropdown-menu-content"]';

/** #2837: the thinking level is a menu of the levels the model offers. */
const THINKING_MENU_TOUR: Tour = {
  id: "thinking-menu-2026-11-06",
  title: "Pick the thinking level",
  minutes: 1,
  sandbox: true,
  steps: [
    PLUS_STEP,
    {
      target: part("thinking"),
      title: "Thinking levels",
      text: "Click or tap the thinking level: the menu lists every level this model offers, the one in use checked. Try it.",
      action: { kind: "appears", selector: THINKING_MENU },
    },
    {
      target: THINKING_MENU,
      title: "Pick one",
      text: "Pick any level, or close the menu. On a computer {thinkingLevel} still steps to the next one.",
      action: { kind: "disappears", selector: THINKING_MENU },
    },
  ],
};

/** #2783, #2830: photos and any other file from the device's picker, on a computer and a phone. */
const ATTACH_FILES_TOUR: Tour = {
  id: "attach-files-2026-11-05",
  title: "Files in a message",
  minutes: 1,
  sandbox: false,
  steps: [
    PLUS_STEP,
    {
      target: ATTACH_FILES,
      title: "Attach files",
      text: "Tap or click here to add photos or any file to your message. Pictures go to the model with it; other files are uploaded to this chat's own folder, where omp reads them and moves them where you ask. On a computer you can also drop or paste files on the box.",
      action: next,
    },
  ],
};

/** #2783: a picture from the device's picker, on a phone or a tablet (the paperclip since #2830). */
const ATTACH_IMAGES_TOUR: Tour = {
  id: "attach-images-2026-11-01",
  title: "Photos in a message",
  minutes: 1,
  sandbox: false,
  steps: [
    PLUS_STEP,
    {
      target: ATTACH_FILES,
      title: "Attach a photo",
      text: "Tap here to add photos or pictures to your message, from your library, the camera or your files. They go with the next message you send.",
      action: next,
    },
  ],
};

const PORTS_PANEL = part("ports-panel");

/** #2788: the services on the app's computer, and pages, opened on the paired devices. */
const PORTS_TOUR: Tour = {
  id: "ports-2026-11-02",
  title: "Ports and pages",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: SIDE_PANEL_RAIL,
      title: "A Ports panel",
      text: "Click <b>Ports</b> on this rail: the side panel opens on the services running on the app's computer.",
      action: { kind: "appears", selector: PORTS_PANEL },
    },
    {
      target: PORTS_PANEL,
      title: "Open a service on your devices",
      text: "Each service is listed with its port. <b>Share</b> one, then <b>Open</b> takes you to it in your browser; it opens only on devices paired with the app. A service a chat starts on a port someone picked, such as a dev server's 5173, is shared by itself, and the chat shows a line with <b>Open</b>.",
      action: next,
    },
    {
      target: PORTS_PANEL,
      title: "A page of your own",
      text: "An HTML file open in <b>Files</b> has <b>Share as a page</b>: then <b>Open in browser</b> shows it with its styles, scripts and pictures. Shared pages are listed here too, with <b>Stop sharing</b>.",
      action: next,
    },
  ],
};

/** #2836 D1: the chats' services first, the machine's other ports folded away; an ended share says so. */
const SHARING_TOUR: Tour = {
  id: "sharing-2026-11-06",
  title: "Your chats' services first",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: SIDE_PANEL_RAIL,
      title: "Ports",
      text: "Click <b>Ports</b> on this rail.",
      action: { kind: "appears", selector: PORTS_PANEL },
    },
    {
      target: PORTS_PANEL,
      title: "Your chats' services first",
      text: "The services your chats started, and the ones shared, come first. Every other port listening on the machine is folded under <b>Other services on this machine</b>. A share whose service stopped says so, here and in the chat's line, instead of offering a link that goes nowhere.",
      action: next,
    },
  ],
};

/** Only a port someone picked opens by itself: one handed out at random, or a debugger's, waits for Share. */
const PICKED_PORTS_TOUR: Tour = {
  id: "picked-ports-2026-11-09",
  title: "Which services open by themselves",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: SIDE_PANEL_RAIL,
      title: "Ports",
      text: "Click <b>Ports</b> on this rail.",
      action: { kind: "appears", selector: PORTS_PANEL },
    },
    {
      target: PORTS_PANEL,
      title: "Only ports someone picked open by themselves",
      text: "A service a chat starts on a port someone picked, such as a dev server on 3000, 5173 or 8080, still opens on your paired devices by itself after 5 seconds, with a line in the chat. One on a port the system handed out at random (test servers, an editor's own ports) or a debugger's port is only listed here: <b>Share</b> opens it when you want it.",
      action: next,
    },
  ],
};

const RUNNING_TOUR: Tour = {
  id: "running-2026-11-02",
  title: "Chats running in other folders",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: CHAT_LIST,
      title: "Chats running in other folders",
      text: "A chat keeps running when you switch to another folder. At the top of this list, <b>Running in other folders</b> shows each one with its folder's name and its mark: working, waiting for you, or paused. Click one to open it in the focused window, or drag it onto a window. <b>Stop running</b> in a running chat's menu ends it, here and in its own folder; it stays in its folder's list, and opening it starts it again.",
      action: next,
    },
  ],
};

const BROWSER_PANEL = part("browser-panel");

const BROWSER_TOUR: Tour = {
  id: "browser-2026-11-03",
  title: "A browser for chats",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: SIDE_PANEL_RAIL,
      title: "A Browser panel",
      text: "Click <b>Browser</b> on this rail: the side panel opens on the browsers your chats can use.",
      action: { kind: "appears", selector: BROWSER_PANEL },
    },
    {
      target: BROWSER_PANEL,
      title: "Which browser chats use",
      text: "<b>omp's hidden one</b> is a browser omp runs out of sight on the app's computer, signed in to nothing. <b>The one shown here</b> is a Chrome on the app's computer, shown live: type an address, click and type in the page, and chats drive the same tabs; sign in to your sites in it once. <b>Your own browser</b> lets chats drive the browser on your computer.",
      action: next,
    },
    {
      target: BROWSER_PANEL,
      title: "Your own browser",
      text: "Chrome, Edge or another Chromium browser with omp's relay extension: your computer runs the line shown here to reach the app's computer, and once the browser connects, its tabs are listed here. While it is on, anything on the app's computer can drive it, so put the extension in a profile of its own. Chosen here, it stays until you choose another browser.",
      action: next,
    },
  ],
};

/** Your own browser stays chosen until another is chosen (2026-11-07). */
const BROWSER_STAYS_TOUR: Tour = {
  id: "browser-stays-2026-11-07",
  title: "Your own browser stays",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: SIDE_PANEL_RAIL,
      title: "The Browser panel",
      text: "Click <b>Browser</b> on this rail: the side panel opens on the browsers your chats can use.",
      action: { kind: "appears", selector: BROWSER_PANEL },
    },
    {
      target: BROWSER_PANEL,
      title: "Your own browser stays",
      text: "Chosen here, <b>Your own browser</b> no longer turns itself off after 30 minutes: chats use it until you choose another browser, and its relay starts again after the app restarts.",
      action: next,
    },
  ],
};

const QUESTIONS = part("questions");
const QUESTIONS_HIDDEN = part("questions-hidden");

const QUESTIONS_TOUR: Tour = {
  id: "questions-2026-11-03",
  title: "omp's questions, one at a time",
  minutes: 2,
  sandbox: true,
  steps: [
    {
      target: MESSAGE_BOX,
      title: "Have omp ask you",
      text: "Type <b>Ask me two quick questions with your ask tool, one with several answers</b> and send it. omp's questions show above the message box.",
      action: { kind: "appears", selector: QUESTIONS },
    },
    {
      target: QUESTIONS,
      title: "A tab for each question",
      text: "Pick an answer, or <b>Other…</b> to type your own; <b>Next</b> moves on (<b>Skip</b> while it has no answer), and <b>Review</b> shows every answer before <b>Submit</b>. <b>Note</b> adds a note the agent gets with your answer.",
      action: next,
    },
    {
      target: QUESTIONS,
      title: "Hide them for now",
      text: "Click <b>Hide</b>, or press {askHide}: the questions fold into one line above the message box, and the chat reads and scrolls freely.",
      action: { kind: "appears", selector: QUESTIONS_HIDDEN },
    },
    {
      target: QUESTIONS_HIDDEN,
      title: "Back to them",
      text: "Click <b>Show</b>: they come back as you left them. Answer them and press <b>Submit</b>; <b>Skip all</b> here, or Esc, closes them unanswered.",
      action: { kind: "appears", selector: QUESTIONS },
    },
  ],
};

const CHAT_LIST_EDGE = part("chat-list-edge");
const CHAT_LIST_HIDE = part("chat-list-hide");
const CHAT_LIST_SHOW = part("chat-list-show");

const CHAT_LIST_TOUR: Tour = {
  id: "chat-list-2026-11-03",
  title: "A chat list your size",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: CHAT_LIST_EDGE,
      title: "Make it wider or narrower",
      text: "Drag the chat list's right edge; with the keyboard on it, the arrow keys move it too. A double click gives the list its own width again.",
      action: next,
    },
    {
      target: CHAT_LIST_HIDE,
      title: "Hide it",
      text: "Click this, or press {chatList}: the list goes, and your chats get the whole window.",
      action: { kind: "appears", selector: CHAT_LIST_SHOW },
    },
    {
      target: CHAT_LIST_SHOW,
      title: "Bring it back",
      text: "Click this, before the tabs, or press {chatList} again. The width and whether the list is hidden stay in this browser.",
      action: { kind: "appears", selector: CHAT_LIST_HIDE },
    },
  ],
};

const SEND_BUTTON = part("send-button");

const QUEUE_TOUR: Tour = {
  id: "queue-2026-11-04",
  title: "Stop, or queue",
  minutes: 1,
  sandbox: false,
  steps: [
    {
      target: SEND_BUTTON,
      title: "One button, three jobs",
      text: "With nothing running, it sends. While omp works and the box is empty, it is the square Stop.",
      action: next,
    },
    {
      target: SEND_BUTTON,
      title: "Type, and it queues",
      text: "Type while omp works and it becomes Queue, an outlined arrow: omp takes your message in without stopping, at once or after its current step as its Interrupt Mode setting says. Enter does the same.",
      action: next,
    },
    {
      target: SEND_BUTTON,
      title: "On a phone",
      text: "The return key adds a line, so this is how you queue from a phone. To stop omp instead, empty the box and tap the square.",
      action: next,
      phoneOnly: true,
    },
  ],
};

/** #2831: workspaces take a browser's tab keys, and a chat opens as a browser opens a link. */
const BROWSER_KEYS_TOUR: Tour = {
  id: "browser-keys-2026-11-05",
  title: "Workspaces like a browser's tabs",
  minutes: 1,
  sandbox: true,
  steps: [
    {
      target: TABS,
      title: "Workspaces like tabs",
      text: "Workspaces take a browser's tab keys: {newTab} opens one, {closeTab} closes it, {reopenTab} brings back the one closed last, and {nextTab} goes to the next. A browser tab keeps some of these for itself; the keys sheet ({shortcuts}) marks them.",
      action: next,
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "A new chat",
      text: "Press {newChat}. A blank window you're in takes the new chat; this one shows a chat, so it opens in a workspace of its own.",
      action: keys("newChat"),
    },
    {
      target: TABS,
      title: "Back where you were",
      text: "Close it with {closeTab}: you're back in the workspace you opened it from.",
      action: keys("closeTab"),
    },
    {
      target: CHAT_LIST,
      title: "Chats open like links",
      text: "Click a chat to open it in a workspace of its own, or in the blank window you're in. Ctrl+click it (⌘+click on a Mac or an iPad), or click it with the middle button, to open it behind this workspace; Alt+click opens it beside the window you're in.",
      action: next,
    },
    {
      target: WORKSPACE,
      centred: true,
      title: "Thinking and tool cards",
      text: "{foldThinking} now shows or hides omp's thinking, and {foldTools} opens or folds every tool card.",
      action: next,
    },
    {
      target: TABS,
      title: "Done here",
      text: "Close the tour's workspace with {closeTab}.",
      action: keys("closeTab"),
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
    id: "2026-11-12-settings-at-once",
    when: "2026-11-12T03:28:00-06:00",
    summary:
      "Settings move when clicked: a switch, a choice or a menu shows its new value at once, not after the server has written omp's settings file; a write the server cannot save puts it back, and the row says why. Scrolling up a long chat after omp renamed it no longer waits while the server reads the whole chat again.",
    tours: [SETTINGS_AT_ONCE_TOUR],
  },
  {
    id: "2026-11-12-pairing-origin",
    when: "2026-11-12T03:26:00-06:00",
    summary:
      "A pairing request from a panel inside another app (a browser extension, VS Code) says so when you are asked to allow it: which app the panel is inside, and whether that app paired before, since an allowed panel keeps its own key. A one-time code in an address works only in a page of its own, not inside another app's frame.",
    tours: [PAIRING_ORIGIN_TOUR],
  },
  {
    id: "2026-11-12-stats-at-once",
    when: "2026-11-12T03:18:00-06:00",
    summary:
      "omp's statistics answer at once: the dashboard's overview and Statistics, and Usage → This chat, waited each time while omp's statistics page read the chats, up to a minute after the app restarted. The page now keeps reading the chats as they change, starts a little after the app does, and a view waits at most ten seconds for a reading still running, then shows the one before it.",
    tours: [STATS_AT_ONCE_TOUR],
  },
  {
    id: "2026-11-12-device-names",
    when: "2026-11-12T03:11:00-06:00",
    summary:
      'A device you pair is named for what it is and the computer it is on, as "Zen sidebar on my-laptop", "VS Code on my-laptop", "Firefox on my-laptop" or "Home Screen app on my-phone": the computer\'s name as Tailscale knows it, or the system\'s (Linux, iPhone) when the app cannot tell. You can still change it while pairing and in Settings → App → Devices.',
    tours: [DEVICE_NAMES_TOUR],
  },
  {
    id: "2026-11-12-integrations-gone",
    when: "2026-11-12T03:06:00-06:00",
    summary:
      "Settings → App → Integrations is gone: browser extensions (Firefox, Zen, Chrome) and VS Code may always show omp app in a panel, and each panel still pairs once before it is signed in, so pairing is the lock. Other pages that show the app in a frame are named in the server's OMP_APP_FRAME_ANCESTORS, as before.",
    tours: [INTEGRATIONS_GONE_TOUR],
  },
  {
    id: "2026-11-12-long-chats",
    when: "2026-11-12T02:55:00-06:00",
    summary:
      "Lists answer at once after a long chat changes. When omp renamed a long chat (hundreds of megabytes), the server read the whole chat again for each device that asked for the running chats or the chat list, one after another, so the lists took seconds, sometimes over half a minute. Now a long chat is shown as it was at once and read again only once, in the background, and the lists update when that is done.",
    tours: [LONG_CHATS_TOUR],
  },
  {
    id: "2026-11-12-theme-click",
    when: "2026-11-12T00:30:00-06:00",
    summary:
      "Themes change on a click only: pointing at a card in Settings → App, or moving through the palette's theme rows, no longer shows the app in that theme. Each of those previews redrew every open chat, which made the gallery slow to point across.",
    tours: [THEME_CLICK_TOUR],
  },
  {
    id: "2026-11-12-panel-key",
    when: "2026-11-12T00:15:00-06:00",
    summary:
      "The Firefox and Zen sidebar and VS Code's panel sign in with their key in the connection's handshake instead of its address, after a security review: an address can end up in the log of a proxy in between, and the key is what signs a panel in. A panel open during the update keeps working, and signs in the new way the next time it loads. The sidebar's tools now also stay off omp app's pages when the app runs on the same computer and a tab names it differently (localhost instead of 127.0.0.1).",
    tours: [PANEL_KEY_TOUR],
  },
  {
    id: "2026-11-11-zen-safety",
    when: "2026-11-11T21:44:00-06:00",
    summary:
      "The Firefox and Zen sidebar is safer, after a security review: its tools never act on omp app's own pages, so a chat cannot answer its own approval or a pairing request; clicking a field no longer reports what it holds (a password the browser filled stays unread); the tab's address goes with your messages without its query and fragment, where sign-in codes travel; the browser's key goes only to the address it paired with (a new address pairs again); page reading is capped; and Chat about this tab binds the tab you are looking at. It needs this release's omp-app-zen.",
    tours: [ZEN_SAFETY_TOUR],
  },
  {
    id: "2026-11-11-secrets-commands",
    when: "2026-11-11T20:23:00-06:00",
    summary:
      "Secrets go only into commands: a saved secret is filled in for bash and eval, and any other tool call that carries a secret's placeholder (a file write, a page fetch, an MCP tool, a to-do, a question) is refused. A secret saved while a chat runs is filled in by the chat's own omp when the command runs, with no restart, and the chat keeps the command with the placeholder.",
    tours: [SECRETS_COMMANDS_TOUR],
  },
  {
    id: "2026-11-11-questions-enter",
    when: "2026-11-11T19:38:00-06:00",
    summary:
      "In the Questions panel, Enter in an answer you write moves to the next question, then to the button, and never sends the card by itself: before, it sent every question at once, the ones you had not reached with their recommended choice. The button or Ctrl+Enter (⌘+Enter) sends.",
    tours: [ENTER_MOVES_ON_TOUR],
  },
  {
    id: "2026-11-11-secrets-guard",
    when: "2026-11-11T19:22:00-06:00",
    summary:
      "Secrets are guarded more closely, after a review: a saved secret is hidden in everything the AI is sent, notes about finished background commands and its own instructions too; a removed secret stops working at once, also in running chats; a picture in a reply is a link, never fetched by itself; and omp-app secret refuses a pasted value of several lines rather than keeping its first.",
    tours: [SECRETS_GUARD_TOUR],
  },
  {
    id: "2026-11-11-vscode-copy",
    when: "2026-11-11T15:01:00-06:00",
    summary:
      "Copy works in VS Code's panel: a code block's Copy, a message's and the others said Couldn't copy, because VS Code lets only its own pages write the clipboard. The panel now hands the text to VS Code, which puts it in your clipboard. It needs this release's omp-app-vscode.",
    tours: [VSCODE_COPY_TOUR],
  },
  {
    id: "2026-11-11-secrets",
    when: "2026-11-11T12:35:00-06:00",
    summary:
      "Secrets as placeholders: the key button in the message box (Secret in ＋ on a phone) saves a key or password under a name, and puts its placeholder in your message. omp's Hide Secrets shows the AI the placeholder wherever the value would appear, and puts the value in a command that uses it, also in a chat already running. The AI can hand a value back the same way, with a notice to copy it. They are listed in Settings → Providers → Secrets, and omp-app secret lists, adds and removes them in a terminal.",
    tours: [SECRETS_TOUR],
  },
  {
    id: "2026-11-11-swipe-stops",
    when: "2026-11-11T10:52:00-06:00",
    summary:
      "On an iPhone or an iPad, a swipe up a long chat stops at the top of the messages loaded, where the top says Loading earlier messages…; they go in as soon as the scroll rests, with your place kept, and the next swipe goes on. A fling no longer runs far past them into blank space.",
    tours: [SWIPE_STOPS_TOUR],
  },
  {
    id: "2026-11-11-this-chat",
    when: "2026-11-11T08:07:00-06:00",
    summary:
      "Usage → This chat counts the whole chat: what it spent, omp's replies, its tool calls, subagents and tokens over its whole history, its subagents' included, as omp's statistics count them. omp's /session figures follow, plainly, under In its context now: dollars, your messages, omp's replies and tool calls, and tokens in brief with the exact count on hover. They count only what came since omp last compacted the chat.",
    tours: [USAGE_THIS_CHAT_TOUR],
  },
  {
    id: "2026-11-11-file-links",
    when: "2026-11-11T07:32:00-06:00",
    summary:
      "A reply's link to a file of the chat's folder (a report, a CSV, a page it wrote) opens the file in the app's own viewer, beside the chat or over the screen on a phone, read over the app's own connection like the Files panel: nothing of the folder is put on the network for it. A link out of the chat's folder is not opened, and the app says where it pointed.",
    tours: [FILE_LINKS_TOUR],
  },
  {
    id: "2026-11-11-mcp-servers",
    when: "2026-11-11T07:31:00-06:00",
    summary:
      "Settings → Tools → MCP servers edits them: Add a server takes the command that starts it (its arguments, variables and folder) or its address over HTTP or SSE (its headers), or the server's JSON from its page; each server has a switch, Test, Edit and Remove, and is kept for every folder or for this folder alone. Saved keys never reach the page and stay unless typed over; the open chat reads its servers again after each change.",
    tours: [MCP_SERVERS_TOUR],
  },
  {
    id: "2026-11-11-dashboard-overview",
    when: "2026-11-11T07:12:00-06:00",
    summary:
      "The dashboard opens on an overview: spend in the last 24 hours and 7 days, the tokens and failures of the last 24 hours, your chats by what they do, and each window as a half ring coloured as it fills. Chats lists every running chat with its model and its part of its window, and pauses or continues it. Usage draws each window's use over the day and each window split among its chats, and Statistics draws the cost of each hour or day, with each model's share coloured. Statistics and the overview now have omp's statistics page read the chats first, so they count the latest requests.",
    tours: [DASHBOARD_OVERVIEW_TOUR],
  },
  {
    id: "2026-11-11-tasks",
    when: "2026-11-11T07:11:00-06:00",
    summary:
      "The dashboard's Tasks: messages for your chats, or a new chat in a folder, that the server sends in order as each chat is free, after its provider's 5-hour window resets, or at a time, never while the chat works, is paused or a rule holds it. Reorder them, send one now, change or remove it; the sent ones fold below with Open chat. In a chat, Queue for later beside Send (on a phone, in ＋) makes the typed message a task.",
    tours: [TASKS_TOUR],
  },
  {
    id: "2026-11-11-chat-budget",
    when: "2026-11-11T02:46:00-06:00",
    summary:
      "Usage → Its own budget says how much of its provider's 5-hour window a chat used itself, an estimate: the window's growth between the app's readings, split by what each chat spent. Pause this chat after its own part pauses it there, as /pause does, until the window resets; the chat, and the dashboard's queue and activity, say so, also after a reload. Under each provider in Usage, Pause chats and Continue chats act on all its running chats at once, and on the dashboard a rule can pause every chat, or every chat on one provider, also those started later.",
    tours: [USAGE_BUDGET_TOUR],
  },
  {
    id: "2026-11-10-usage-accounts",
    when: "2026-11-10T22:23:00-06:00",
    summary:
      "Usage counts a provider's accounts together, as omp usage does: with two or more, each window's line says how many accounts' worth is used and left and when the fullest one resets, and Each account opens every account's own lines.",
    tours: [USAGE_ACCOUNTS_TOUR],
  },
  {
    id: "2026-11-10-search-engines",
    when: "2026-11-10T22:22:00-06:00",
    summary:
      "Models → Web search shows every search engine omp has, each saying where its key comes from, and the order a web search tries them in. TinyFish, Keenable, Brave, Jina and Firecrawl, which omp has no sign-in for, take their key there, as do Kagi, Tavily, Exa and the other engines with an API key: typed hidden, kept in omp's own store (an auth broker's too), checked with a real search, then replaced or removed; the page never shows a saved key. Keenable without a key searches only when picked, and says so. Test search runs one search with an engine alone, and Search with this first and Add as a fallback set the order. Settings → Providers → Web search keys opens it. The window keeps its rows clear of Close.",
    tours: [SEARCH_ENGINES_TOUR],
  },
  {
    id: "2026-11-10-list-steps-aside",
    when: "2026-11-10T11:45:00-06:00",
    summary:
      "In a narrow window, a side panel no longer squeezes the chat to a strip: the chat list and the panel take turns. While the panel is open, the list steps aside, and it comes back when the panel closes. The button before the tabs or Ctrl+B brings the list back and closes the panel.",
    tours: [LIST_STEPS_ASIDE_TOUR],
  },
  {
    id: "2026-11-10-everything-that-waits",
    when: "2026-11-10T05:35:00-06:00",
    summary:
      "The Questions panel holds all a chat waits on you for. The questions omp asks without waiting come as one card per ask, in the order asked: each with its choices and the recommended one already picked, Other… and a note, Skip on each, and one button at the foot that saves the answers or sends them. A long question shows its start and Read all, which opens the same card wide over the app, the whole screen on a phone. omp's plan in plan mode is a card above the message box now, not a window over the app, and waits in Questions too, with Read all, Approve and Keep planning. omp's questions that stop a chat wait in Questions and on the dashboard as well, answered in any of them. The dashboard's cards are the same. omp's notices show above the cards over the message box, never on them. In a very narrow side bar, such as VS Code's at its narrowest, the controls under the message box scroll sideways and Send stays in view.",
    tours: [EVERYTHING_THAT_WAITS_TOUR],
  },
  {
    id: "2026-11-10-earlier-messages",
    when: "2026-11-10T02:30:00-06:00",
    summary:
      "Scrolling up a long chat reads its earlier messages about two screens before the top, so a quick swipe on the phone finds them there. The top of the chat says Loading earlier messages… while they are read; when a read fails it says so with Try again, and reads them again by itself once the connection is back; and once the first message shows, it says Beginning of the chat, with the day it began.",
    tours: [EARLIER_MESSAGES_TOUR],
  },
  {
    id: "2026-11-10-omp-18-18",
    when: "2026-11-10T01:55:00-06:00",
    summary:
      "Your chats run on omp 18.18.5. omp's questions come as one card above the message box: every question of an ask in the order asked, each under its heading, with round marks, tick boxes, lists, boxes to write in and pictures, omp's checks under a question, and Submit for them all. Nothing the question's author wrote can run in the page. A web search's card names the search engines that failed before one answered. Settings has omp's new settings, among them Prewalk planning model and Prewalk target, Restricted Folders and Per-Call Model; omp's Auto Update is not offered, and omp-app tui never updates the app's omp. Settings → Providers signs in to Devin, also with the Devin command line's login or with Windsurf Enterprise. A chat that another omp held, and that omp moved to a new file, opens as one chat. Answers from OpenAI and Codex models are shorter, as omp's Text Verbosity is low by default now.",
    tours: [OMP_FORM_TOUR],
  },
  {
    id: "2026-11-09-one-row",
    when: "2026-11-09T21:30:00-06:00",
    summary:
      "The row under the message box stays one row in a narrow window: the model's name shortens, the thinking level and Plan show only their icons, and Send stays at the end. Your own answer to a question with choices takes several lines, in the Questions panel and in omp's question dialog: Shift+Enter starts a new line, Enter sends. VS Code's panel sends what you are looking at in a notebook too: the notebook, the cell and the lines you selected in it, or the cell's text; another tab's file, or a preview's name. The line above the message box says it, such as \"Lines 3–7 of cell 4, notes.ipynb\". In VS Code's panel, the arrow and Open in the desktop app work: VS Code opens the full app or the desktop app for the panel, which stays on the chat.",
    tours: [ONE_ROW_TOUR],
  },
  {
    id: "2026-11-09-try-again",
    when: "2026-11-09T20:00:00-06:00",
    summary:
      "A chat that could not open has Try again, and one whose open the connection dropped under opens again by itself once the connection is back; a chat the server no longer has offers New chat. While the connection is lost, the banner has Change server, which opens Settings → App → Server, where a browser now takes another server's address too; the desktop app's page for a server that does not answer has Try again, the servers it opened and a field for another address. A chat in VS Code's panel is an ordinary chat in the app's folder, with omp's own tools, and the VS Code tools for the project open there.",
    tours: [CHANGE_SERVER_TOUR],
  },
  {
    id: "2026-11-09-vscode-right",
    when: "2026-11-09T16:30:00-06:00",
    summary:
      "VS Code's omp app panel sits in VS Code's right-hand side bar, beside its other chat panels, and says what is wrong instead of staying blank: omp app can't be reached, or it doesn't let VS Code show it yet, with Try again. When VS Code's own proxy can't reach the app, the panel names the proxy and Connect without the proxy opens the app. The address other devices open the app at can be any HTTPS address, not only a Tailscale one.",
    tours: [VSCODE_RIGHT_TOUR],
  },
  {
    id: "2026-11-09-picked-ports",
    when: "2026-11-09T15:30:00-06:00",
    summary:
      "Only a service on a port someone picked, such as a dev server's 3000, 5173 or 8080, opens on your paired devices by itself. One on a port the system handed out at random, or a debugger's, is only listed in Ports until you click Share, and adds no line to the chat.",
    tours: [PICKED_PORTS_TOUR],
  },
  {
    id: "2026-11-09-lite-find",
    when: "2026-11-09T12:14:00-06:00",
    summary:
      "In another app's panel, the chat's name lists the folder's recent chats and Find a chat finds any of them by its title; the arrow can open the chat in the desktop app, which now takes omp-app links, and the panel keeps that choice.",
    tours: [LITE_FIND_TOUR],
  },
  {
    id: "2026-11-09-skip",
    when: "2026-11-09T11:22:00-06:00",
    summary:
      "Skip on a question omp asked without waiting means no answer: nothing goes to omp for it, and when only skips are left to go, no message goes at all.",
    tours: [SKIP_TOUR],
  },
  {
    id: "2026-11-09-vscode",
    when: "2026-11-09T11:00:00-06:00",
    summary:
      "omp app in VS Code: its extension shows the chat in VS Code's side bar for the folder open there, on the computer VS Code runs on. The chat reads, searches and changes that folder's files and runs its commands, each change shown as a diff to accept or reject and each command asked first; omp's own tools for the server's files stay out of those chats. A panel's tools are now offered to the model by name.",
    tours: [VSCODE_TOUR],
  },
  {
    id: "2026-11-09-dashboard-extras",
    when: "2026-11-09T03:39:00-06:00",
    summary:
      "The dashboard's button counts the questions waiting and the to-dos due; a chat's menu and the palette add to-dos; the list copies as Markdown; and a saved chat opened from a link shows its messages again.",
    tours: [DASHBOARD_EXTRAS_TOUR],
  },
  {
    id: "2026-11-09-dashboard-parts",
    when: "2026-11-09T02:32:00-06:00",
    summary:
      "The dashboard gains every chat's questions, answered there; one to-do list for you and your chats' agents (their tool shared_todos), with Undo and a copy in SiYuan; and omp's statistics in brief.",
    tours: [DASHBOARD_PARTS_TOUR],
  },
  {
    id: "2026-11-09-dashboard-page",
    when: "2026-11-09T02:01:00-06:00",
    summary:
      "The dashboard is a page of its own: it opens as a workspace in front, as a new chat does, its button brings it back, a reload keeps it, and it can sit beside a chat. A bar at its top goes to each part.",
    tours: [DASHBOARD_PAGE_TOUR],
  },
  {
    id: "2026-11-09-settings-search",
    when: "2026-11-09T01:25:00-06:00",
    summary:
      "Searching Settings works on a phone: the field stays as you type, and the results show under it.",
    tours: [SETTINGS_SEARCH_TOUR],
  },
  {
    id: "2026-11-08-debug-log",
    when: "2026-11-08T16:30:00-06:00",
    summary:
      "Save debug log is back, in the palette and in Settings → App, where a phone finds it too. It downloads what the app did as one file to attach to an issue, the same report omp-app debug-report writes, and the page's own errors are in the app's log again.",
    tours: [DEBUG_LOG_TOUR],
  },
  {
    id: "2026-11-07-answers-across-asks",
    when: "2026-11-07T23:18:00-06:00",
    summary:
      "Answers to separate questions from omp now wait for each other: each one waits in Questions under Ready to send, and Send answers sends the ones you have answered together, as one message, leaving the unanswered questions open. Once every open question has an answer or a skip, they go by themselves.",
    tours: [ANSWERS_ACROSS_ASKS_TOUR],
  },
  {
    id: "2026-11-07-browser-stays",
    when: "2026-11-07T19:56:00-06:00",
    summary:
      "Your own browser, chosen in the Browser panel, now stays until you choose another, and the app's own browser tells websites it is plain Chrome. On a computer, the line above the message box keeps its room, so the chat no longer jumps when a reply starts or ends. A phone back from another app no longer flashes Reconnecting while its connection comes back, and the usage numbers open at once.",
    tours: [BROWSER_STAYS_TOUR],
  },
  {
    id: "2026-11-07-answers-together",
    when: "2026-11-07T18:52:00-06:00",
    summary:
      "Your answers to omp's questions now go together: when omp asks several at once, each answer waits under Ready to send, where you can still change it, and once every question has an answer or a skip they go to omp as one message, not one each. Send now sends the ready ones sooner.",
    tours: [ANSWERS_TOGETHER_TOUR],
  },
  {
    id: "2026-11-07-questions-panel",
    when: "2026-11-07T13:52:00-06:00",
    summary:
      "The side panel's BTW history is now called Questions: the questions omp asks you and your /btw side questions, each on its own tab; its rail button counts the questions waiting for you. /btw now opens it on your side questions, with the answer, also while questions wait for you.",
    tours: [QUESTIONS_PANEL_TOUR],
  },
  {
    id: "2026-11-07-async-questions",
    when: "2026-11-07T13:07:00-06:00",
    summary:
      "omp can ask you questions without waiting for the answers, and keep working: each waits in the Questions panel's Questions for you tab, with omp's context and its choices or a box to write in, and a note if you like; the rail's Questions button counts them. Your answer goes into the chat as your message, between omp's steps; Skip leaves it to omp.",
    tours: [ASYNC_QUESTIONS_TOUR],
  },
  {
    id: "2026-11-07-mention-spaces",
    when: "2026-11-07T02:07:00-06:00",
    summary:
      "The @ menu takes names with spaces: @\"lecture 3 keeps it open up to the closing quote, as in omp's terminal, and words with a space between them (@lecture 3) keep it searching while something matches. The row you pick replaces all you typed, and a file with spaces goes in quoted.",
    tours: [MENTION_SPACES_TOUR],
  },
  {
    id: "2026-11-07-lite-host-name",
    when: "2026-11-07T02:01:00-06:00",
    summary:
      "A side panel in another app can name that app in its address (host): what that app's extensions add to your messages, such as the page you have open there, then goes only with messages sent from its panel, and their line about it shows only there. Messages from the full app carry nothing of it.",
    tours: [LITE_HOST_NAME_TOUR],
  },
  {
    id: "2026-11-06-lite-assistant",
    when: "2026-11-07T00:30:00-06:00",
    summary:
      "In another app's side panel on a computer, the chat keeps a computer's layout at any width: the desktop message box with the model, thinking level, plan mode, attach, / and @, at a computer's sizes (a phone keeps the phone's). Its empty chat greets you as that app's assistant: the app can set the greeting, suggestions you click to send and the box's text (greeting, suggest, placeholder), with no folder or keys; the header is one line in its muted colour, at its text size.",
    tours: [LITE_ASSISTANT_TOUR],
  },
  {
    id: "2026-11-06-lite-host-look",
    when: "2026-11-06T20:32:00-06:00",
    summary:
      "In another app's side panel, the chat takes that app's look: the colours, font and text size it puts in the address (bg, surface, fg, muted, border, accent, font, fontSize), from the first paint. The list of tools omp mounts when a chat starts stays out of it, and a warning or an error from the start shows as one line. The full app is unchanged.",
    tours: [LITE_HOST_LOOK_TOUR],
  },
  {
    id: "2026-11-06-math-drawn",
    when: "2026-11-06T20:21:00-06:00",
    summary:
      "Math in replies is drawn in its own fonts, the same on every device: a boxed result has its frame, a brace spans what it is under, and roots, integrals and fractions are drawn whole instead of in the browser's own math font.",
    tours: [MATH_DRAWN_TOUR],
  },
  {
    id: "2026-11-06-lite-view",
    when: "2026-11-06T19:27:00-06:00",
    summary:
      "The app can sit in another app's side panel, such as your notes app's: its address followed by /lite shows one chat and its message box, with your recent chats in the title's menu, New chat, and a button that opens the chat in the full app. It takes the light or dark look the other app asks for. Browser extensions and VS Code may always show it; any other page must be named on the computer the app runs on.",
    tours: [LITE_VIEW_TOUR],
  },
  {
    id: "2026-11-06-extension-widgets",
    when: "2026-11-06T15:03:00-06:00",
    summary:
      "omp's extensions can show lines next to the message box, as in omp's terminal: above it, or below it when they ask, changed and cleared as the extension goes. A chat you open later shows what its extensions show now.",
    tours: [EXTENSION_WIDGETS_TOUR],
  },
  {
    id: "2026-11-06-phone-no-keys",
    when: "2026-11-06T10:49:00-06:00",
    summary:
      "On a phone, nothing comes up between the message box and your keyboard any more: the row of keys is gone, as your keyboard has / @ and !. ⚡ beside Send puts your quick prompts in the keyboard's place, where Sent brings back what you sent, and ⌨ brings the keyboard back. The empty box names the model and its level on one line, and Send sits centred in the box.",
    tours: [PHONE_QUICK_KEY_TOUR],
  },
  {
    id: "2026-11-06-models-view",
    when: "2026-11-06T06:06:00-06:00",
    summary:
      "omp's Models has its Models view: the Models tab lists Recent, All models and each provider with its count, then the providers not signed in, with how to sign in to each (Sign in, for one with a sign-in page). Kind tabs and the search narrow the list, and a picked model's roles, under the list, give it a role or clear one.",
    tours: [MODELS_VIEW_TOUR],
  },
  {
    id: "2026-11-06-compaction-limit",
    when: "2026-11-06T05:52:00-06:00",
    summary:
      "omp's Models sets a model's compaction limit, as K does in omp's terminal: the picked role's model says when its chats compact and what decides it, and Compaction limit… takes a token base (400k), a fixed point (f400k) or a share of the window (80%), with omp's word on where that compacts as you type; empty goes back to omp's setting. A limit that opens the model's larger window asks first.",
    tours: [COMPACTION_LIMIT_TOUR],
  },
  {
    id: "2026-11-06-dashboard-activity",
    when: "2026-11-06T05:44:00-06:00",
    summary:
      "The dashboard's Activity lists what the rules did, newest first: each chat they paused, held again or continued, and the ones you continued, skipped or resumed by hand, with the time, the rule and the condition. A held chat in the Queue says whether its prompt cache is likely still warm (paused under 5 minutes ago) or is written again when it continues.",
    tours: [ACTIVITY_TOUR],
  },
  {
    id: "2026-11-06-model-presets",
    when: "2026-11-06T05:34:00-06:00",
    summary:
      "omp's Models keeps presets: Save as… names every role's model and the default thinking level as they are, and picking a preset puts them back and moves the chat to its default model; Delete removes one. New role…, under the roles, names a role of your own, and the first model you give it creates it. They are omp's own presets and roles, so the terminal has them too.",
    tours: [PRESETS_TOUR],
  },
  {
    id: "2026-11-06-dashboard-stats",
    when: "2026-11-06T05:28:00-06:00",
    summary:
      "The dashboard shows omp's own statistics, as /stats shows them (requests, costs, models, tools and errors): Show omp's statistics starts omp's page on the server, and Open omp's statistics opens it here, on a phone too.",
    tours: [STATS_TOUR],
  },
  {
    id: "2026-11-06-role-fallbacks",
    when: "2026-11-06T05:20:00-06:00",
    summary:
      "omp's Models (Alt+M, or Roles and models… in the model menu) sets each role's fallbacks: the models omp tries, in order, when the role's model fails. Add one from the models the role takes, change the order, or remove one; omp keeps them in its settings, so the terminal uses them too.",
    tours: [FALLBACKS_TOUR],
  },
  {
    id: "2026-11-06-dashboard",
    when: "2026-11-06T05:05:00-06:00",
    summary:
      "The dashboard (Ctrl+Shift+D, or the gauge at the foot of the rail on the right; on a phone, beside Settings at the foot of the chat list): your usage windows and their pace; rules that pause the chats you pick while a condition holds (a window at a percent, the pace heading past a line before the reset, hours of the day) and continue them once none does; and the queue of the chats they hold, which continue one at a time, three minutes apart. A chat you resume by hand while it is held now runs on until the condition next starts.",
    tours: [DASHBOARD_TOUR],
  },
  {
    id: "2026-11-06-page-from-chat",
    when: "2026-11-06T04:25:00-06:00",
    summary:
      "An HTML file omp writes in a chat's folder opens as a page from the write's card: Share as a page, then Open in browser shows it on your paired devices, with its styles, scripts and pictures.",
    tours: [PAGE_FROM_CHAT_TOUR],
  },
  {
    id: "2026-11-06-phone-plus",
    when: "2026-11-06T04:21:00-06:00",
    summary:
      "On a phone, ＋ beside the message box holds a photo or file, the quick prompts, Pause while omp works, and this chat's model, thinking level, plan mode and goal. The keys a phone lacks come up with the keyboard, in one line, and go with it, so the chat has the room while you read; the empty box names the model and its level.",
    tours: [PHONE_PLUS_TOUR],
  },
  {
    id: "2026-11-06-sharing",
    when: "2026-11-06T01:15:00-06:00",
    summary:
      "Ports lists the services your chats started, and the shared ones, first; every other port on the machine folds away under Other services on this machine. A share whose service stopped says so, in Ports and in the chat's line, instead of offering a link that goes nowhere, and a page in Files offers Share as a page again. With the next server update a chat's service is shared once it has run for 5 seconds (no rows that come and go), omp's browser relay is never shared, and /stats is shared by itself.",
    tours: [SHARING_TOUR],
  },
  {
    id: "2026-11-06-roles-menu",
    when: "2026-11-06T01:00:00-06:00",
    summary:
      "omp's roles are in the model menu: the roles Ctrl+P switches between are listed at its top, each with its model and the thinking level it names, and a pick switches the chat to that role. A model a role uses carries the role's name in the list. Roles and models…, at the menu's foot and in Settings → Model, opens omp's model panel at the chat's role, where every role's model is set.",
    tours: [ROLES_MENU_TOUR],
  },
  {
    id: "2026-11-06-phone-top",
    when: "2026-11-06T00:38:00-06:00",
    summary:
      "On a phone, omp's to-do list and the chat's agents moved from the row above the message box into the top bar: the button where ⓘ was shows how far the list got and how many agents are running, and a tap opens them. The chat starts right under the status bar, and the empty bands above and below it are gone. The chat list starts a little lower, below the band iOS blurs under the status bar of the Home Screen app, so its top stays sharp.",
    tours: [PHONE_TOP_TOUR],
  },
  {
    id: "2026-11-06-thinking-menu",
    when: "2026-11-06T00:20:00-06:00",
    summary:
      "The thinking level in the message box is a menu now: click or tap it to see every level the model offers and pick one, instead of stepping through them. Shift+Tab still steps to the next.",
    tours: [THINKING_MENU_TOUR],
  },
  {
    id: "2026-11-05-browser-keys",
    when: "2026-11-05T18:24:00-06:00",
    summary:
      "Workspaces work like a browser's tabs: Ctrl+T opens one, Ctrl+W closes it, Ctrl+Shift+T brings back the one closed last, Ctrl+PgDn and Ctrl+PgUp move between them, and in the app's own window Ctrl+1 to Ctrl+9 go to one. Ctrl+O starts a new chat. A chat from the list opens in a workspace of its own, or in the blank window you're in; Ctrl+click opens it behind, Alt+click beside. Closing a workspace's only window closes the workspace. Show thinking and open tool cards moved to Alt+T and Alt+O.",
    tours: [BROWSER_KEYS_TOUR],
  },
  {
    id: "2026-11-04-attach-files",
    when: "2026-11-04T23:58:00-06:00",
    summary:
      "The paperclip in the message box, on a computer and on a phone, attaches any file: pictures go to the model with your message, and every other file is uploaded to the chat's own folder, where omp reads it and moves it where you ask. You can also drop or paste files on the box, and a file in a sent message downloads with a click.",
    tours: [ATTACH_FILES_TOUR],
  },
  {
    id: "2026-11-04-queue",
    when: "2026-11-04T02:45:00-06:00",
    summary:
      "While omp works, the button beside the message box follows what you do: with the box empty it is the square Stop, and once you type it becomes Queue, an outlined arrow that hands omp your message without stopping it, as Enter does. On a phone that is how you queue. The working line's time also keeps its room beside a long plan.",
    tours: [QUEUE_TOUR],
  },
  {
    id: "2026-11-03-chat-list",
    when: "2026-11-03T22:30:00-06:00",
    summary:
      "The chat list resizes and hides: drag its right edge, or hide it with the button at its top or Ctrl+B, and your chats get the whole window; a button before the tabs brings it back.",
    tours: [CHAT_LIST_TOUR],
  },
  {
    id: "2026-11-03-questions",
    when: "2026-11-03T19:30:00-06:00",
    summary:
      "omp's questions come one at a time, as omp's own question dialog asks them: a tab for each, Next and Review, Other… to type your own, a note on an answer, and Hide to fold them into one line until you are ready. They take at most about half the chat, so the conversation stays in view.",
    tours: [QUESTIONS_TOUR],
  },
  {
    id: "2026-11-03-browser",
    when: "2026-11-03T12:18:00-06:00",
    summary:
      "A Browser panel chooses the browser chats use: a Chrome on the app's computer, shown live in the panel, where you click and type and chats drive the same tabs; or your own Edge on your computer, through omp's relay, for 30 minutes at a time.",
    tours: [BROWSER_TOUR],
  },
  {
    id: "2026-11-02-running",
    when: "2026-11-02T22:10:00-06:00",
    summary:
      "Chats that run in other folders are listed at the top of the chat list, with their folder's name and their mark: open one from there in a window, or stop it.",
    tours: [RUNNING_TOUR],
  },
  {
    id: "2026-11-02-ports",
    when: "2026-11-02T20:47:00-06:00",
    summary:
      "A Ports panel lists the services running on the app's computer: share one and open it in the browser on your paired devices. A service a chat starts is shared by itself, and an HTML file in Files opens as a page.",
    tours: [PORTS_TOUR],
  },
  {
    id: "2026-11-02-workspaces",
    when: "2026-11-02T19:56:00-06:00",
    summary:
      "New workspace, at the top left, opens a workspace: a tab on top that starts as one blank window with New chat. A chat dragged onto a blank window fills it, the split keys make blank windows, and a new chat never takes another's place.",
    tours: [WORKSPACES_TOUR],
  },
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
