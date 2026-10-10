import type { CommandDescriptor } from "@omp-app/contracts";
import { AUTH_CAPABILITIES } from "./contract";

/**
 * The palette command that opens the provider login page over the open chat. It covers omp's `/login`
 * (`D4.login` in the C0 inventory); typing `/login` in the composer opens the same page.
 */
export const D3_LOGIN_COMMAND = {
  kind: "command",
  id: "D3.login",
  owner: "D3",
  title: "Provider login",
  covers: ["D4.login"],
  requires: [AUTH_CAPABILITIES.getLoginProviders],
} as const satisfies CommandDescriptor;

export const D3_LOGIN_DESCRIPTORS = [D3_LOGIN_COMMAND] as const;
