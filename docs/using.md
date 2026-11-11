# Using the app

This page goes through the app part by part: what each part is, how to open it, and what it does. Names in bold or quotes are the labels the app shows. Keys are written as they are on a Linux or Windows keyboard; on an iPad's keyboard or a Mac, ⌘ does what Ctrl does, and the app lists its keys with ⌘. Every key is in [the table of keys](#the-palette-and-the-keys).

## The chat list and workspaces

### The chat list

The list is the column at the left. omp works in a folder, and the list shows that folder's chats, newest first.

- **The folder** is the button at the top. It lists the folders that have chats ("Folders with chats"), and **Open a folder…** takes any path. The app remembers the folder you pick, and New chat starts a chat there. `omp-app <folder>` opens the app on a folder from a terminal.
- **New workspace** opens a workspace (see below). **Search** narrows the list by title.
- **The sections:** "Running in other folders" lists chats that keep running in a folder you left, each with its folder's name and its mark; "Needs you" lists chats waiting for an approval or an answer; "Pinned" holds the chats you pinned; "Chats" holds the rest. A chat's mark says that it is working, waiting for you or paused (a pause mark), and a chat that continues by itself after a usage limit has a clock.
- **A chat's menu** (the ⋯ button, labelled "More", or a touch-and-hold on a phone) has Pin or Unpin, Rename, Stop running (for a chat that runs), **Add to the to-do list** (an item named after the chat, linked to it, on the dashboard's list) and Delete…, which asks "Delete this chat?" first. Stopping a running chat ends its omp; the chat stays in its folder's list, and opening it starts it again.
- **To size or hide the list,** drag its right edge (the arrow keys move it when it has the focus, and a double click gives it its own width again), or hide it with the button at its top, "Hide the chat list", or Ctrl+B. A button before the tabs brings it back. The width and whether it is hidden stay in this browser.
- **The foot of the list** shows the connection ("Connected", "Reconnecting…" or "Disconnected"; a click reconnects at once), the theme switch, the **What's new** button, the inbox bell, and the **Settings** gear.

**The inbox** is the bell at the foot of the list, also "Inbox" in the palette. It gathers chats that wait for you, and turns that ended while you were in another window or workspace, and a number counts them. A row takes you to its chat, and looking at a chat clears what it finished with. **Clear** empties the finished rows; a chat that waits for your answer stays until you answer it.

### Workspaces, windows and tabs

A **workspace** is a tab at the top, made of **windows**. It starts as one blank window that holds only **New chat**.

- **New workspace** (the button in the list, or Ctrl+T) adds one. The tabs are named after their first chat; double-click one to rename it (or press Ctrl+Shift+Alt+T), drag it to move it, and close it with Ctrl+W. Ctrl+Shift+T brings back the workspace you closed last. Closing a window or a workspace leaves its chats running, in the list.
- **To open a chat,** click it in the list: it opens in a workspace of its own, or in the blank window you are in. Ctrl+click it (⌘+click on a Mac or an iPad) or click it with the middle button to open it behind this workspace; Alt+click opens it beside the window you are in. A new chat never takes another chat's place.
- **To split the screen,** press Ctrl+Shift+O (a blank window opens to the right) or Ctrl+Shift+E (below). **To arrange windows by dragging,** drag a chat from the list, or a window by the grip ⠿ at the start of its title, and let go on a window. A label where it will land says what the drop does: a blank window is filled; near a window's edge it splits that window on that side; in its middle a chat from the list takes its place; along the workspace's own edges it makes a column or row the whole length of that side.
- **To move between windows,** press Super+Ctrl and an arrow, or Super+Ctrl+[ and Super+Ctrl+] for the previous and next one. Ctrl+Shift+Enter zooms the window to fill the workspace, and again brings the others back. Ctrl+Shift+W closes a window, and Ctrl+Shift+F8 swaps it with the next.
- **Window mode** works without the Super key. Press Ctrl+Shift+Space: the arrows then go to the window in that direction, Shift with an arrow makes it larger or smaller, `=` shares the space equally and `[` and `]` go to the previous or next window. Esc ends it, as do 3 seconds without a key.
- **The side panel** (below) is a window too: drag the line between it and the chats to size it, or drag its title to move it. Each workspace keeps its own arrangement, also after a reload.
- **In the desktop window,** Ctrl+Shift+N, or "New app window" in the palette, opens another window on the same server, with a workspace of its own; so does "New Window" in the launcher's right-click menu, or `omp-app-desktop --new-window`. Closing a window that is not the last closes it alone, and closing the last one ends the app, not the server. Ctrl+= and Ctrl+- zoom the whole window and Ctrl+0 returns it to 100%.

