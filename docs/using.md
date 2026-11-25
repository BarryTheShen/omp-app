# Using the app

This page goes through the app part by part: what each part is, how to open it, and what it does. Names in bold or quotes are the labels the app shows. Keys are written as they are on a Linux or Windows keyboard; on an iPad's keyboard or a Mac, ⌘ does what Ctrl does, and the app lists its keys with ⌘. Every key is in [the table of keys](#the-palette-and-the-keys).

## Set up omp-app

**Set up omp-app** asks a few questions about how you will use omp (what for, where, whether you watch a chat work, notifications, light or dark, the style, tool calls, idle workspaces, when omp should ask before acting, usage limits), then shows **Your setup**: every setting that would change, as *now → after*. Nothing changes before **Apply**, and you can untick any line to keep it as it is; a value you set yourself starts unticked. Every question has **Skip**, which changes nothing. Afterwards it offers the next steps it cannot take for you: turning notifications on here (a test one follows), on your other devices, and signing in to a model provider.

It is offered on the first launch on a computer (on the "New: guided tours" card), and is always in Settings → App → Set up and in the palette. **Undo setup**, beside it, puts back every setting the last setup changed: omp's own settings to the value you had (or omp's default), and this browser's to what they were. omp's settings go to every folder's settings file; light or dark, the style, tool calls and idle workspaces are kept in the browser the setup ran in.

## The chat list and workspaces

### The chat list

The list is the column at the left. omp works in a folder, and the list shows that folder's chats, newest first.

- **The folder** is the button at the top. It lists the folders that have chats ("Folders with chats"), and **Open a folder…** takes any path. The app remembers the folder you pick, and New chat starts a chat there. `omp-app <folder>` opens the app on a folder from a terminal.
- **Workspaces** head the list on a computer (see below), one row each, the one shown marked, with **＋** for a new one. **Search** narrows the list by title.
- **The sections:** "Workspaces"; "Running in other folders" lists chats that keep running in a folder you left, each with its folder's name and its mark; "Needs you" lists chats waiting for an approval or an answer; "Pinned" holds the chats you pinned; "Chats" holds the rest. Click a section's name to fold it away (Workspaces, Needs you, Pinned and Chats); the list keeps it folded in this browser, and a search shows what it finds in every section. A chat's mark says that it is working, waiting for you or paused (a pause mark), and a chat that continues by itself after a usage limit has a clock. A new chat is in the list as soon as its first reply starts, named by your first message.
- **A chat's menu** (the ⋯ button, labelled "More", or a touch-and-hold on a phone) has Pin or Unpin, Rename, Stop running (for a chat that runs), **Add to the to-do list** (an item named after the chat, linked to it, on the dashboard's list) and Delete…, which asks "Delete this chat?" first. Stopping a running chat ends its omp; the chat stays in its folder's list, and opening it starts it again.
- **The list's scroll bar** is a thin one of its own beside the rows, so it never covers a row's ⋯ (the desktop window drew its own over them).
- **To size or hide the list,** drag its right edge (the arrow keys move it when it has the focus, and a double click gives it its own width again), or hide it with the button at its top, "Hide the chat list", or Ctrl+B. A button before the tabs brings it back. The width and whether it is hidden stay in this browser.
- **The foot of the list** shows the connection ("Connected", "Reconnecting…" or "Disconnected"; a click reconnects at once), the theme switch, the **What's new** button, the inbox bell, and the **Settings** gear. Back from an outage (offline, asleep), the app reads the chat list, pins, running chats and the dashboard's counts again, so what changed meanwhile, such as a chat another device started, shows.

**The inbox** is the bell at the foot of the list, also "Inbox" in the palette. It gathers chats that wait for you, and turns that ended while you were in another window or workspace, and a number counts them. A row takes you to its chat, and looking at a chat clears what it finished with. **Clear** empties the finished rows; a chat that waits for your answer stays until you answer it.

### Workspaces, windows and tabs

