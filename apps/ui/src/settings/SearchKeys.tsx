import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { ChatController } from "../chat/controller";

/**
 * Where the web search engines' keys are kept (#11), under Sign-in: omp has no sign-in for most of them (TinyFish,
 * Keenable, Brave, Jina, Firecrawl), so this opens the Models dialog at Web search, which has them.
 */
export function SearchKeys({
  controller,
  onClose,
}: {
  readonly controller: ChatController | null;
  readonly onClose: () => void;
}): ReactNode {
  return (
    <section aria-label="Web search keys" className="mt-6">
      <h3 className="text-xs font-medium text-t3">Web search keys</h3>
      <div className="mt-2 flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-t2">
          {controller === null
            ? "Open a chat to set search engine keys: omp keeps them through a chat."
            : "Keys for omp's web search engines (TinyFish, Keenable, Brave, Jina, Firecrawl and the others), a test search for each, and the order omp tries them in."}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 max-sm:min-h-11 tablet:min-h-11"
          disabled={controller === null}
          onClick={() => {
            if (controller === null) return;
            onClose();
            controller.modelHubToggle.show("web");
          }}
        >
          Search engines…
        </Button>
      </div>
    </section>
  );
}
