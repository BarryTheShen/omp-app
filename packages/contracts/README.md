# @omp-app/contracts

The shared contracts of the omp app: the types, zod schemas and tables that the Bun server and the browser both use. The package ships TypeScript source with no build step; its runtime dependency is `zod` 4, and omp's own packages (`@oh-my-pi/*`, at the version the app pins) are type-only dependencies for omp's objects. The omp floor is the release the app pins, 18.12.6 (`OMP_FLOOR_VERSION`).

## Using it

Add `"@omp-app/contracts": "workspace:*"` to the `dependencies` of the package that needs it, then:

```ts
import { definePort, ompCommandCapability, persistedMessageKey } from "@omp-app/contracts";
import type { Omp, OmpEvent } from "@omp-app/contracts";
import { CHAT_HOST_METHODS, type ChatHostMethodMap } from "@omp-app/contracts/chat-host";
```

`src/index.ts` exports the core and the ports (`src/ports/A0/`, `src/ports/A1/`); `@omp-app/contracts/chat-host` is the chat host's protocol, and `@omp-app/contracts/chat-host/args` its launch arguments.

## Files

| Path | What it is |
|---|---|
| `src/chat-host/` | The chat host's protocol (`protocol.ts`: `hello`, the methods by name with their params and results in `ChatHostMethodMap`, the events in `ChatEvent`), its parts (dialogs, host tools and URIs, subagents, live voice), the methods' names on their own (`method-names.ts`, so the capability keys can list them without an import cycle), and `omp-types.ts`: the app's names for omp's objects (`Omp.*`), typed from omp's SDK. |
| `src/core/omp.ts` | The floor version, the `Omp` namespace, `OmpEvent` and `OmpMessage`. |
| `src/core/ids.ts` | Branded ids with zod schemas (`ThreadId`, `EntryId`, `FolderPath`, `SessionFilePath`, `RequestId`, `ToolCallId`, `SubagentId`, `UiRequestId`, `HostCallId`, `OmpProcessId`, `OmpStreamMessageId`), `EntryRef`, `SessionEntryHead`, and the message keying rule (below) with `messageIdentity` and `pairEndedMessages`. |
| `src/core/envelope.ts` | The browser-server wire `omp-app/1`: client frames `hello`, `call`, `cancel`, `subscribe`, `unsubscribe`; server frames `welcome`, `result`, `event`; parse and serialize helpers; `definePort` and the `PortClient` / `PortHandlers` types A0 builds the proxy and dispatcher from; `PortCallOptions` with its `AbortSignalLike` signal. |
| `src/core/errors.ts` | `AppError` with its ten codes, and `parseJson`, which turns bad JSON or schema failures into `invalid_args` errors without echoing the input. |
| `src/core/capabilities.ts` | `CapabilityKey` (`omp.cmd.<method>` for each of the chat host's methods, `omp.ui`, `omp.host-tools`, `omp.host-uris`, `omp.subagent-events`, `omp.live-voice`, `host.*`, `client.*`, `upstream.*`), `CapabilityStatus` and `CapabilityMap`. |
| `src/core/provenance.ts` | `SettingSource` (omp's real settings layers), `Provenance`, `Sourced<T>`, `sourcedSchema` and `overridesFollowPrecedence`. |
| `src/core/fixtures.ts` | The privacy check for committed fixtures and recordings: `checkScrubbed` and its `PRIVATE_PATH_ROOTS`. |
| `test/` | `bun test`: the envelope and its rejected frames, the capability keys, the privacy check, the chat host's protocol and the ports. |

Scripts: `bun run typecheck` checks `src/` alone with `tsconfig.json`, then the tests with `tsconfig.test.json`; `bun test` runs the tests.

## Rules for this package

- **Isomorphic source.** `src/` uses no Bun, Node or DOM API. `tsconfig.json` enforces it: it loads no ambient types (`"types": []`) and only the ES2023 library, so `Bun`, `document` or a `node:` import fails the typecheck. Tests run in Bun and use `tsconfig.test.json`, which adds the Bun types.
- **omp's types stay type-only.** `src/` imports omp's packages with `import type` only, so nothing of omp runs where contracts is imported.

## The contracts in brief

**Message keys** (`ids.ts`). omp's session entries carry `id` and `parentId`; the chat host exposes them through `get_entries`, `get_tree`, `get_branch_messages` and `get_subagent_messages`. Entry ids are unique only within one session file, because a fork copies them. Streaming events (`message_start`, `message_update`, `message_end`) carry `messageId`, a `msg-<n>` counter of the chat host, not an entry id.
- A persisted message is keyed `persistedMessageKey(threadId, entryId)`.
- A streaming message is keyed `provisionalMessageKey(processId, messageId)` until its entry is known.
- After `message_end`, `get_entries { since }` returns the new entries. `pairEndedMessages` pairs each ended message, in order, with the first unpaired entry of the same identity, and the message takes that entry's persisted key. The identity is the one omp itself keys persisted messages by (`sessionMessagePersistenceKey`): assistant by timestamp, provider, model, responseId and stopReason; toolResult by timestamp, toolCallId and toolName; user and developer by timestamp and attribution; fileMention by timestamp; custom and hookMessage by customType and timestamp. Content is never compared, and order breaks the remaining ties.
- A message that no entry ever matches stays provisional and is gone after a reload.

The exact rule, with omp source citations, is the comment at the top of `ids.ts`.

**Capabilities** (`capabilities.ts`). A capability is `available` only when the running omp reports it or a side-effect-free probe confirms it; a version string alone never turns a feature on.

**App wire** (`envelope.ts`). Every `call`, `subscribe` and `unsubscribe` gets exactly one `result`. Events carry a per-stream `seq` starting at 1. A reconnecting client resubscribes with `afterSeq`. Seqs are comparable only within one server `instanceId`; a stale resume fails with `conflict`, and the client then refetches state. Every `PortClient` method takes an optional `{ signal }`. Aborting the signal sends a `cancel` frame, and the call's promise rejects at once with an `AppError` of code `cancelled`. Cancelling does not undo work the server already finished.

**Settings layers** (`provenance.ts`), highest first: `env` (unless the variable is declared a fallback), `runtime` (session overrides, CLI flags, the protocol defaults omp applies to a chat the app runs), `overlay` (`PI_CONFIG_FILES`, then `--config`), `project` (`.omp/config.yml`, `.omp/settings.json` and other agents' project files), `global` (`~/.omp/agent/config.yml`), `default`. omp 18.6.1 has no managed or system layer, and it reports the layer but never the file. In a `Sourced<T>` value, `overrides` lists only layers below `source`, each once, highest first; a fallback `env` ranks just above `default`.

**The privacy check** (`fixtures.ts`). Fixtures and recordings are recorded from scripted scenarios against the fake provider. Before one is committed, keys, tokens and auth headers become `<REDACTED:<kind>>`, e-mail addresses `<EMAIL>`, and absolute paths under a private root `<WORKSPACE>`, `<HOME>`, `<TMP>` or `<WORKSPACE_BUCKET>`. `checkScrubbed` reports, by line and column and never with the matched text:
- absolute paths under a private root, whether the root alone or a path below it: `/home`, `/Users`, `/root`, `/tmp`, `/var/tmp`, `/var/folders`, `/var/home`, `/private/tmp`, `/private/var/tmp`, `/private/var/folders`, `/srv`, `/mnt`, `/media`, `/Volumes`, `/opt`, `/run/user`;
- every Windows drive path;
- key-shaped strings and secret-named JSON fields;
- bearer or basic credentials;
- e-mail addresses (an scp-style `git@host:path` remote is not one).

System paths such as `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc`, `/dev`, `/proc` and `/sys` may stay.
