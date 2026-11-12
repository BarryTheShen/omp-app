import type { AppClient } from "@omp-app/client";
import { ChevronRight, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { ServerSection } from "../desktop/ServerSection";
import { KeyList } from "../palette/Shortcuts";
import { usePhone } from "../phone";
import { ThemeGallery } from "../theme/ThemeGallery";
import { ThemeSwitch } from "../theme/ThemeSwitch";
import { DebugLog } from "./DebugLog";
import { Devices } from "./Devices";
import { QuickPromptsSection } from "./QuickPromptsSection";

/**
 * The app's own settings, before omp's tabs: how it looks, a phone's quick prompts, the server it is connected to, the
 * devices paired with it, its debug log, and its keys; on a phone also What's new, which a desktop has at the list's
 * foot.
 * `focusServerLink` puts the cursor in the desktop window's field for another server's link.
 */
export function AppPage({
  client,
  focusServerLink,
  onWhatsNew,
}: {
  readonly client: AppClient;
  readonly focusServerLink: boolean;
  readonly onWhatsNew: () => void;
}): ReactNode {
  const phone = usePhone();
  return (
    <section aria-label="App settings">
      <p className="pt-5 text-xs text-t3">App</p>
      <h2 className="mt-1 text-lg font-medium text-t1">App</h2>
      <p className="mt-1 text-sm text-t2">
        How this app looks, the server it is connected to, the devices paired with it, its debug
        log, and its keys.
      </p>
      {phone && (
        <button
          type="button"
          data-tour="whats-new-button"
          className="mt-4 flex h-13 w-full items-center gap-3 rounded-lg border border-l2 px-3 text-left text-base text-t1"
          onClick={onWhatsNew}
        >
          <Sparkles aria-hidden="true" className="size-4 text-t2" />
          <span className="min-w-0 flex-1">What's new</span>
          <ChevronRight aria-hidden="true" className="size-4 text-t3" />
        </button>
      )}
      <h3 className="mt-6 text-xs font-medium text-t3">Look</h3>
      <div className="flex items-center gap-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-t1">Theme</p>
          <p className="mt-0.5 text-xs text-t3">
            Match the system, or always light or dark. Light and Dark are the themes you pick below;
            point at one to see the app in it.
          </p>
        </div>
        <ThemeSwitch />
      </div>
      <div className="border-b border-l1 pb-5">
        <ThemeGallery />
      </div>
      {phone && <QuickPromptsSection />}
      <ServerSection focusLink={focusServerLink} />
      <Devices client={client} />
      <DebugLog client={client} />
      <h3 className="mt-6 mb-3 text-xs font-medium text-t3">Keys</h3>
      <KeyList />
    </section>
  );
}
