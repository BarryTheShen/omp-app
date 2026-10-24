# @omp-app/contracts

The shared contracts of the omp app (module C0): the types, zod schemas and tables that the Bun server and the browser both use. The package ships TypeScript source with no build step; its only runtime dependency is `zod` 4. The omp floor is 18.6.1.

## Using it

Add `"@omp-app/contracts": "workspace:*"` to the `dependencies` of the package that needs it, then:

```ts
import { definePort, OMP_COMMANDS, persistedMessageKey, validateRegistry } from "@omp-app/contracts";
import type { OmpCommandMap, OmpEvent, OmpWire } from "@omp-app/contracts";
```

omp's full JSON Schema is available as `@omp-app/contracts/omp-wire/schema.json`. `src/index.ts` exports everything else; nothing else is a public entry point.

## Files

| Path | What it is |
|---|---|
| `src/omp-wire/` | omp's wire schema (`rpc-wire.schema.json`), its generated TypeScript types (`rpc-wire.generated.ts`) and omp's MIT `LICENSE`, copied byte for byte from omp v18.12.6 (commit `45c35e40c46166dc726ccc52f5d27f40f2449f99`). `PROVENANCE.md` records the source URL, sha256 and size of each file. Never edit these files; refresh them with the script below. |
| `src/core/omp.ts` | App-facing names over the copied wire types: `OmpCommandName`, `OmpCommandMap` (params, result, completion), `OMP_COMMANDS` (completion and timeout per command, checked against the schema's `x-rpc.commands`), `OmpCommand`, `OmpResponse`, `OmpEvent`, `OmpNotification`, `OmpHostRequest`, `OmpServerFrame`, `OmpInboundFrame`, `OmpMessage`, `OmpContentPart`, the `OmpWire` namespace with every generated type, and the floor version, wire tag and commit, protocol versions and RPC modes. |
| `src/core/ids.ts` | Branded ids with zod schemas (`ThreadId`, `EntryId`, `FolderPath`, `SessionFilePath`, `RequestId`, `ToolCallId`, `SubagentId`, `UiRequestId`, `HostCallId`, `OmpProcessId`, `OmpStreamMessageId`), `EntryRef`, `SessionEntryHead`, and the message keying rule (below) with `messageIdentity` and `pairEndedMessages`. |
| `src/core/envelope.ts` | The browser-server wire `omp-app/1`: client frames `hello`, `call`, `cancel`, `subscribe`, `unsubscribe`; server frames `welcome`, `result`, `event`; parse and serialize helpers; `definePort` and the `PortClient` / `PortHandlers` types A0 builds the proxy and dispatcher from; `PortCallOptions` with its `AbortSignalLike` signal. |
| `src/core/errors.ts` | `AppError` with its ten codes, and `parseJson`, which turns bad JSON or schema failures into `invalid_args` errors without echoing the input. |
| `src/core/capabilities.ts` | `CapabilityKey` (`omp.cmd.<command>`, `omp.protocol.v2`, `omp.ui`, `omp.host-tools`, `omp.host-uris`, `omp.subagent-events`, `omp.live-voice`, `host.*`, `client.*`, `upstream.*`), `CapabilityStatus` and `CapabilityMap`. |
| `src/core/descriptors.ts` | Registry descriptors (Tool, Dialog, Panel, Command, Setting, Shortcut, Status, Notice), `validateRegistry`, `uncoveredInventory` and `normalizeChord`. |
| `src/core/modules.ts` | The 42 modules (`MODULE_IDS`, `MODULES`, checked against `PLAN.md`), path ownership (`PATH_OWNERSHIP`, `ownerOfPath`), omp's settings tabs and sections, and the namespace-ownership table (`NAMESPACE_OWNERSHIP`, `namespaceClaim`). |
| `src/core/provenance.ts` | `SettingSource` (omp's real settings layers), `Provenance`, `Sourced<T>`, `sourcedSchema` and `overridesFollowPrecedence`. |
| `src/core/fixtures.ts` | The recorded-fixture format, `parseFixture`, `serializeFixture`, the scrub check `checkScrubbed` and its `PRIVATE_PATH_ROOTS`. |
| `src/core/inventory.ts`, `src/core/inventory.json` | Stable ids for every row of `research/omp-feature-inventory.md`. The JSON is generated; never edit it, and rerun the script whenever the research file changes. |
| `src/ports/<ModuleId>/` | Port definitions a module serves, added by that module in later waves. |
| `scripts/sync-omp-wire.ts` | `bun scripts/sync-omp-wire.ts <tag>` copies the wire files from an omp tag, pinned to the tag's commit, and rewrites `PROVENANCE.md`. |
| `scripts/build-inventory.ts` | `bun scripts/build-inventory.ts` regenerates `inventory.json`; it refuses to write when the row count or a group's count differs from what the research file states. |
| `test/` | `bun test`: copied-file hashes, command table against the schema, envelope and fixture round trips, rejected frames, registry double claims, inventory, module table and header citations. |

Scripts: `bun run typecheck` checks `src/` alone with `tsconfig.json`, then tests and scripts with `tsconfig.test.json`; `bun test` runs the tests; `bun run sync-omp-wire <tag>` and `bun run build-inventory` run the two scripts.

## Rules for this package

- **Isomorphic source.** `src/` uses no Bun, Node or DOM API. `tsconfig.json` enforces it: it loads no ambient types (`"types": []`) and only the ES2023 library, so `Bun`, `document` or a `node:` import fails the typecheck. Tests and scripts run in Bun and use `tsconfig.test.json`, which adds the Bun types.
- **Copied files stay untouched.** The generated wire types declare types only (a test checks it) and pass the strict configuration as they are, so they are imported with `import type` and cost nothing at run time. If a later copy ever fails the strict check, the fix is to change how the script stores or the configuration reaches the file (for example, saving the types-only file as `rpc-wire.generated.d.ts`, which `skipLibCheck` exempts), never to edit its content.
- **Frozen after W0.** Once the W0 gate accepts C0, `src/core/` changes only through the main agent; every other module adds ports under `src/ports/<ModuleId>/`.

## The contracts in brief

**Message keys** (`ids.ts`). omp's session entries carry `id` and `parentId`; the wire exposes them through `get_entries`, `get_tree`, `get_branch_messages` and `get_subagent_messages`. Entry ids are unique only within one session file, because a fork copies them. Streaming frames (`message_start`, `message_update`, `message_end`) carry `messageId`, a `msg-<n>` counter of the omp process, not an entry id.
- A persisted message is keyed `persistedMessageKey(threadId, entryId)`.
- A streaming message is keyed `provisionalMessageKey(processId, messageId)` until its entry is known.
- After `message_end`, `get_entries { since }` returns the new entries. `pairEndedMessages` pairs each ended message, in order, with the first unpaired entry of the same identity, and the message takes that entry's persisted key. The identity is the one omp itself keys persisted messages by (`sessionMessagePersistenceKey`): assistant by timestamp, provider, model, responseId and stopReason; toolResult by timestamp, toolCallId and toolName; user and developer by timestamp and attribution; fileMention by timestamp; custom and hookMessage by customType and timestamp. Content is never compared, and order breaks the remaining ties.
- A message that no entry ever matches stays provisional and is gone after a reload.

The exact rule, with omp source citations, is the comment at the top of `ids.ts`.

**Capabilities** (`capabilities.ts`). A capability is `available` only when the running omp reports it or a side-effect-free probe confirms it; a version string alone never turns a feature on.

**App wire** (`envelope.ts`). Every `call`, `subscribe` and `unsubscribe` gets exactly one `result`. Events carry a per-stream `seq` starting at 1. A reconnecting client resubscribes with `afterSeq`. Seqs are comparable only within one server `instanceId`; a stale resume fails with `conflict`, and the client then refetches state. Every `PortClient` method takes an optional `{ signal }`. Aborting the signal sends a `cancel` frame, and the call's promise rejects at once with an `AppError` of code `cancelled`. Cancelling does not undo work the server already finished.

**Settings layers** (`provenance.ts`), highest first: `env` (unless the variable is declared a fallback), `runtime` (session overrides, CLI flags, RPC protocol defaults), `overlay` (`PI_CONFIG_FILES`, then `--config`), `project` (`.omp/config.yml`, `.omp/settings.json` and other agents' project files), `global` (`~/.omp/agent/config.yml`), `default`. omp 18.6.1 has no managed or system layer, and it reports the layer but never the file. In a `Sourced<T>` value, `overrides` lists only layers below `source`, each once, highest first; a fallback `env` ranks just above `default`.

**Fixtures** (`fixtures.ts`). One `<scenario>.fixture.jsonl` per scripted scenario.
- Line 1 is the header: `format`, `formatVersion`, `scenario`, `description`, `recordedAt`, `source: "scripted"`, `omp { version, commit, protocolVersion, mode, args }`, `provider { kind: "fake-openai" }`, `capabilities`, `placeholders`, `redactions { key, token, authHeader, email, path }`, `tags` and `inventory`.
- Every later line is a frame `{ t, dir, line }`, holding the raw wire line.
- Keys, tokens and auth headers become `<REDACTED:<kind>>`. E-mail addresses become `<EMAIL>`. Absolute paths under a private root become `<WORKSPACE>`, `<HOME>` or `<TMP>`. The header declares every placeholder the frames use.
- Both helpers refuse text that fails `checkScrubbed`:
  - absolute paths under a private root, whether the root alone or a path below it: `/home`, `/Users`, `/root`, `/tmp`, `/var/tmp`, `/var/folders`, `/var/home`, `/private/tmp`, `/private/var/tmp`, `/private/var/folders`, `/srv`, `/mnt`, `/media`, `/Volumes`, `/opt`, `/run/user`;
  - every Windows drive path;
  - key-shaped strings and secret-named JSON fields;
  - bearer or basic credentials;
  - e-mail addresses (an scp-style `git@host:path` remote is not one).

  System paths such as `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc`, `/dev`, `/proc` and `/sys` may stay.

**Registry** (`descriptors.ts`). Every descriptor has `id` (`<ModuleId>.<name>`), `owner`, `title`, `covers` (inventory ids) and `requires` (capabilities). `validateRegistry` rejects each of the following:
- invalid descriptors, duplicate ids, and ids not prefixed by their owner;
- unknown inventory rows, and rows covered twice;
- a second claim on an omp tool name, prefix or the fallback, on a slash command, on a setting key, or on a chord within a scope;
- any claim on a namespace the ownership table gives to another module, or that is contested.

## Ownership rules (repo-wide)

From the C0 plan (`modules/C0/README.md`):
- A module edits only its own folders (`packages/*/src/modules/<ModuleId>/`, `apps/web/src/modules/<ModuleId>/`, `packages/contracts/src/ports/<ModuleId>/`) and its header.
- It may add dependencies to the package it lives in.
- Registry and composition index files, root config files and the lockfile belong to the main agent.
- Copied assistant-ui components belong to U0.
- Anything copied or generated is refreshed by its script, never edited by hand.

Packages and shells, as the main agent assigned them. A module also owns `<package>/src/modules/<ModuleId>/` in any package. `PATH_OWNERSHIP` encodes all of this, and `ownerOfPath(path)` answers for one path.

| Path | Owner |
|---|---|
| `packages/contracts/**` | C0; `src/core/` frozen after W0 |
| `packages/contracts/src/ports/<ModuleId>/` | that module |
| `packages/contracts/src/index.ts` | main agent |
| `packages/omp-rpc/**` | A0: the isomorphic RPC core (JSONL and v2 framing, correlation, event normalization, fixture replay); it must run in Bun and in browser tests |
| `packages/client/**` | A0: the isomorphic client of the `omp-app/1` envelope (WebSocket, reconnect and resume, typed port proxies), used by the web app and by Bun tests |
| `packages/server/**` | A0: the server shell (entrypoint, HTTP/WebSocket, dispatcher) |
| `packages/server/src/modules/<ModuleId>/` | that module (A1's stores live in `src/modules/A1/`) |
| `packages/server/src/registry/` | main agent |
| `apps/web/**` | U0: the shell (Vite config, entry, AppShell, tokens) and the copied assistant-ui and shadcn components under `src/components/` |
| `apps/web/src/modules/<ModuleId>/` | that module |
| `apps/web/src/registry/` | main agent |
| `modules/<ModuleId>/README.md` | that module's lead, within `AGENTS.md` |
| `AGENTS.md` | main agent, only with the owner's approval |
| `AI-README.md`, `PLAN.md`, `research/`, root config files, `bun.lock` | main agent |

**Namespace ownership.** `NAMESPACE_OWNERSHIP` gives each of these namespaces an owner, derived from the module headers and citing the header text:
- every omp settings section, as `<tab>/<section>` (60 in omp 18.6.1);
- every builtin slash command (85 in omp 18.6.1), plus the five non-builtin command sources;
- 28 panels.

Where two headers claimed the same namespace, or where no header named something omp 18.6.1 added, the main agent decided the owner on 2026-10-04, and the claim cites that decision next to the header text. No namespace is contested now. A namespace found contested later is recorded as `contested` with its candidates until the main agent decides it; meanwhile `validateRegistry` rejects every registration in it.
