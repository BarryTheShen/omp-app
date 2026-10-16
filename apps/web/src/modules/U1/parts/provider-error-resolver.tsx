import type { ProviderErrorResult } from "@omp-app/contracts";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

export type ProviderErrorResolver = (text: string) => Promise<ProviderErrorResult>;

const ProviderErrorResolverContext = createContext<ProviderErrorResolver | undefined>(undefined);

export function ProviderErrorResolverProvider({
  resolver,
  children,
}: {
  readonly resolver: ProviderErrorResolver | undefined;
  readonly children: ReactNode;
}) {
  return (
    <ProviderErrorResolverContext.Provider value={resolver}>
      {children}
    </ProviderErrorResolverContext.Provider>
  );
}

export function useProviderError(text: string | undefined): ProviderErrorResult | undefined {
  const resolver = useContext(ProviderErrorResolverContext);
  const [result, setResult] = useState<ProviderErrorResult>();
  useEffect(() => {
    let current = true;
    if (text === undefined || resolver === undefined) {
      setResult(undefined);
      return () => {
        current = false;
      };
    }
    setResult(undefined);
    void resolver(text).then(
      (next) => {
        if (current) setResult(next);
      },
      () => {
        if (current) setResult(undefined);
      },
    );
    return () => {
      current = false;
    };
  }, [resolver, text]);
  return result;
}