## A chat

A chat is omp's own session, shown as a transcript with a message box under it. omp's session files are the only chat store (the app keeps none of its own), so a chat started in omp's terminal is in the list too.

- **The transcript** shows your messages, omp's replies, its thinking and its tool calls. Alt+T shows or hides thinking, and Alt+O opens or folds every tool card at once.
- **Links in replies.** A link to a web page opens in a new tab. A link to a file of the chat's folder (a path such as `reports/report.md`, or `file://`) opens the file in the app's own viewer, beside the chat on a computer and over the screen on a phone, read over the app's connection like the Files panel: nothing is put on the network for it. A link out of the chat's folder is not opened, and the app says where it pointed.
- **Copy and Edit.** Pointing at one of your messages shows two buttons under it, Copy ("Copy this message") and Edit ("Edit this message"). Edit rewinds the chat to just before that message and puts its text (and pictures) back in the box; sending it starts a new branch from there, and the old one stays in the session. Edit is offered once omp has saved the message, and while omp is idle. On a phone, a touch-and-hold on your message offers Copy and Edit.
- **When a request fails,** a strip says "The request failed" with what omp said. **Retry** (or Alt+R) sends the turn again and **Switch model** opens the model menu; **Copy error** copies the text, and "Show all of it" unfolds a long error. After a usage limit, the strip says "Continues by itself at" the time after the limit resets, and offers **Continue now** and **Don't continue**.
- **When omp asks.** An approval for a tool appears above the message box with omp's own choices (**Approve**, or **Approve Once** beside broader ones, and **Deny**): Ctrl+Enter approves and Esc denies. Questions omp waits for come one at a time, each on its own tab: pick an answer, or **Other…** to type your own, and add a note, which the agent gets with your answer. **Next** moves on (**Skip** while a question has no answer), **Review** shows every answer, and **Submit** sends them. **Hide** (or Alt+H) folds the questions into one line above the box so you can read the chat, and **Show** brings them back as you left them; **Skip all** or Esc closes them unanswered.

## The message box

Click the box and type; on a computer it says "Message omp" while empty. What you type is kept, also across reloads, and you can type before a chat is ready: it sends once the chat opens.

- **Send and new lines.** Enter sends; Shift+Enter or Alt+Enter starts a new line. Up and Down go through what you sent before. On a phone the return key adds a line and the **Send** button sends.
- **`/` commands.** Typing `/` as the first word opens a menu of omp's commands, narrowed by what you type; take one with Enter or Tab, or a click. The palette lists them too.
- **`@` files.** Type `@` and part of a file name in the chat's folder: the menu lists matches, and the row you pick puts `@path` in the box. A name with spaces goes in quotes (`@"lecture 3`, which stays open up to the closing quote), or write the words with a space between them (`@lecture 3`) and the menu keeps searching while something matches. omp's extensions can add rows of their own after the files.
- **`!` and `$` runs.** A box that starts with `!` runs the rest as a shell command in bash, without the model; one that starts with `$` runs it as Python. A badge, "bash" or "python", shows beside the settings. Both runs are recorded in the chat and, unless doubled, are part of the model's context: with `!!` or `$$` the run stays out of the model's context, and the badge adds "not in context".
- **Pictures and files.** The paperclip, **Attach files** ("Attach files, or drop them on the box"), opens your device's picker, which on an iPhone offers the photo library, the camera and Files. You can also drop files on the box or paste them. Pictures go to the model with your message; any other file is uploaded to the chat's own folder, where omp reads it and moves it where you ask. Each attachment shows as a chip above the text with a **Remove** button. A message sent while files are still uploading waits for them.

### Stop, queue and steer

One button sits beside the box. With nothing running it is **Send**. While omp works and the box is empty it is the square **Stop** (also Esc). Once you type while omp works it becomes **Queue**, an outlined arrow, and the message goes in without stopping omp.

