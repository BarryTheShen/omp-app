import type {
  ConfigSnapshot,
  SettingControl,
  SettingsSectionDescriptor,
  SettingValue,
} from "@/modules/S1/settings-kit";

const valid = () => ({ valid: true as const });

function booleanControl(
  key: string,
  label: string,
  description: string,
  apply: SettingControl["apply"] = "restart",
): SettingControl {
  return {
    key,
    label,
    description,
    kind: "boolean",
    secret: false,
    validate: (value: SettingValue) =>
      value.secret ? { valid: false, message: "Expected a boolean." } : valid(),
    apply,
  };
}

function enumControl(
  key: string,
  label: string,
  options: readonly string[],
  description: string,
  apply: SettingControl["apply"] = "restart",
): SettingControl {
  return {
    key,
    label,
    description,
    kind: "enum",
    secret: false,
    options: options.map((value) => ({ value, label: value })),
    validate: (value: SettingValue, _snapshot: ConfigSnapshot) =>
      !value.secret && typeof value.value === "string" && options.includes(value.value)
        ? valid()
        : { valid: false, code: "enum", message: `Choose one of: ${options.join(", ")}.` },
    apply,
  };
}

function numberControl(
  key: string,
  label: string,
  description: string,
  apply: SettingControl["apply"] = "restart",
): SettingControl {
  return {
    key,
    label,
    description,
    kind: "number",
    secret: false,
    validate: (value: SettingValue) =>
      !value.secret && typeof value.value === "number" && Number.isFinite(value.value)
        ? valid()
        : { valid: false, code: "number", message: "Enter a finite number." },
    apply,
  };
}

function listControl(
  key: string,
  label: string,
  description: string,
  apply: SettingControl["apply"] = "restart",
): SettingControl {
  return {
    key,
    label,
    description,
    kind: "list",
    secret: false,
    validate: (value: SettingValue) =>
      !value.secret && Array.isArray(value.value)
        ? valid()
        : { valid: false, code: "list", message: "Enter a comma-separated list." },
    apply,
  };
}

function section(
  id: string,
  title: string,
  controls: readonly SettingControl[],
): SettingsSectionDescriptor {
  return {
    id: id as SettingsSectionDescriptor["id"],
    section: `model/${title}` as SettingsSectionDescriptor["section"],
    title,
    inventory: [],
    controls,
    requires: ["host.config"],
  };
}

export const modelThinkingSection = section("D1.modelThinking", "Thinking", [
  enumControl(
    "defaultThinkingLevel",
    "Thinking Level",
    ["auto", "inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"],
    "Default reasoning depth for thinking-capable models.",
  ),
  booleanControl(
    "hideThinkingBlock",
    "Hide Thinking Blocks",
    "Hide reasoning blocks in assistant responses.",
    "live",
  ),
  booleanControl(
    "proseOnlyThinking",
    "Prose Only Thinking",
    "Omit code blocks from thinking summaries.",
    "live",
  ),
  booleanControl(
    "omitThinking",
    "Omit Thinking Summaries",
    "Ask providers to omit reasoning summaries where supported.",
  ),
  booleanControl(
    "externalThinking",
    "External Thinking",
    "Use a private provider scratchpad where supported.",
  ),
  booleanControl("model.loopGuard.enabled", "Loop Guard", "Detect repeated reasoning/prose loops."),
  booleanControl(
    "model.loopGuard.checkAssistantContent",
    "Loop Guard Scan Prose",
    "Apply loop detection to assistant prose.",
  ),
  booleanControl(
    "model.loopGuard.toolCallReminder",
    "Loop Guard Tool-Call Reminder",
    "Remind a reasoning model to issue a tool call when it loops.",
  ),
  booleanControl(
    "model.toolCallLoopGuard.enabled",
    "Tool-Call Loop Guard",
    "Detect repeated identical tool calls.",
  ),
  numberControl(
    "model.toolCallLoopGuard.threshold",
    "Tool-Call Loop Threshold",
    "Repeated calls required before a correction.",
  ),
  listControl(
    "model.toolCallLoopGuard.exemptTools",
    "Tool-Call Loop Exempt Tools",
    "Tool names allowed to repeat.",
  ),
  enumControl(
    "providers.autoThinkingMaxEffort",
    "Auto Thinking Ceiling",
    ["xhigh", "max"],
    "Highest level automatic thinking may choose.",
  ),
]);

