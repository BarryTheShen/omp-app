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
      text: "Each service is listed with its port. <b>Share</b> one, then <b>Open</b> takes you to it in your browser; it opens only on devices paired with the app. A service a chat starts is shared by itself, and the chat shows a line with <b>Open</b>.",
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
      text: "Chrome, Edge or another Chromium browser with omp's relay extension: your computer runs the line shown here to reach the app's computer, and once the browser connects, its tabs are listed here. While it is on, anything on the app's computer can drive it, so put the extension in a profile of its own; chosen here, it turns itself off after 30 minutes, and <b>30 minutes more</b> keeps it.",
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
