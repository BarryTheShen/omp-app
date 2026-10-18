import type { JsonValue } from "@omp-app/contracts";
import type {
  ScalarSettingControl,
  SettingsSectionDescriptor,
  SettingValue,
  ValidationResult,
} from "../../S1/settings-kit";

const HOST_CONFIG = ["host.config"] as const;

/** omp v18.9.1 packages/wire/src/skillshare.ts:18. */
export const DEFAULT_SKILLS_REGISTRY_URL = "https://skills.omp.sh";

function plainValue(value: SettingValue): JsonValue | undefined {
  return value.secret ? undefined : value.value;
}

function validateSkillsRegistryUrl(value: SettingValue): ValidationResult {
  const candidate = plainValue(value);
  if (candidate === "") return { valid: true };
  if (typeof candidate !== "string" || candidate.includes("\0")) {
    return { valid: false, code: "url", message: "Enter a valid skill registry URL." };
  }
  try {
    const url = new URL(candidate);
    const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    const secureTransport = url.protocol === "https:" || (url.protocol === "http:" && local);
    const safeAddress = !url.username && !url.password && !url.search && !url.hash;
    return secureTransport && safeAddress
      ? { valid: true }
      : {
          valid: false,
          code: "url",
          message:
            "Use https://, or http:// for localhost only, without credentials or a fragment.",
        };
  } catch {
    return { valid: false, code: "url", message: "Enter a valid skill registry URL." };
  }
}

const SKILLS_REGISTRY_CONTROL: ScalarSettingControl = {
  key: "skills.registryUrl",
  label: "Skill Registry",
  description:
    "The Skillshare registry that omp's skill command installs from, searches and publishes to. Use its web address, for example https://skills.omp.sh.",
  kind: "text",
  secret: false,
  validate: validateSkillsRegistryUrl,
  apply: "live",
};

/** omp v18.9.1 packages/coding-agent/src/extensibility/settings.ts:16-23. */
export const INTERACTION_SKILLS_SETTINGS_SECTION: SettingsSectionDescriptor = {
  id: "I2.interactionSkills",
  section: "interaction/Skills",
  title: "Skills",
  inventory: ["S3.interaction-skills"],
  controls: [SKILLS_REGISTRY_CONTROL],
  requires: [...HOST_CONFIG],
};

export const I2_SETTINGS_SECTIONS: readonly SettingsSectionDescriptor[] = [
  INTERACTION_SKILLS_SETTINGS_SECTION,
];
