import type { AppClient } from "@omp-app/client";
import type { ReactNode } from "react";
import { ServerSection } from "../desktop/ServerSection";
import { KeyList } from "../palette/Shortcuts";
import { usePhone } from "../phone";
import { ThemeSwitch } from "../theme/ThemeSwitch";
import { Devices } from "./Devices";
import { QuickPromptsSection } from "./QuickPromptsSection";

/**
 * The app's own settings, before omp's tabs: how it looks, a phone's quick prompts, the server it is connected to, the
 * devices paired with it, and its keys. `focusServerLink` puts the cursor in the desktop window's field for another
 * server's link.
 */
export function AppPage({
  client,
  focusServerLink,
}: {
  readonly client: AppClient;
  readonly focusServerLink: boolean;
}): ReactNode {
  const phone = usePhone();
  return (
    <section aria-label="App settings">
      <p className="pt-5 text-xs text-t3">App</p>
      <h2 className="mt-1 text-lg font-medium text-t1">App</h2>
      <p className="mt-1 text-sm text-t2">
        How this app looks, the server it is connected to, the devices paired with it, and its keys.
      </p>
      <h3 className="mt-6 text-xs font-medium text-t3">Look</h3>
      <div className="flex items-center gap-4 border-b border-l1 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-t1">Theme</p>
          <p className="mt-0.5 text-xs text-t3">Match the system, or always light or dark.</p>
        </div>
        <ThemeSwitch />
      </div>
      {phone && <QuickPromptsSection />}
      <ServerSection focusLink={focusServerLink} />
      <Devices client={client} />
      <h3 className="mt-6 mb-3 text-xs font-medium text-t3">Keys</h3>
      <KeyList />
    </section>
  );
}
