import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { TranscriptTail, type TranscriptView } from "./controller";
import type { TranscriptFeed } from "./source";

/**
 * The transcript of one worker, kept current while the view is mounted. One tail lives for the whole
 * mount: a new reference for the same worker (a roster update) is handed to it, and a different worker
 * starts it over.
 */
export function useAgentTranscript(feed: TranscriptFeed): TranscriptView {
  const [tail] = useState(() => new TranscriptTail({ feed }));
  useLayoutEffect(() => {
    tail.setFeed(feed);
  }, [tail, feed]);
  useEffect(() => {
    tail.start();
    return () => {
      tail.stop();
    };
  }, [tail]);
  return useSyncExternalStore(tail.subscribe, tail.getView, tail.getView);
}