A **workspace** is a row at the top of the chat list (as a browser's spaces in Zen's sidebar), made of **windows**. While the list is hidden, or in a short window (700 pixels tall or less, such as a phone on its side), the workspaces are tabs on top instead, so the list keeps its room for chats. It starts as one blank window that holds only **New chat**.

- **＋** beside **Workspaces** (or Ctrl+T) adds one. They are named after their first chat; double-click one to rename it (or press Ctrl+Shift+Alt+T), drag it to move it, and close it with its **×**, a middle click or Ctrl+W. Ctrl+Shift+T brings back the workspace you closed last. Closing a window or a workspace leaves its chats running, in the list.
- **To open a chat,** click it in the list: it opens in a workspace of its own, or in the blank window you are in. Ctrl+click it (⌘+click on a Mac or an iPad) or click it with the middle button to open it behind this workspace; Alt+click opens it beside the window you are in. A new chat never takes another chat's place.
- **Previews.** A chat clicked open into a workspace of its own opens as a *preview*: its name is in italics, and the next chat you open that way takes its place, so looking through chats does not leave a workspace for each. It stays once you type in it, rename it, pin it or give it a second window. Ctrl+click, a middle click, Alt+click and new chats open as before, not as previews.
- **Idle workspaces close by themselves.** A workspace you have not had in front for 12 hours closes, as with its **×**: its chat stays in the list, and Ctrl+Shift+T brings it back. Never closed this way: the one in front, one whose chat works or waits for you, and a **pinned** one: point at a workspace's row and press its pin (pinned, the pin stays, filled). Change the time, or choose Never, in Settings → App → Workspaces → "Close workspaces not used for" (1 hour, 12 hours, 1 day, 1 week or Never), kept in this browser.
- **To split the screen,** press Ctrl+Shift+O (a blank window opens to the right) or Ctrl+Shift+E (below). **To arrange windows by dragging,** drag a chat from the list, or a window by the grip ⠿ at the start of its title, and let go on a window. A label where it will land says what the drop does: a blank window is filled; near a window's edge it splits that window on that side; in its middle a chat from the list takes its place; along the workspace's own edges it makes a column or row the whole length of that side.
- **To move between windows,** press Super+Ctrl and an arrow, or Super+Ctrl+[ and Super+Ctrl+] for the previous and next one. Ctrl+Shift+Enter zooms the window to fill the workspace, and again brings the others back. Ctrl+Shift+W closes a window, and Ctrl+Shift+F8 swaps it with the next.
- **Window mode** works without the Super key. Press Ctrl+Shift+Space: the arrows then go to the window in that direction, Shift with an arrow makes it larger or smaller, `=` shares the space equally and `[` and `]` go to the previous or next window. Esc ends it, as do 3 seconds without a key.
- **The side panel** (below) is a window too: drag the line between it and the chats to size it, or drag its title to move it. Each workspace keeps its own arrangement, also after a reload.
- **In the desktop window,** Ctrl+Shift+N, or "New app window" in the palette, opens another window on the same server, with a workspace of its own; so does "New Window" in the launcher's right-click menu, or `omp-app-desktop --new-window`. Closing a window that is not the last closes it alone, and closing the last one ends the app, not the server. Ctrl+= and Ctrl+- zoom the whole window and Ctrl+0 returns it to 100%.

## A chat

A chat is omp's own session, shown as a transcript with a message box under it. omp's session files are the only chat store (the app keeps none of its own), so a chat started in omp's terminal is in the list too.

