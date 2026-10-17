import {
  AppFailure,
  type CapabilityMap,
  type ExtensionCatalogChanged,
  type FolderPath,
  type ThreadId,
  UiRequestId,
} from "@omp-app/contracts";
import type { DialogHost, DialogHostOpenOptions } from "@/modules/U4/contract";
import {
  type ExtensionCatalog,
  type ExtensionMetadata,
  I2CapabilityKeys,
  isI2CapabilityAvailable,
  sanitizeCatalogText,
} from "../catalog/contract";

const SKILLS_TERMINAL_REASON =
  "Search, install and update skills in the omp terminal; the app cannot connect to the skills registry.";
const AUTH_GATEWAY_TERMINAL_REASON =
  "Start an auth gateway with omp in a terminal; the app cannot start a local authentication process.";

export interface SkillsOperationsOptions {
  readonly threadId: ThreadId;
  readonly folder: FolderPath | null;
  readonly capabilities: CapabilityMap;
  readonly dialogs: Pick<DialogHost, "open">;
  readonly catalog: ExtensionCatalog;
}

export interface SkillsOperations {
  readonly listInstalled: (
    query?: string,
    signal?: AbortSignal,
  ) => Promise<readonly ExtensionMetadata[]>;
  readonly inspectInstalled: (signal?: AbortSignal) => Promise<ExtensionMetadata | null>;
  readonly subscribeCatalogChanges: (
    listener: (change: ExtensionCatalogChanged) => void,
  ) => Promise<() => Promise<void>>;
  readonly registryFallback: (action: "search" | "install" | "update") => never;
  readonly authGatewayFallback: () => never;
}

let sequence = 0;

function requestId(purpose: string): UiRequestId {
  sequence += 1;
  return UiRequestId.parse(`app-i2-skills-${purpose}-${sequence}`);
}

function dialogOptions(threadId: ThreadId, signal?: AbortSignal): DialogHostOpenOptions {
  return { threadId, origin: "app", signal };
}

function requireCatalog(capabilities: CapabilityMap): void {
  if (isI2CapabilityAvailable(capabilities, I2CapabilityKeys.extensionCatalog)) return;
  throw new AppFailure({
    code: "unavailable",
    message:
      "The installed skills list is unavailable because the extension catalog is not connected.",
    retryable: true,
    capability: I2CapabilityKeys.extensionCatalog,
  });
}

function unavailableFallback(
  capability: "host.skills-registry" | "host.auth-gateway",
  message: string,
): never {
  throw new AppFailure({
    code: "unavailable",
    message,
    retryable: false,
    capability,
  });
}

export function createSkillsOperations(options: SkillsOperationsOptions): SkillsOperations {
  const listInstalled = async (
    query = "",
    signal?: AbortSignal,
  ): Promise<readonly ExtensionMetadata[]> => {
    requireCatalog(options.capabilities);
    const catalog = await options.catalog.list(options.folder, { signal });
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return catalog.skills.filter((skill) => {
      if (!normalizedQuery) return true;
      return [skill.name, skill.provider, skill.version, skill.description]
        .filter((value): value is string => value !== undefined)
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    });
  };

  const inspectInstalled = async (signal?: AbortSignal): Promise<ExtensionMetadata | null> => {
    requireCatalog(options.capabilities);
    const search = await options.dialogs.open(
      {
        kind: "input",
        id: requestId("search"),
        title: "Search installed skills",
        placeholder: "Skill name or description",
        optional: true,
      },
      dialogOptions(options.threadId, signal),
    );
    if (search.outcome !== "answered") return null;
    const query = sanitizeCatalogText(search.response.value, 256) ?? "";
    const skills = await listInstalled(query, signal);
    if (skills.length === 0) return null;
    const seen = new Map<string, number>();
    const labels = skills.map((skill) => {
      const duplicate = seen.get(skill.name) ?? 0;
      seen.set(skill.name, duplicate + 1);
      return duplicate === 0 ? skill.name : `${skill.name} (${duplicate + 1})`;
    });
    const selected = await options.dialogs.open(
      {
        kind: "select",
        id: requestId("pick"),
        title: "Choose an installed skill",
        options: labels,
        optionDetails: skills.map((skill) => ({
          description:
            [skill.version && `Version ${skill.version}`, skill.description]
              .filter((value): value is string => Boolean(value))
              .join(" · ") || undefined,
        })),
      },
      dialogOptions(options.threadId, signal),
    );
    if (selected.outcome !== "answered") return null;
    const skill = skills[labels.indexOf(selected.response.value)];
    if (!skill) return null;
    await options.dialogs.open(
      {
        kind: "editor",
        id: requestId("details"),
        title: skill.name,
        prefill: [
          skill.enabled ? "Enabled" : "Disabled",
          skill.shadowed ? "Another skill takes precedence." : undefined,
        ]
          .filter((value): value is string => Boolean(value))
          .join("\n\n"),
        readOnly: true,
      },
      dialogOptions(options.threadId, signal),
    );
    return skill;
  };

  const operations: SkillsOperations = {
    listInstalled,
    inspectInstalled,
    async subscribeCatalogChanges(listener) {
      requireCatalog(options.capabilities);
      return options.catalog.subscribe(listener);
    },
    registryFallback: (_action) =>
      unavailableFallback(I2CapabilityKeys.skillsRegistry, SKILLS_TERMINAL_REASON),
    authGatewayFallback: () =>
      unavailableFallback(I2CapabilityKeys.authGateway, AUTH_GATEWAY_TERMINAL_REASON),
  };
  return Object.freeze(operations);
}
