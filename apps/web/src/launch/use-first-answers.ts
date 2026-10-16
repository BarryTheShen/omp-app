import type { AppClient } from "@omp-app/client";
import {
  type AppHealth,
  AppPort,
  type AppServerInfo,
  type CapabilityMap,
} from "@omp-app/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { rememberLogFile } from "./log-location";

export interface FirstAnswersState {
  readonly status: "pending" | "failed" | "ready";
  readonly capabilities: CapabilityMap;
  readonly serverInfo?: AppServerInfo;
  readonly health?: AppHealth;
}

const PENDING: FirstAnswersState = { status: "pending", capabilities: {} };

/** Reads the app's initial handshake data and retries the full request set after a failure. */
export function useFirstAnswers(
  client: AppClient | null,
  onFailure: (error: unknown) => void,
): { readonly state: FirstAnswersState; readonly retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const attemptRef = useRef(attempt);
  attemptRef.current = attempt;
  const [state, setState] = useState<FirstAnswersState>(PENDING);

  const retry = useCallback(() => {
    setState(PENDING);
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    if (client === null) {
      setState(PENDING);
      return;
    }
    const currentAttempt = attempt;
    let active = true;
    const app = client.port(AppPort);
    setState(PENDING);
    void Promise.all([app.capabilities({}), app.serverInfo({}), app.health({})])
      .then(([capabilities, serverInfo, health]) => {
        if (!active || attemptRef.current !== currentAttempt) return;
        rememberLogFile(serverInfo.logFile);
        setState({ status: "ready", capabilities, serverInfo, health });
      })
      .catch((error: unknown) => {
        if (!active || attemptRef.current !== currentAttempt) return;
        onFailure(error);
        setState({ status: "failed", capabilities: {} });
      });
    return () => {
      active = false;
    };
  }, [attempt, client, onFailure]);

  return { state, retry };
}
