import { useCallback, useRef, useState } from "react";

const SLASH_SENDS_KEY = "omp-app.slash-sends";
const SLASH_SENDS_TO_RETIRE_TIP = 3;
export const SLASH_TIP_PLACEHOLDER = "Message, or type / for commands";

function readSlashSends(): number {
  try {
    const value = Number(globalThis.localStorage.getItem(SLASH_SENDS_KEY));
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function useSlashTip(): {
  readonly placeholder: string | undefined;
  readonly recordSlashSend: () => void;
} {
  const [slashSends, setSlashSends] = useState(readSlashSends);
  const slashSendsRef = useRef(slashSends);
  const recordSlashSend = useCallback(() => {
    const next = slashSendsRef.current + 1;
    slashSendsRef.current = next;
    setSlashSends(next);
    try {
      globalThis.localStorage.setItem(SLASH_SENDS_KEY, String(next));
    } catch {
      // Storage may be disabled in a private or restricted browser context.
    }
  }, []);

  return {
    placeholder: slashSends < SLASH_SENDS_TO_RETIRE_TIP ? SLASH_TIP_PLACEHOLDER : undefined,
    recordSlashSend,
  };
}
