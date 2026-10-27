import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CapabilityKey,
  type CapabilityMap,
  type ChatSessionClient,
  ChatSessionPort,
  type ThreadId,
} from "@omp-app/contracts";
import type { AuthPort, AuthStatus, LoginProvider } from "../contract";
import { AUTH_CAPABILITIES, AuthStatusSchema, LoginProviderSchema } from "../contract";

export interface AuthAdapterOptions {
  readonly client: AppClient;
  readonly threadId: ThreadId;
  readonly capabilities?: CapabilityMap;
}

function unavailable(capability: CapabilityKey): AppFailure {
  return new AppFailure({
    code: "unavailable",
    message: "Provider login is unavailable for this session.",
    retryable: false,
    capability,
  });
}

function invalidProvider(providerId: string): AppFailure {
  return new AppFailure({
    code: "invalid_args",
    message:
      providerId.trim().length === 0
        ? "Provider selection is required."
        : "Provider selection is invalid.",
    retryable: false,
  });
}

function safeFailure(error: unknown, fallback: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure(
    { code: "internal", message: fallback, retryable: false },
    { cause: error },
  );
}

function providerId(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 128 ||
    hasUnsafeProviderCharacter(normalized)
  ) {
    throw invalidProvider(value);
  }
  return normalized;
}

function hasUnsafeProviderCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127 || /\s/.test(character)) return true;
  }
  return false;
}

function statusError(failure: AppFailure, selectedProvider: string): AuthStatus {
  if (failure.appError.code === "cancelled") {
    return AuthStatusSchema.parse({ state: "cancelled", providerId: selectedProvider });
  }
  return AuthStatusSchema.parse({
    state: "error",
    providerId: selectedProvider,
    error: failure.appError,
  });
}

/** Sign-ins on the chat session port. U4's router shows a login's page and code requests; this adapter never handles URLs or secrets. */
export function createAuthPort(options: AuthAdapterOptions): AuthPort {
  const session = options.client.port(ChatSessionPort) as ChatSessionClient;
  const capabilities = options.capabilities ?? {};
  const requireCapability = (capability: keyof typeof AUTH_CAPABILITIES): void => {
    const key = AUTH_CAPABILITIES[capability];
    if (capabilities[key]?.state === "available") return;
    throw unavailable(key);
  };

  return {
    capabilities: () => capabilities,
    async getLoginProviders(callOptions) {
      requireCapability("getLoginProviders");
      try {
        const result = await session.request(
          { threadId: options.threadId, method: "get_login_providers", params: {} },
          callOptions,
        );
        const providers = Array.isArray(result?.providers) ? result.providers : [];
        return providers.map((provider) =>
          LoginProviderSchema.parse(provider),
        ) as readonly LoginProvider[];
      } catch (error) {
        throw safeFailure(error, "Provider discovery failed.");
      }
    },
    async login(rawProviderId, callOptions) {
      requireCapability("login");
      const selectedProvider = providerId(rawProviderId);
      try {
        const result = await session.request(
          { threadId: options.threadId, method: "login", params: { providerId: selectedProvider } },
          callOptions,
        );
        const returnedProvider =
          typeof result?.providerId === "string" ? providerId(result.providerId) : selectedProvider;
        return AuthStatusSchema.parse({ state: "authenticated", providerId: returnedProvider });
      } catch (error) {
        return statusError(safeFailure(error, "Provider login failed."), selectedProvider);
      }
    },
  };
}
