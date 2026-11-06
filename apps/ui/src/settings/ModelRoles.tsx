import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { ChatController } from "../chat/controller";

/**
 * The Model tab's first part (#2838): which model each of omp's roles uses is set in omp's model panel (Alt+M), not in
 * the rows below. Its button closes Settings and opens the panel at the chat's role, as the model menu's "Roles and
 * models…" does.
 */
export function ModelRoles({
  controller,
  onClose,
}: {
  readonly controller: ChatController | null;
  readonly onClose: () => void;
}): ReactNode {
  return (
    <section aria-label="Roles and models" className="mt-6">
      <h3 className="text-xs font-medium text-t3">Roles and models</h3>
      <div className="mt-2 flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-t2">
          {controller === null
            ? "Open a chat to set omp's roles: its model panel reads them in the chat's folder."
            : "Which model each of omp's roles uses (default, slow, smol, …) and at which thinking level, for this project or everywhere."}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 max-sm:min-h-11 tablet:min-h-11"
          disabled={controller === null}
          onClick={() => {
            if (controller === null) return;
            onClose();
            controller.modelHubToggle.show(controller.store.getSnapshot().role ?? "default");
          }}
        >
          Roles and models…
        </Button>
      </div>
    </section>
  );
}
