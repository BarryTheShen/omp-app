import { useId } from "react";
import { EmptyState, ListRow, Section } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type { P4LabelsViewModel } from "./model";

export interface P4LabelsViewProps {
  readonly model: P4LabelsViewModel;
  /** False when the reason is already on screen elsewhere (the tree's notice), so it is not repeated. */
  readonly showReason?: boolean;
}

export function P4LabelsView({ model, showReason = true }: P4LabelsViewProps) {
  const editReasonId = useId();

  return (
    <Section description={model.summary} heading="Labels" headingLevel={3} variant="plain">
      {model.emptyMessage ? (
        <EmptyState
          title={model.emptyMessage}
          hint="Labels added in omp's terminal show up here."
          variant="compact"
        />
      ) : (
        <ul aria-label="Labels" className="flex min-w-0 list-none flex-col gap-1">
          {model.items.map((item) => (
            <li className="min-w-0" key={item.key}>
              <ListRow detail={item.detail ?? undefined} title={item.title} />
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex min-w-0 flex-col items-start gap-1 px-2">
        <Button
          aria-describedby={showReason ? editReasonId : undefined}
          disabled
          size="sm"
          title={showReason ? model.editDisabledReason : undefined}
          type="button"
          variant="outline"
        >
          Edit labels
        </Button>
        {showReason ? (
          <p className="text-muted-foreground text-xs" id={editReasonId}>
            {model.editDisabledReason}
          </p>
        ) : null}
      </div>
    </Section>
  );
}