- **Enter steers:** while omp works, Enter hands omp your message at once or after its current step, as omp's Interrupt Mode setting says. **Ctrl+Enter queues a follow-up** instead.
- **Queued messages** show above the box as "Steer" or "Follow-up" with an edit button. **Alt+↑** takes the last queued message back into the box, and Esc stops omp and brings every queued message back, in order, with its pictures.
- On a phone this is how you queue, and to stop omp you empty the box and tap the square.
- **Queue for later**, the clock beside Send once you type (on a phone, a row of **＋**), makes the message a task for this chat instead of sending it: it goes **when this chat is free**, **after its window resets** (its provider's 5-hour window), or **at a time**. Until then it waits on the dashboard's **Tasks**, and the box clears at once.

### Pause a chat

Type `/pause` and send it, or press **Pause**, which sits beside "esc to stop" while omp works. Every agent of the chat (the main one, its subagents and the advisor) holds at its next step; a reply or tool already under way finishes. The line above the box says "Paused" with a clock, and "1 message waits" or "N messages wait" for what you send meanwhile. **Resume** goes on, as does Esc, Enter or Space in the empty box. **Pause all chats** (at the top of the Jobs panel, and in the palette, with **Resume all chats**) does the same for every running chat. A chat that is paused shows a pause mark in the chat list.

## Models, thinking and roles

The settings of the message box sit under the text on a computer. On a phone they are behind **＋** (see [the phone layout](#the-phone-and-tablet-layout)).

- **The model.** Click the model, or press Alt+P, to open the model menu. Type to search ("Find a model"). With two roles or more, the roles that Ctrl+P switches between come first. Under **Favorites** are the models you starred, on every device you use; **Recent** holds the models omp used last, and then each provider's models, newest first. The star beside a model (or Alt+S) stars it; the eye (or Alt+H) hides it, and hidden models wait folded under **Hidden** at the bottom, where search still finds them. **Roles and models…** at the foot opens the Models panel.
- **Thinking.** The thinking chip, which shows the level (such as "high"), opens a menu of every level the chosen model offers; one pick sets it. Shift+Tab steps to the next level instead.
- **Roles.** Ctrl+P switches the chat to the next role's model, as in omp (its roles, such as smol, default and slow), and Ctrl+Shift+P goes back. The roles show above the box for a moment, the one in use filled.
- **Models** (Alt+M, "Models: give each role its model" in the palette, **Roles and models…** in the model menu, or Settings → Model) shows each of omp's roles with its model and thinking level, for this project or everywhere. Choosing a model on the right gives it to the role; **Default** also switches this chat. **Clear role** hands a role back to omp. **Save as…** keeps every role's model and the default thinking level as a preset, and picking a preset puts them back. **New role…** names a role of your own. **Add a fallback…** adds a model omp tries, in order, when the role's model fails. **Compaction limit…** sets when the model's chats compact. A **Models** view lists every model by provider. These are omp's own settings, so omp's terminal uses them too.

The app has no setting for a model's speed. The Usage panel shows the last reply's speed.

## Plan mode

The **Plan** chip, Alt+Shift+P, or "Turn plan mode on" in the palette turns plan mode on where omp offers it: omp plans first and changes nothing until you approve. When omp proposes a plan, a dialog, "Plan ready for review", shows it in full. **Approve** ends plan mode and starts the run on the plan in this chat; **Keep planning** closes the review and leaves plan mode on. The Progress panel also has a "Plan mode" row with **Turn on** and **Turn off**.

## The side panel

The side panel opens beside your chats and shows the parts below for the chat you are in. A rail of buttons at the right edge opens each part, and the same button again puts the panel away. Ctrl+Alt+B shows and hides it, and the palette has "Show the side panel" and "Side panel: <name>" for each part. The panel stays as you leave it.

### Usage

The first button. **This chat** shows how full its context is (its tokens out of the model's window), then **The whole chat**: what the chat spent in dollars, omp's replies, its tool calls, its subagents and its tokens over its whole history, its subagents' included, as omp's statistics count them (read when the section shows, every minute while omp works and after each reply; the first read after the server starts can take a minute). **In its context now** follows: what the messages in its context cost, your messages, omp's replies and the tool calls, and their tokens: new input, read from the cache, written to the cache and output, in brief, with the exact count on hover. These are omp's `/session` figures: when omp compacts a chat, a summary takes the place of its older messages, so they count only what came since, while the whole chat still counts everything. Every reply sends the conversation to the model again, and what it had before comes from the cache, which costs less, so the cache's count grows with every reply. The last reply's speed follows. **Pause at the limit** lets you mark the chat: it then pauses as `/pause` does once its provider's 5-hour window reaches the percent you type (95 unless you change it), and goes on by itself at the reset; only the chats you mark pause. **Its own budget** says how much of its provider's 5-hour window this chat used itself, an estimate (the window's growth between the app's readings, split by what each chat spent); **Pause this chat after its own part** pauses it once its own part reaches the percent you type, until the window resets. **Your accounts** shows your accounts' limits and when they reset, and under each provider **Pause chats** and **Continue chats** pause or continue all its running chats at once.

### Agents and the Agent Hub

**Agents** lists the chat's subagents with their kind, state and what each does now. A click opens the **Agent Hub** on that subagent, as a column beside the chat. Alt+A opens or closes the Hub from the message box, and a button above the box, "N agents running", opens it too. The Hub shows each subagent's live log and numbers, **Kill** while it runs, and a message box to write to it ("Message <name>…") while it runs.

### Progress, goals and the to-do list

**Progress** shows what the chips in the message box show, all at once:

- **Goal.** "Set a goal…" (or "Set a goal for this chat…" in the palette) gives omp an objective and an optional token budget. The goal chip beside the box then shows its state and tokens, and offers **Pause**, **Resume** and **Drop**.
- **Todos.** While omp keeps a to-do list, a pill above the box shows how far it got ("3/7") and the task it works on; a click opens the checklist phase by phase. The panel shows the same list with "Now:" and the count done.
- **Plan mode,** as above.

### Jobs

The commands and subagents omp sends to the background, while they run and for a few minutes after. A click on a command shows its output (its last 64 KiB) and **Cancel job** stops one of this chat's own; a subagent opens in the Agent Hub. At the top are **Pause all chats** and **Resume all**.

### Questions

The Questions panel has two tabs. Its rail button counts the questions that wait for you in the chat you are in.

**Questions for you** holds questions omp asks without waiting, while it keeps working. Each waits as a card with what omp wants you to know, its choices (or a box to write in, and **Other…** to write your own) and **Add a note**. Pick or write an answer; the card's button is **Save answer** while any other question of the chat is still open, whichever ask it came from, **Send answer** on the last open one, and **Send answers** when other answers wait to go with it. **Skip** leaves a question unanswered: nothing goes to omp for it, and a skip alone sends no message.

Your answers go to omp together, as one message from you, between omp's steps: once every open question has an answer or a skip, or when you send them. Until then a saved answer waits under **Ready to send**, where **Change** opens it again, and a line says "N answers ready. They go to omp together once every open question has an answer or a skip." **Send answers** on that line sends the ready answers now; the questions you have not answered stay open. Answered and skipped questions stay below, folded to their answer.

**Side questions** holds your `/btw` questions: `/btw <question>` asks omp about this chat on the side, also while it works. The answer comes here, beside the chat, and stays out of it. **Follow up** asks more, and **Copy answer** copies it. Closing the panel does not stop an answer on its way; the chat says "/btw answer ready · /btw to read it". `/btw` alone opens this tab, also while questions wait.

### Files

The chat folder's files, from any device. A click shows a file below the list: text has **Edit** and **Save**, and a file that changed on disk since you opened it is never overwritten without asking (a merge view opens instead). The buttons **New file**, **New folder** and **Upload** are at the top, and you can drop files on the panel to upload them. A row's menu renames, deletes (with an undo), downloads, and puts the file's name in your chat. A file that git reports changed is marked "Changed in git". **Open as tab** shows a file in a window beside the chats. An HTML file has **Share as a page**: see [Other devices](devices.md#how-do-i-share-a-port-with-my-devices).

### Ports

The services running on the app's computer, and the pages you shared, which you can open on your paired devices. See [Other devices](devices.md#how-do-i-share-a-port-with-my-devices).

### Browser

The browser your chats use. **Chats use** has three choices:

- **omp's hidden one:** a browser omp runs out of sight on the app's computer, signed in to nothing.
- **The one shown here:** a Chrome on the app's computer, shown live in the panel. **Start the browser** starts it. Type an address, click and type in the page, and chats drive the same tabs; sign in to your sites in it once, and the sign-ins are kept. It needs Google Chrome or Chromium on that computer; if there is none, the panel says "No Chrome or Chromium was found on the server's machine." See [Troubleshooting](troubleshooting.md#the-browser-panel-finds-no-chrome).
- **Your own browser:** the browser on your own computer (Chrome, Edge or another Chromium browser) with omp's relay extension. **Start the relay** starts the relay on the app's computer. The panel then shows a command to run on your computer, which carries the extension's connection to the app's computer; keep it running while chats use the browser. Once the browser connects, its tabs are listed. While it is on, anything on the app's computer can drive that browser, so put the extension in a profile of its own. Chosen here, it stays until you choose another browser.

## The dashboard

The dashboard is a page of its own: Ctrl+Shift+D, the gauge at the foot of the rail on the right, or, on a phone, the gauge beside Settings at the foot of the chat list. The gauge counts what waits for you there: every chat's questions with no answer yet, and the to-dos not done that are due today or before. On a computer it opens as a workspace named Dashboard, in front, and comes to the front where it is open; like a chat's window, its tab can be dragged beside a chat or to a window's edge, and a reload keeps it. On a phone it fills the screen. A bar at its top goes to each part:

- **Overview:** what was spent in the last 24 hours and the last 7 days, with the requests; the tokens and the failed requests of the last 24 hours; the chats running, by what they do (working, waiting for you, paused, idle); and each of your accounts' usage windows as a half ring, coloured as it fills (calm, then warning from 75%, then danger from 90%), with when it resets.
- **Chats:** every running chat, what it does, the model it answers with and its part of its window, with **Pause** or **Continue**, and **Open**.
- **Tasks:** messages for your chats, or a new chat in a folder, that the server sends in their order as each chat is free, after its provider's 5-hour window resets, or at a time; never while a chat works, is paused or a rule holds it, and one at a time for a chat. **New task** adds one; the arrows change the order, **Send now** lets one go, and a task can be changed or removed. The sent and failed ones fold below, with **Open chat**.
- **Questions:** the questions every chat's agent asked without waiting, under each chat's name, answered as in the chat's Questions panel: a choice, a written answer, a note, or **Skip**. An answer or a skip waits for its chat's other open questions; then the answers go to the chat as your message, a skip sends nothing, and they leave the list. **Open chat** goes to the chat.
- **To-do list:** one list for you and your chats' agents, kept on the server, beside each chat's own todos.
  - Add an item with the list it goes to ("To do" unless you name another); tick it off; ▶ starts it ("Doing"); edit its title, notes, list and due day; move it up or down; remove it. On a phone, **⋯** beside an item holds these. **To do**, **Done** and **All** narrow what shows, and the search finds words in titles, notes and list names.
  - Every change says who made it: you, a chat by name, or a tick in SiYuan. **Undo** takes back the newest; **All changes** lists the rest, each with its own Undo, while the item is still as that change left it. **Copy as Markdown** copies the list as it shows: a heading for each list, a task for each item.
  - The palette's **Add a to-do** opens the list with the cursor in its field, and **Open the to-do list** brings the list into view; a chat's menu adds the chat itself.
  - Chats' agents have the list as their tool `shared_todos`: they read it, add to it, mark items doing or done, and drop items, which you can bring back; an agent never deletes, and a subagent only reads. An item a chat adds links back to it.
  - **Copy in SiYuan** keeps a copy at the end of a SiYuan page: one list block, rewritten a few seconds after each change; ticking an item there marks it done here within a minute, and other edits there are written over. It needs SiYuan's address, its API token (in SiYuan's Settings, under About) and the page's block id; the token stays on the server and is never shown again.
- **Usage windows:** your accounts' windows as omp reports them, with **Pause chats** and **Continue chats** under each provider. **Over the day** draws each window's use from the server's readings of the last day; **Each chat's part** splits each provider's 5-hour window among the chats that used it (an estimate: each reading's growth goes to the chats by what each spent since the last).
- **Pace:** each window's pace, from the server's readings of the last hour.
- **Rules:** a rule pauses the chats you pick, every chat (also those started later), or every chat on one provider, while a condition holds, and continues them once none does. **New rule** names a rule, says whom it pauses ("The chats it pauses") and sets its conditions: "the 5-hour window is at" a percent, "the weekly window is at" a percent, "the pace would pass" a percent at the 5-hour window's reset, and "the clock is between" two times (the server's time). A chat pauses at its next step; a chat you resume by hand runs on until the condition next starts. **Save rule** keeps it.
- **Queue:** the chats the rules hold, in the order they continue: one at a time, three minutes apart, so a window that resets is not spent at once. **Continue now** lets one go out of its turn; **Skip** leaves it paused for you. A held chat says whether its prompt cache is likely still warm.
- **Activity:** what the rules did, newest first: each chat they paused, held again or continued, and the ones you continued, skipped or resumed by hand, with the time, the rule and the condition.
- **Statistics:** omp's own statistics, as `/stats` shows them, in brief: over the last 24 hours, 7 days or 30 days, the requests, the cost, the tokens, how much was read from the cache, the share that failed and how long a reply takes; the cost of each hour or day as a chart (omp counts its days from midnight UTC, and the chart names them so); and the models that cost the most, each in its colour. Each read first has omp's statistics page read the chats (only what changed since), so the numbers include the latest requests; the first time, it reads every chat and can take a minute. **Show omp's statistics** starts omp's full page on the server (tools, errors and traces), and **Open omp's statistics** opens it.

## Settings

Open the settings with Ctrl+, (Ctrl and a comma), the gear at the foot of the chat list, or "Open the settings" in the palette. The sheet has a search box, then the sections: **App**, which is the app's own, and under "omp" omp's own tabs: Appearance, Model, Interaction, Context, Memory, Files, Shell, Tools, Tasks and Providers. The omp release the settings were read from is named at the foot of the list. On a phone the sheet fills the screen: the sections are rows with ›, each opens a screen of its own with ‹ Settings and **Done**; the search box stays at the top of the first screen, and as you type, what it finds shows under it in the sections' place.

- **App** holds the theme (a switch for the system's, light or dark, and a gallery of themes: point at a card to see the app in it, click to keep it), the **Server** the page is connected to (in the desktop window, the servers it can open; see [Other devices](devices.md#how-do-i-open-another-computers-server-in-the-desktop-window)), **Devices** (see [Other devices](devices.md#how-do-i-manage-the-paired-devices)), **Integrations**, the apps that may show the app in a panel (see [Integrations](integrations.md)), and **Keys**, the list of keys below. On a phone it also has **What's new** and **Quick prompts**.
- **The omp tabs** list omp's own settings, each with its description. A setting you changed from its default has a dot and a **Reset** button, and its tab counts them ("N changed"). A setting that only omp's terminal reads says "Terminal only." One that an environment variable sets says which variable and cannot be edited while it is set.
- **Every folder / This folder** at the top chooses which file a change goes to: omp's settings file for every folder, or the folder's own `.omp`. See [Configuration](configuration.md#which-omp-settings-does-the-app-read-or-change).
- **Providers** has the sign-in: open a chat first, since omp signs in inside a chat. Choose a provider under "Sign in to a provider" and press **Sign in**. The provider's page shows with **Open** and **Copy link**, so you can finish on another device, and the page's code or address goes in the box in Settings or in the chat; **Cancel sign-in** stops it. A provider can have several accounts: add another, or sign one out.
- **Tools → MCP servers** lists every MCP server in your MCP file (for every folder) and in the open folder's, each with how omp reaches it, where it is kept and, with a chat open, whether it connects. Each has a switch to turn it off and on, **Test** (connects and counts its tools), **Edit** and **Remove**. **Add a server** opens a form: a name, every folder or this folder only, then either the command that starts it (its arguments one a line, its environment variables, the folder it runs in) or its address over HTTP or SSE (with its headers), and a timeout. Its **JSON** tab takes a server's JSON as MCP pages publish it (`{"mcpServers": {...}}`, VS Code's `{"servers": {...}}`, or one server's object) and fills the form. Saved variable and header values never reach the page: an edit shows them as "Saved", and they stay unless you type a new value. Changes go into omp's own files, and the open chat reads its servers again. Servers omp found in another app's settings can only be turned off or on. **Sign in again**, beside one reached over the network, opens its sign-in page on the device you are using; after you sign in, paste the address your browser ends on into the box that appears, then **Finish sign-in**.

## The palette and the keys

**The palette** opens with Ctrl+K, and says "Search commands, files, chats and models". Tabs narrow it to **All**, **Commands**, **Files**, **Chats** or **Models**. It holds the app's commands (New chat, the window and workspace keys, "Theme: <name>" for every theme and "Theme: match the system", "Show the keys", "What's new", plan mode, pause and resume, goals, "Models: give each role its model", "Pause all chats" and "Resume all chats", the settings, the dashboard, "Add a to-do" and "Open the to-do list", "Inbox", "Side panel: <name>" for each part, and "Tour: <name>" for each tour), omp's commands as `/name`, the chat folder's files, your chats, and the models. A file or one of omp's commands goes into the focused chat's message box. In the desktop window it also has "New app window", "Connect to another server…", "Use this computer's server" and "Open the server on <computer>". Esc closes it.

**The keys** are listed in a sheet, "Keys", that Ctrl+/ opens, and under Settings → App. In a browser tab, the keys the browser keeps for its own tabs are shown dimmed with a star: they reach the app in the desktop window, in an app installed from Chrome or Edge, in a Home Screen app, and in full screen. Ctrl+1 to Ctrl+9 exist only in such an app window.

| Windows | Keys |
|---|---|
| Split right into a blank window | Ctrl+Shift+O |
| Split down into a blank window | Ctrl+Shift+E |
| Zoom the window, or back | Ctrl+Shift+Enter |
| Go to the window in that direction | Super+Ctrl+← ↑ ↓ → |
| Go to the previous or next window | Super+Ctrl+[ and Super+Ctrl+] |
| Make the window narrower, wider, taller or shorter | Super+Ctrl+Shift+← ↑ ↓ → |
| Share the space equally | Super+Ctrl+= |
| Window mode, without Super: arrows go, Shift+arrows resize, = shares, [ ] cycle, Esc ends | Ctrl+Shift+Space |
| Swap with the next window | Ctrl+Shift+F8 |
| Close the window | Ctrl+Shift+W |

| Workspaces | Keys |
|---|---|
| New workspace | Ctrl+T |
| New chat | Ctrl+O |
| Close the workspace | Ctrl+W, Ctrl+Shift+Q |
| Reopen the workspace closed last | Ctrl+Shift+T |
| Next workspace | Ctrl+Tab, Ctrl+PgDn, Ctrl+Shift+→ |
| Previous workspace | Ctrl+Shift+Tab, Ctrl+PgUp, Ctrl+Shift+← |
| Go to workspace 1 to 8; 9: the last one (app windows only) | Ctrl+1 to Ctrl+9 |
| Rename the workspace | Ctrl+Shift+Alt+T |
| Move the workspace right or left | Ctrl+Shift+. and Ctrl+Shift+, |

| Message box | Keys |
|---|---|
| Send (while omp works: steer) | Enter |
| New line | Shift+Enter, Alt+Enter |
| Queue a follow-up; approve when an approval waits | Ctrl+Enter |
| Stop omp; deny when an approval waits | Esc |
| Go through what was sent | ↑ and ↓ |
| Take the last queued message back | Alt+↑ |
| Retry the failed turn | Alt+R |
| Plan mode on or off | Alt+Shift+P |
| Next thinking level | Shift+Tab |
| Choose the model | Alt+P |
| In the model menu: star or unstar the highlighted model | Alt+S |
| In the model menu: hide or show the highlighted model | Alt+H |
| Hide or show the questions omp asks | Alt+H |
| Next role's model (smol, default, slow) | Ctrl+P |
| Previous role's model | Ctrl+Shift+P |
| Models: give each role its model | Alt+M |

| Transcript | Keys |
|---|---|
| Open or fold every tool card | Alt+O |
| Show or hide thinking | Alt+T |
| Open or close the Agent Hub | Alt+A |

| App | Keys |
|---|---|
| Open the palette | Ctrl+K |
| Show the keys | Ctrl+/ |
| Open the settings | Ctrl+, |
| Open the dashboard | Ctrl+Shift+D |
| Show or hide the side panel | Ctrl+Alt+B |
| Show or hide the chat list | Ctrl+B |
| New app window (desktop window only) | Ctrl+Shift+N |
| Zoom the app in (desktop window only) | Ctrl+=, Ctrl+Shift+=, Ctrl+Add (the numpad's plus) |
| Zoom the app out (desktop window only) | Ctrl+-, Ctrl+Subtract (the numpad's minus) |
| The app at 100% (desktop window only) | Ctrl+0 |

## Tours and What's new

Tours are click-through lessons that point at the real parts of the app. Most open a new workspace with a new chat first, so nothing you try touches your chats; close that workspace at the end with Ctrl+W. Each takes a minute or two, and a step moves on when you do what it asks, or with **Next**.

- **The palette** lists every tour as "Tour: <name>" with its length.
- **What's new** lists every update of the app, newest first, with the tours each brought: open it with the sparkles button at the foot of the chat list, "What's new" in the palette, or, on a phone, Settings → App → What's new. A tour you took says **Taken**, and **Take the tour** starts any of them again.
- **After an update,** a card at the foot of the chat list names the new tours: **Take the tours** shows them one after another, **Later** puts the card away and **All updates** opens the list. On a first visit it offers the basics only.

## The phone and tablet layout

Below 640 pixels wide the app uses the phone's layout, with one chat at a time; a touch screen wider than that is a tablet, where the chat list, the message box, the windows' title bars, the side panels and Settings have controls a finger's size, and a window's divider can be dragged from close to its line. See [Other devices](devices.md#how-do-i-put-the-app-on-an-iphone-or-ipad-home-screen) for adding the app to an iPhone or iPad Home Screen.

- **The top bar** has **Chats**, which opens the list, and a pencil that starts a new chat. The app opens on a new chat. In the list, touch and hold a chat for its menu (Pin, Rename, Stop running, Add to the to-do list, Delete…), or swipe a row left for **Pin** and **Delete**. New chat, the inbox, the dashboard and Settings are at the foot of the list.
- **The chat's details** (usage, agents, progress, jobs and side questions) open from ⓘ in the top bar, as a screen of their own with a tab for each and **‹ Chat** to go back. While omp keeps a to-do list or the chat has agents, that button shows how far the list got and how many agents run instead of ⓘ. An agent picked under Agents or Jobs opens the Agent Hub on it, back in the chat.
- **The message box** has **＋** beside it, which opens a sheet: **Photo or file**, **Quick prompts**, **Queue for later** once words are typed, **Pause** or **Resume**, and a group, "This chat", with the model, the thinking level, plan mode and the goal. The empty box names the model and its level. **⚡** beside Send puts your quick prompts in the keyboard's place: a tap sends one as it is, a touch-and-hold puts it in the box to change first, and **Sent** lists what you sent in this chat. **⌨** brings the keyboard back. Quick prompts are edited in Settings → App → Quick prompts.
- **Menus** come up from the foot of the screen with rows a thumb's size, and a tap above one closes it. A touch-and-hold on your own message offers Copy and Edit.
- **A long chat** reads its earlier messages as you scroll up. On an iPhone or an iPad a swipe stops at the top of what is loaded, where the top says **Loading earlier messages…**; they go in as soon as the scroll rests, with your place kept, and the next swipe goes on.
- **Settings and the dashboard** fill the screen, as described above.

## omp in the terminal, on the same chats

`omp-app tui [folder]` opens omp's own terminal app in that folder (default: the current one), on the app's chats, so a chat started in either one goes on in the other. It runs in a tmux session for the folder, which keeps running when you leave it (Ctrl+B, then D) or lose an SSH connection; `omp-app tui` in that folder again goes back to it. It needs tmux (`sudo apt install tmux`). omp's own options go after `--`:

```bash
omp-app tui                                     # omp in this folder: /resume lists its chats, the app's among them
omp-app tui ~/work/site -- --resume <chat id>   # that chat, in that folder
omp-app tui -- --continue                       # the folder's newest chat
```

One of them writes a chat at a time (omp's own rule). While the app has a chat open, omp in the terminal works on a copy, which both then list as a chat of its own. While omp in the terminal has a chat open, the app does not open it and says so. Quit omp (`/exit`) to hand the chat back. If the app's chats run in hosts that outlive the server (see [Configuration](configuration.md#environment-variables)), `omp-app tui` first takes them back and says "Taking a chat back from the app…". A few of omp's commands work only in its terminal, such as repeating a prompt with a loop.

## Saving the debug log

The app keeps a log of what it does, the page's errors included. **Save debug log**, in the palette or in Settings → App → Debug log (on a phone too), downloads it as one file you can attach to an issue; `omp-app debug-report` writes the same file from a terminal. See [Troubleshooting](troubleshooting.md#how-do-i-save-the-debug-log).