export const modelSamplingSection = section("D1.modelSampling", "Sampling", [
  numberControl("temperature", "Temperature", "Sampling creativity; -1 uses the provider default."),
  numberControl("topP", "Top P", "Nucleus sampling cutoff; -1 uses the provider default."),
  numberControl("topK", "Top K", "Number of top tokens sampled; -1 uses the provider default."),
  numberControl("minP", "Min P", "Minimum probability threshold; -1 uses the provider default."),
  numberControl(
    "presencePenalty",
    "Presence Penalty",
    "Penalty for introducing already-present tokens.",
  ),
  numberControl("repetitionPenalty", "Repetition Penalty", "Penalty for repeated tokens."),
  enumControl(
    "textVerbosity",
    "Text Verbosity",
    ["low", "medium", "high"],
    "Response verbosity for providers that support it.",
  ),
  enumControl(
    "tier.openai",
    "Service Tier — OpenAI",
    ["none", "default", "priority", "flex"],
    "OpenAI request processing tier.",
  ),
  enumControl(
    "tier.anthropic",
    "Service Tier — Anthropic",
    ["none", "standard", "priority"],
    "Anthropic request processing tier.",
  ),
  enumControl(
    "tier.google",
    "Service Tier — Google",
    ["none", "standard", "priority"],
    "Google request processing tier.",
  ),
  enumControl(
    "tier.subagent",
    "Service Tier — Subagent",
    ["inherit", "none", "standard", "priority"],
    "Processing tier for spawned agents.",
  ),
]);

export const modelPromptSection = section("D1.modelPrompt", "Prompt", [
  enumControl(
    "modelRoleStorage",
    "Model Role Storage",
    ["global", "project"],
    "Where role assignments and the saved default are persisted.",
  ),
  enumControl(
    "inlineToolDescriptors",
    "Inline Tool Descriptors",
    ["auto", "on", "off"],
    "Where tool descriptions are rendered in the prompt.",
  ),
  booleanControl(
    "includeModelInPrompt",
    "Include Model in Prompt",
    "Tell the model which model is active.",
  ),
  booleanControl(
    "includeWorkspaceTree",
    "Include Workspace Tree",
    "Render the workspace tree in the prompt.",
  ),
  booleanControl("skillful", "List Skills in Prompt", "List available skills in the prompt."),
  enumControl(
    "personality",
    "Personality",
    ["default", "friendly", "pragmatic", "none"],
    "Communication style rendered in the prompt.",
  ),
]);

export const modelRetryFallbackSection = section("D1.modelRetryFallback", "Retry & Fallback", [
  booleanControl("retry.enabled", "Retries", "Retry transient provider errors."),
  numberControl("retry.maxRetries", "Retry Attempts", "Maximum retry attempts."),
  numberControl("retry.baseDelayMs", "Retry Base Delay", "Initial retry delay in milliseconds."),
  numberControl("retry.maxDelayMs", "Max Retry Delay", "Maximum retry delay in milliseconds."),
  booleanControl(
    "retry.waitForUsageReset",
    "Wait for Usage Reset",
    "Wait for a reported usage reset instead of failing fast.",
  ),
  booleanControl(
    "retry.modelFallback",
    "Retry Model Fallback",
    "Allow configured fallback models during recovery.",
  ),
  booleanControl(
    "retry.usageAwareFallback",
    "Usage-Aware Fallback",
    "Prefer eligible accounts and fallback models near usage limits.",
  ),
  numberControl(
    "retry.usageReservePct",
    "Reserve Margin",
    "Remaining usage percentage treated as near the limit.",
  ),
  enumControl(
    "retry.usageReservePolicy",
    "Reserve Policy",
    ["confirm", "auto", "fail-closed"],
    "Action when every account is inside the reserve margin.",
  ),
  enumControl(
    "retry.fallbackRevertPolicy",
    "Fallback Revert Policy",
    ["cooldown-expiry", "never"],
    "When to return to the primary model.",
  ),
  booleanControl(
    "providers.anthropic.serverSideFallback",
    "Anthropic Server-Side Fallback",
    "Opt into Anthropic server-side model fallback.",
  ),
]);

export const modelPrewalkSection = section("D1.modelPrewalk", "Prewalk", [
  booleanControl(
    "prewalk.enabled",
    "Enable Prewalk",
    "Start implementation with a fast model after planning begins.",
    "session",
  ),
]);

export const modelVisionSection = section("D1.modelVision", "Vision", [
  booleanControl(
    "images.describeForTextModels",
    "Describe Images for Text Models",
    "Describe images when the active model cannot accept images.",
    "session",
  ),
]);

export const modelSettingsSections = [
  modelThinkingSection,
  modelSamplingSection,
  modelPromptSection,
  modelRetryFallbackSection,
  modelPrewalkSection,
  modelVisionSection,
] as const;
