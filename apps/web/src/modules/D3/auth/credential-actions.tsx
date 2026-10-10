import { createContext, type ReactNode, useContext } from "react";
import type { ProviderSignIn } from "../contract";

/**
 * What a credential failure notice can do for the person: open the model list, open provider sign-in,
 * and say how each provider is signed in. The app root supplies these; a view only calls them.
 */
export interface CredentialActions {
  readonly chooseModel?: () => void;
  readonly signIn?: (provider: string | undefined) => void;
  readonly readSignIns?: () => Promise<ReadonlyMap<string, ProviderSignIn>>;
}

const NO_ACTIONS: CredentialActions = {};
const CredentialActionsContext = createContext<CredentialActions>(NO_ACTIONS);

export function CredentialActionsProvider({
  value,
  children,
}: {
  readonly value: CredentialActions;
  readonly children: ReactNode;
}) {
  return (
    <CredentialActionsContext.Provider value={value}>{children}</CredentialActionsContext.Provider>
  );
}

export function useCredentialActions(): CredentialActions {
  return useContext(CredentialActionsContext);
}
