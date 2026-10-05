import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

export type AnnouncementLevel = "polite" | "assertive";
export type Announce = (message: string, level?: AnnouncementLevel) => void;

type Announcement = { readonly message: string; readonly revision: number };

const AnnounceContext = createContext<Announce | null>(null);

function LiveRegion({
  level,
  announcement,
}: {
  readonly level: AnnouncementLevel;
  readonly announcement: Announcement | null;
}) {
  return (
    <div
      aria-atomic="true"
      aria-live={level}
      className="sr-only"
      data-a11y-live-region={level}
      role={level === "assertive" ? "alert" : "status"}
    >
      {announcement?.message ?? ""}
    </div>
  );
}

export function AnnounceProvider({ children }: { readonly children: ReactNode }) {
  const [polite, setPolite] = useState<Announcement | null>(null);
  const [assertive, setAssertive] = useState<Announcement | null>(null);
  const revision = useRef(0);
  const announce = useCallback<Announce>((message, level = "polite") => {
    const trimmed = message.trim();
    if (trimmed.length === 0) return;
    revision.current += 1;
    const announcement = { message: trimmed, revision: revision.current };
    if (level === "assertive") setAssertive(announcement);
    else setPolite(announcement);
  }, []);
  const contextValue = useMemo(() => announce, [announce]);

  return (
    <AnnounceContext.Provider value={contextValue}>
      {children}
      <LiveRegion announcement={polite} level="polite" />
      <LiveRegion announcement={assertive} level="assertive" />
    </AnnounceContext.Provider>
  );
}

export function useAnnounce(): Announce {
  const announce = useContext(AnnounceContext);
  if (announce === null) throw new Error("useAnnounce must be used inside AnnounceProvider");
  return announce;
}

/** U0's single accessibility host: live announcements plus the shared baseline CSS. */
export function AccessibilityProvider({ children }: { readonly children: ReactNode }) {
  return <AnnounceProvider>{children}</AnnounceProvider>;
}
