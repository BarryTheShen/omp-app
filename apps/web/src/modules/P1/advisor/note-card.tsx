import type { AdvisorNote } from "../contract";
import { advisorNoteView, noteSeverityClass } from "./model";

export interface AdvisorNoteCardProps {
  readonly note: AdvisorNote;
  readonly className?: string;
}

/** Renders one delayed advisor note with the age omp attached to that note. */
function AdvisorNoteCard({ note, className }: AdvisorNoteCardProps) {
  const view = advisorNoteView(note);
  return (
    <article
      className={`rounded-lg border px-3 py-2 ${noteSeverityClass(note.severity)} ${className ?? ""}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <strong>{view.severityLabel}</strong>
        {view.advisorLabel ? (
          <span className="text-muted-foreground">From {view.advisorLabel}</span>
        ) : null}
        {view.ageLabel ? <span className="text-muted-foreground">{view.ageLabel}</span> : null}
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm">{view.text}</p>
    </article>
  );
}

export interface AdvisorNoteListProps {
  readonly notes: readonly AdvisorNote[];
  readonly emptyLabel?: string;
}

function AdvisorNoteList({ notes, emptyLabel = "No advisor notes yet." }: AdvisorNoteListProps) {
  if (notes.length === 0) return <p className="text-muted-foreground text-sm">{emptyLabel}</p>;
  return (
    <section className="space-y-2" aria-label="Advisor notes">
      {notes.map((note) => (
        <AdvisorNoteCard
          key={`${note.turn ?? "current"}:${note.advisor ?? "default"}:${note.note}`}
          note={note}
        />
      ))}
    </section>
  );
}

export { AdvisorNoteCard, AdvisorNoteList };