- **The transcript** shows your messages, omp's replies, its thinking and its tool calls. Alt+T shows or hides thinking, and Alt+O opens or folds every tool card at once. A chat shown working that hears nothing for 20 seconds asks omp whether its turn still runs; when it has ended (the page missed it, as a side panel did), the page reads the chat again and shows the reply, and logs what it had for diagnosis (a `trace` line tagged `stalled` in the server's log).
- **Tool groups.** Two or more tool calls in a row are one card: how many, by which tools, the one running now and how many failed; a click opens the calls' own cards. A one-line text between calls that ends in a colon ("Checking the queue:") joins the group, its latest one showing as the group's title; longer text, lists and answers stay in view. Settings → App → Look → **Group tool calls** turns grouping off. One sign shows that omp works: while it works on after a group that ends the chat (between steps, or thinking before its next words), the group's head spins as it does while a call runs; **thinking…** shows only where nothing else does, as right after your message.
- **Notices.** What a program puts into a chat (a scheduled message, a watcher's report, an agent-access answer) shows as a notice with its source's heading, never as your message.
- **Links in replies.** A link to a web page opens in a new tab. A link to a file of the chat's folder (a path such as `reports/report.md`, or `file://`) opens the file in the app's own viewer, beside the chat on a computer and over the screen on a phone, read over the app's connection like the Files panel: nothing is put on the network for it. A link out of the chat's folder is not opened, and the app says where it pointed. A picture in a reply shows as a link, "Image: …", that you open the same way: the page never fetches one by itself, since a reply is shown with your secrets filled in and an address could carry one away.
- **Copy and Edit.** Pointing at one of your messages shows two buttons under it, Copy ("Copy this message") and Edit ("Edit this message"). Edit rewinds the chat to just before that message and puts its text (and pictures) back in the box; sending it starts a new branch from there, and the old one stays in the session. Edit is offered once omp has saved the message, and while omp is idle. On a phone, a touch-and-hold on your message offers Copy and Edit.
- **When a request fails,** a strip says "The request failed" with what omp said. **Retry** (or Alt+R) sends the turn again and **Switch model** opens the model menu; **Copy error** copies the text, and "Show all of it" unfolds a long error. After a usage limit, the strip says "Continues by itself at" the time after the limit resets, and offers **Continue now** and **Don't continue**.
- **When omp asks.** An approval for a tool appears above the message box with omp's own choices (**Approve**, or **Approve Once** beside broader ones, and **Deny**): Ctrl+Enter approves and Esc denies. Questions omp waits for come one at a time, each on its own tab: pick an answer, or **Other…** to type your own, and add a note, which the agent gets with your answer. **Next** moves on (**Skip** while a question has no answer), **Review** shows every answer, and **Submit** sends them. **Hide** (or Alt+H) folds the questions into one line above the box so you can read the chat, and **Show** brings them back as you left them; **Skip all** or Esc closes them unanswered.

## The message box

Click the box and type; on a computer it says "Message omp" while empty. What you type is kept, also across reloads, and you can type before a chat is ready: it sends once the chat opens.

- **Send and new lines.** Enter sends; Shift+Enter or Alt+Enter starts a new line. Up and Down go through what you sent before. On a phone, and on a tablet while its on-screen keyboard is up, the return key adds a line and the **Send** button sends; an iPad typing on a hardware keyboard sends on Enter.
- **`/` commands.** Typing `/` as the first word opens a menu of omp's commands, narrowed by what you type; take one with Enter or Tab, or a click. The palette lists them too.
- **`@` files.** Type `@` and part of a file name in the chat's folder: the menu lists matches, and the row you pick puts `@path` in the box. A name with spaces goes in quotes (`@"lecture 3`, which stays open up to the closing quote), or write the words with a space between them (`@lecture 3`) and the menu keeps searching while something matches. omp's extensions can add rows of their own after the files.
- **`!` and `$` runs.** A box that starts with `!` runs the rest as a shell command in bash, without the model; one that starts with `$` runs it as Python. A badge, "bash" or "python", shows beside the settings. Both runs are recorded in the chat and, unless doubled, are part of the model's context: with `!!` or `$$` the run stays out of the model's context, and the badge adds "not in context".
- **Pictures and files.** The paperclip, **Attach files** ("Attach files, or drop them on the box"), opens your device's picker, which on an iPhone offers the photo library, the camera and Files. You can also drop files on the box or paste them. Pictures go to the model with your message; any other file is uploaded to the chat's own folder, where omp reads it and moves it where you ask. Each attachment shows as a chip above the text with a **Remove** button. A message sent while files are still uploading waits for them.
- **Naming a picture.** Each picture you add puts its name at the cursor, as omp's terminal does: `[Image #1, 800x600]` for the first, `[Image #2, …]` for the next, so you can point at it ("crop [Image #2] like [Image #1]"); its chip reads **Image 1**, **Image 2**. The model reads the name where you wrote it. Deleting a picture's name leaves the picture out of the message, and **Remove** on its chip takes its name out too; the pictures left are numbered again from 1 when you send. A message whose text names none of its pictures sends them all. In the chat, your message's pictures sit under it, outside its bubble, each captioned with its number.
- **References are one piece.** A picture's name, a mention the **@** menu put in (a file, or a page an extension offers, such as `@Birthday menu`) and a secret's placeholder show as chips in the box and act as one piece: Backspace or Delete at one takes it whole, the cursor steps over it, a selection that cuts one takes it whole, and typing never lands inside one.
- **Secrets.** The key button, **Add a secret** (on a phone, **Secret** in **＋**; also "Add a secret…" in the palette), takes a name and a value you paste into a hidden field, such as an API key. The value is kept in omp's secrets file on the server, readable by you only, and omp's **Hide Secrets** comes on: the AI is not shown the value, only its placeholder, such as `$$APIKEY_2XUBD7NWOZ1U:L$$`, which goes into your message where the cursor is and shows in the chat as a lock and the name. When the AI uses the placeholder in a command (bash or eval), omp puts the value in just before the command runs (the command's card shows it to you), and wherever the value shows up in what the AI is sent (a command's output, a file it reads, the note about a command that finished in the background) the AI sees the placeholder instead. A secret goes only into commands: any other tool call that carries a placeholder (writing a file, fetching a page, an MCP tool, a to-do, a question to you) is refused, so the AI puts a value where it is needed with a command, which you read in full. The hiding matches the value exactly: a command that changes it (into base64, say) or sends it to a website is not stopped, so use secrets in chats whose commands you trust. A chat that is already running gets a new secret at once, with no restart: the chat's own omp puts it in when the command runs, and the chat keeps the command with the placeholder (what a command prints, and the record of the script omp ran, are kept as they are, in a folder only you can read). The AI can save a value for you the same way, without seeing it (`… | omp-app secret add NAME`): a notice says **Saved a secret** with **Copy**. Your secrets are listed in Settings → Providers → **Secrets**.

### Voice input

With voice input on (Settings → App → **Voice input**, below), the box has a microphone: beside the paperclip on a computer, and on a phone in Send's place while the box is empty (also **Voice input** in **＋**). Alt+V starts it from the box.

- **The recording bar.** Pressing the microphone puts a recording bar in the box's place: a moving level line, the time recorded, and above it the text of what you said so far, which comes in as you pause. **Pause** (⏸, or P) turns the microphone off and stops the clock, keeping the recording: what you said so far is written out meanwhile, and **Resume** (or P again) goes on in the same recording. **Done** (✓, or Enter) puts the whole text into the box after what you typed, ready to edit; **Send** (↑, or Ctrl+Enter) sends it at once; **Cancel** (×, or Esc) ends the recording without inserting it; all three work while paused too. The first time, the browser asks for the microphone.
- **Nothing said is lost.** The recording is cut into parts at your pauses (every 10 to 30 seconds), and each part is saved on the device before it goes to the server, then transcribed by your transcription server while you go on talking. A part the server could not transcribe keeps its audio: the bar shows it with **Retry**, and Done keeps the bar up the first time so you see it (press Done again to use the rest). A reload, a crash or a dropped connection in the middle of a recording keeps what was saved (every 5 seconds); on an iPhone, the system stops a web app's microphone when the phone locks or the app goes to the background, and the bar then says so and offers **Resume**.
- **Recent recordings** (right-click the microphone, or in **＋** on a phone, or in Settings) lists the recordings kept on the server, newest first, with their text: **Insert** puts the text into the box, **Attach audio** attaches the recording's audio to your message (for the AI to listen to, cut or transcribe again), and **Copy**, **Play**, **Retry** and **Delete** do what they say. A recording cut off by a reload shows a notice above the box that opens them.
- **For the AI.** On the server each recording is a folder in the app data folder, `voice/<id>/` ([Configuration](configuration.md#the-app-data-folder)), with `audio.wav` (the whole recording, written once every part is in), `transcript.md` (its text, when it was made and how long it is) and each part as `<n>.wav`.
- **The setting.** Settings → App → **Voice input** holds the transcription servers, tried in order (the next one when the one before fails): each a name, an address ending in `/v1`, its API (**Chat with audio**, as llama.cpp's `llama-server` takes it, or **Transcriptions**, as vLLM and OpenAI take it), a model name and a key, which never goes back to a page once saved. **Test** sends each server a second of silence and shows the time it took. Then the **Language** (**As spoken**, which keeps Chinese and English as you mix them, or Chinese, or English), **Words to recognise** (names and jargon the server should expect, sent with each part), how long recordings are kept (14 days by default), and **Recent recordings**. omp-app comes with no model of its own: [Configuration](configuration.md#how-do-i-run-a-transcription-server-for-voice-input) shows how to run one.

### Stop, queue and steer

One button sits beside the box. With nothing running it is **Send**. While omp works and the box is empty it is the square **Stop** (also Esc). Once you type while omp works it becomes **Queue**, an outlined arrow, and the message goes in without stopping omp.

- **Enter steers:** while omp works, Enter hands omp your message at once or after its current step, as omp's Interrupt Mode setting says. **Ctrl+Enter queues a follow-up** instead.
- **Queued messages** show above the box as "Steer" or "Follow-up", with their pictures small beside the words, and an edit button. **Alt+↑** takes the last queued message back into the box, and Esc stops omp and brings every queued message back, in order, with its pictures. Your answers from the Questions panel wait there too, as "Your answers": their edit button takes them back to the panel (see Questions).
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

**Agents** lists the chat's subagents with their kind, state and what each does now. A click opens the **Agent Hub** on that subagent, as a column beside the chat. Alt+A opens or closes the Hub from the message box, and a button above the box, "N agents running", opens it too. The Hub shows each subagent's live log and numbers, **Kill** while it runs, and a message box to write to it ("Message <name>…") while it runs. A chat you come back to from another chat asks for its subagents' reports again and reads them anew, so their numbers keep moving and an ended one shows as ended, also when no other page watches the chat.

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

Your answers go to omp together, as one message from you, between omp's steps: once every open question has an answer or a skip, or when you send them. Until then a saved answer waits under **Ready to send**, where **Change** opens it again, and a line says "N answers ready. They go to omp together once every open question has an answer or a skip." **Send answers** on that line sends the ready answers now; the questions you have not answered stay open. Answered and skipped questions stay below, folded to their answer. While omp is busy, sent answers wait above the box as **Your answers**; its edit button takes them back before omp reads them: they wait under **Ready to send** again, and go once you change each of them, or when you press **Send answers**. In the chat, your answers ("Your answers from Questions") have **Edit your answers**, as your messages have Edit: the chat goes back to just before them, and they wait under **Ready to send** to be changed and sent again.

**Side questions** holds your `/btw` questions: `/btw <question>` asks omp about this chat on the side, also while it works. The answer comes here, beside the chat, and stays out of it. **Follow up** asks more, and **Copy answer** copies it. Closing the panel does not stop an answer on its way; the chat says "/btw answer ready · /btw to read it". `/btw` alone opens this tab, also while questions wait.

### Files

The chat folder's files, from any device. A click shows a file below the list: text has **Edit** and **Save**, and a file that changed on disk since you opened it is never overwritten without asking (a merge view opens instead). The buttons **New file**, **New folder** and **Upload** are at the top, and you can drop files on the panel to upload them. A row's menu renames, deletes (with an undo), downloads, and puts the file's name in your chat. A file that git reports changed is marked "Changed in git". **Open as tab** shows a file in a window beside the chats. An HTML file has **Share as a page**: see [Other devices](devices.md#how-do-i-share-a-port-with-my-devices).

A PDF (up to 100 MB) is drawn by the app itself, page by page, in every window. Only the parts a page needs are read: the first page of a large PDF shows after a few reads rather than after the whole file came over the connection, and a page further on is read as you scroll near it. The PDF zooms itself: two fingers pinch its pages (not the whole screen, so on a phone **Back** stays on the screen), and the bar at its top has **Zoom out**, the zoom (a click fits the pages to the width again) and **Zoom in**, up to 400%; zoomed pages are drawn again, sharp. One the app can't draw offers **Open** and **Download**.

### Ports

The services running on the app's computer, and the pages you shared, which you can open on your paired devices. See [Other devices](devices.md#how-do-i-share-a-port-with-my-devices).

### Browser

The browser your chats use. **Chats use** has three choices:

- **omp's hidden one:** a browser omp runs out of sight on the app's computer, signed in to nothing.
- **The one shown here:** a Chrome on the app's computer, shown live in the panel. **Start the browser** starts it. Type an address, click and type in the page, and chats drive the same tabs; sign in to your sites in it once, and the sign-ins are kept. It needs Google Chrome or Chromium on that computer; if there is none, the panel says "No Chrome or Chromium was found on the server's machine." See [Troubleshooting](troubleshooting.md#the-browser-panel-finds-no-chrome).
- **Your own browser:** the browser on a computer of yours (Chrome, Edge or another Chromium browser) with omp's relay extension. **Start the relay** starts the relay on the app's computer; it takes the extension only with its token, so no other program there can attach as your browser. Then:
  - **On the app's own computer**, the panel shows the token: paste it into the extension's options (Token) once.
  - **From another computer**, the extension's connection comes over the app's own address. In the desktop window there, **Use this computer's browser** does it (it pairs that computer as a device, "Browser relay on <computer>", and starts again with the app). Elsewhere the panel shows `omp-app relay <this address>` to run on that computer, which pairs once with a code from Settings → App → Devices and runs until stopped.

  Once the browser connects, its tabs are listed. Chats drive its tabs, so put the extension in a profile of its own. Removing the relay's device in Settings → App → Devices ends it. Chosen here, it stays until you choose another browser or press **Stop using your browser**, which goes back to omp's hidden one; either way the desktop window on that computer stops carrying it, and does not start it again with the app.

### Agent access

The app's agents on your other computers: the computers linked to this server, whether access is on, the chats allowed on each, and every command they ran, newest first, each with its chat. In the desktop window on Linux, **This computer** sets up, turns on and off, answers requests, gives a chat access, shares folders and shows the sessions live. See [Agent access](agent-access.md).

## The dashboard

The dashboard is a page of its own: Ctrl+Shift+D, the gauge at the foot of the rail on the right, or, on a phone, the gauge beside Settings at the foot of the chat list. The gauge counts what waits for you there: every chat's questions with no answer yet, and the to-dos not done that are due today or before. On a computer it opens as a workspace named Dashboard, in front, and comes to the front where it is open; like a chat's window, its tab can be dragged beside a chat or to a window's edge, and a reload keeps it. On a phone it fills the screen. A bar at its top goes to each part:

- **Overview:** what was spent in the last 24 hours and the last 7 days, with the requests; the tokens and the failed requests of the last 24 hours; the chats running, by what they do (working, waiting for you, paused, idle); and each of your accounts' usage windows as a half ring, coloured as it fills (calm, then warning from 75%, then danger from 90%), with when it resets.
- **Chats:** every running chat, what it does, the model it answers with and its part of its window, with **Pause** or **Continue**, and **Open**.
- **Tasks:** messages for your chats, or a new chat in a folder, that the server sends in their order as each chat is free, after its provider's 5-hour window resets, or at a time; never while a chat works, is paused or a rule holds it, and one at a time for a chat. **New task** adds one; the arrows change the order, **Send now** lets one go, and a task can be changed or removed. A task that is a program's notice shows its source's heading over its text, and editing changes the text only. The sent and failed ones fold below, with **Open chat**.
- **Questions:** the questions every chat's agent asked without waiting, under each chat's name, answered as in the chat's Questions panel: a choice, a written answer, a note, or **Skip**. An answer or a skip waits for its chat's other open questions; then the answers go to the chat as your message, a skip sends nothing, and they leave the list. **Open chat** goes to the chat.
- **To-do list:** one list for you and your chats' agents, kept on the server, beside each chat's own todos.
  - Add an item with the list it goes to ("To do" unless you name another); tick it off; ▶ starts it ("Doing"); edit its title, notes, list and due day; move it up or down; remove it. On a phone, **⋯** beside an item holds these. **To do**, **Done** and **All** narrow what shows, and the search finds words in titles, notes and list names.
  - Every change says who made it: you, a chat by name, or a tick in SiYuan. **Undo** takes back the newest; **All changes** lists the rest, each with its own Undo, while the item is still as that change left it. **Copy as Markdown** copies the list as it shows: a heading for each list, a task for each item.
  - The palette's **Add a to-do** opens the list with the cursor in its field, and **Open the to-do list** brings the list into view; a chat's menu adds the chat itself.
  - Chats' agents have the list as their tool `shared_todos`: they read it, add to it, mark items doing or done, and drop items, which you can bring back; an agent never deletes, and a subagent only reads. An item a chat adds links back to it.
  - **Copy in SiYuan** keeps a copy at the end of a SiYuan page: one list block, rewritten a few seconds after each change; ticking an item there marks it done here within a minute, and other edits there are written over. It needs SiYuan's address, its API token (in SiYuan's Settings, under About) and the page's block id; the token stays on the server and is never shown again.
- **Usage windows:** your accounts' windows as omp reports them, with **Pause chats** and **Continue chats** under each provider. **Over the day** draws each window's use from the server's readings of the last day; **Each chat's part** splits each provider's 5-hour window among the chats that used it (an estimate: each reading's growth goes to the chats by what each spent since the last).
- **Pace:** each window's pace, from the server's readings of the last hour.
- **Rules:** a rule pauses the chats you pick, every chat (also those started later), or every chat on one provider, while a condition holds, and continues them once none does. **New rule** names a rule, says whom it pauses ("The chats it pauses") and sets its conditions: "the 5-hour window is at" a percent, "the weekly window is at" a percent, "the pace would pass" a percent at the 5-hour window's reset, and "the clock is between" two times (the server's time). A chat pauses at its next step; a chat you resume by hand runs on until the condition next starts. Each chat is judged on the provider of the model it runs: a held chat switched to a model of another provider continues at once when that provider's window is clear, and is held by that one's window when it is not. **Save rule** keeps it.
- **Queue:** the chats the rules hold, in the order they continue: one at a time, three minutes apart, so a window that resets is not spent at once. **Continue now** lets one go out of its turn; **Skip** leaves it paused for you. A held chat says whether its prompt cache is likely still warm.
- **Activity:** what the rules did, newest first: each chat they paused, held again or continued, and the ones you continued, skipped or resumed by hand, with the time, the rule and the condition.
- **Statistics:** omp's own statistics, as `/stats` shows them, in brief: over the last 24 hours, 7 days or 30 days, the requests, the cost, the tokens, how much was read from the cache, the share that failed and how long a reply takes; the cost of each hour or day as a chart (omp counts its days from midnight UTC, and the chart names them so); and the models that cost the most, each in its colour. Each read first has omp's statistics page read the chats (only what changed since), so the numbers include the latest requests; the first time, it reads every chat and can take a minute. **Show omp's statistics** starts omp's full page on the server (tools, errors and traces), and **Open omp's statistics** opens it.

## Settings

Open the settings with Ctrl+, (Ctrl and a comma), the gear at the foot of the chat list, or "Open the settings" in the palette. The sheet has a search box, then the sections: **App**, which is the app's own, and under "omp" omp's own tabs: Appearance, Model, Interaction, Context, Memory, Files, Shell, Tools, Tasks and Providers. The omp release the settings were read from is named at the foot of the list. On a phone the sheet fills the screen: the sections are rows with ›, each opens a screen of its own with ‹ Settings and **Done**; the search box stays at the top of the first screen, and as you type, what it finds shows under it in the sections' place.

- **App**, from the top: **omp-app** (its version, newer releases and updating: [Install](install.md#how-do-i-update-it)); **Look**: the theme (a switch for the system's, light or dark, and a gallery of themes: point at a card to see the app in it, click to keep it), the **Style**, how the app is drawn apart from its colours (Tern, the default, Paper, Console, Blocks, Glass or Roomy, kept in this browser), and **Group tool calls**; **Voice input** ([Voice input](#voice-input)); **Notifications** ([Other devices](devices.md#how-do-i-get-notifications-on-a-device)); the **Server** the page is connected to (in the desktop window, the servers it can open; see [Other devices](devices.md#how-do-i-open-another-computers-server-in-the-desktop-window)); **omp** (its updates); **Search by meaning**; **Devices** (see [Other devices](devices.md#how-do-i-manage-the-paired-devices)); sharing; the debug log; and **Keys**, the list of keys below. On a phone it also has **What's new** and **Quick prompts**. The foot of the settings list names the versions of omp, omp-app and, in the window, the desktop app.
- **Every device / This device**, at the top of **Look**, chooses whose look this device shows: light or dark, the themes, the style, Group tool calls and Close workspaces not used for. On **Every device** (a new device's start) the look is kept on the server, and a change on one such device shows at once on every other device on Every device. On **This device** the device keeps its own look, which the others' changes never touch; going back to Every device sets it aside and shows the shared look, and This device brings it back. The first device to keep a look on the server gives it its own, so nothing on it changes.
- **The omp tabs** list omp's own settings, each with its description. A setting you changed from its default has a dot and a **Reset** button, and its tab counts them ("N changed"). A setting that only omp's terminal reads says "Terminal only." One that an environment variable sets says which variable and cannot be edited while it is set.
- **Every folder / This folder** at the top chooses which file a change goes to: omp's settings file for every folder, or the folder's own `.omp`. See [Configuration](configuration.md#which-omp-settings-does-the-app-read-or-change).
- **Providers** has the sign-in: open a chat first, since omp signs in inside a chat. Choose a provider under "Sign in to a provider" and press **Sign in**. The provider's page shows with **Open** and **Copy link**, so you can finish on another device, and the page's code or address goes in the box in Settings or in the chat; **Cancel sign-in** stops it. A provider can have several accounts: add another, or sign one out.
- **Providers → Secrets** lists the secrets of omp's Hide Secrets by name, each with the placeholder a chat's AI sees in its place and the value's length. **Copy** puts the value in your clipboard, **Show** shows it there (and **Hide** again), **Copy placeholder** copies the placeholder for a message, and **Remove** takes it out of omp's file; a running chat refuses a command that would use it from then on. **Add a secret** saves one and turns Hide Secrets on; Hide Secrets itself is the switch under Privacy, further down the tab. From a terminal, `omp-app secret` lists them, `omp-app secret add NAME` saves what comes in (typed, without showing it, or from a pipe) and `omp-app secret remove NAME` removes one. Nothing here sends a value to the AI: it reaches only the page that copies or shows it.
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
- **The message box** has **＋** beside it, which opens a sheet: **Photo or file**, **Quick prompts**, **Queue for later** once words are typed, **Pause** or **Resume**, and a group, "This chat", with the model, the thinking level, plan mode and the goal. The empty box names the model and its level. Once your text needs a second line it takes the box's whole width, with ＋, ⚡ and Send on a row under it, until the box is empty again; the box grows to six lines and then scrolls. **⚡** beside Send puts your quick prompts in the keyboard's place: a tap sends one as it is, a touch-and-hold puts it in the box to change first, and **Sent** lists what you sent in this chat. **⌨** brings the keyboard back. Quick prompts are edited in Settings → App → Quick prompts.
- **Every style** fills the phone's screen: Glass's floating pane and Console's edge line are a computer's. In every style the box's ＋, ⚡ and Send are a finger's 44 pt with corners that follow the box's, and the empty box keeps the model's name on one line.
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
