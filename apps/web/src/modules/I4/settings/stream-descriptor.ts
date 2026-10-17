import type {
  SettingsSectionDescriptor,
  SettingValue,
  ValidationResult,
} from "@/modules/S1/settings-kit";

function serverUrl(value: SettingValue): ValidationResult {
  if (value.secret || typeof value.value !== "string") {
    return {
      valid: false,
      code: "url",
      message: "Enter an https:// address with no path.",
    };
  }
  try {
    const url = new URL(value.value);
    return url.protocol === "https:" &&
      url.hostname.length > 0 &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
      ? { valid: true }
      : { valid: false, code: "url", message: "Enter an https:// address with no path." };
  } catch {
    return {
      valid: false,
      code: "url",
      message: "Enter an https:// address with no path.",
    };
  }
}

function patterns(value: SettingValue): ValidationResult {
  if (value.secret || !Array.isArray(value.value)) {
    return { valid: false, code: "regex", message: "Enter one regular expression per row." };
  }
  for (const pattern of value.value) {
    if (typeof pattern !== "string") {
      return { valid: false, code: "regex", message: "Enter one regular expression per row." };
    }
    try {
      new RegExp(pattern);
    } catch {
      return { valid: false, code: "regex", message: "Enter a valid regular expression." };
    }
  }
  return { valid: true };
}

/** I4 owns omp's `interaction/Stream` settings; writes still go through A1 ConfigStore. */
export const STREAM_SETTINGS_SECTION: SettingsSectionDescriptor = {
  id: "I4.interactionStream",
  section: "interaction/Stream",
  title: "Stream",
  inventory: ["S3.interaction-stream"],
  requires: ["host.config"],
  controls: [
    {
      key: "stream.serverUrl",
      label: "Stream Server",
      description:
        "Live stream server used by omp stream (https://host[:port]); viewers watch at the base URL plus their Stencil username. Enter an HTTPS address with no path. It is read when a new omp stream or omp clip process starts.",
      kind: "text",
      secret: false,
      apply: "restart",
      validate: serverUrl,
    },
    {
      // S1 edits these as { pattern } rows; StreamSettings maps omp's stored string[] to that shape and back.
      key: "stream.redactPatterns",
      label: "Extra Redaction Patterns",
      description:
        "Additional regular expressions, on top of env/secrets.yml values and built-in credential patterns, redact every streamed row. New patterns apply immediately in interactive sessions.",
      kind: "rows",
      secret: false,
      apply: "live",
      fields: {
        pattern: {
          label: "Regular expression",
          kind: "text",
          placeholder: "sk-[a-z0-9]{20,40}",
        },
      },
      ordered: true,
      addLabel: "Add pattern",
      emptyLabel: "No extra redaction patterns",
      validate: patterns,
    },
  ],
};
