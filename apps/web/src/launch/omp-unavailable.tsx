import { LogHint } from "./log-hint";

export interface OmpUnavailableScreenProps {
  /** Why omp cannot be used, in plain words, as the app server reports it. */
  readonly reason: string | undefined;
  /** omp runs but has no model set up: the screen says what to set up, not that omp is missing. */
  readonly noModel?: boolean;
}

/**
 * Shown instead of the app when the server could not use omp. Without omp no chat can open or
 * start, so the normal screen would look healthy and fail silently.
 */
export function OmpUnavailableScreen({ reason, noModel = false }: OmpUnavailableScreenProps) {
  if (noModel) return <NoModelScreen reason={reason} />;
  return (
    <main
      aria-labelledby="omp-unavailable-title"
      className="flex min-h-dvh items-center justify-center bg-background px-6 py-12 text-foreground"
      data-omp-unavailable="true"
    >
      <section className="w-full max-w-xl space-y-4 text-center">
        <h1 className="text-xl font-semibold tracking-tight" id="omp-unavailable-title">
          omp isn't available
        </h1>
        <p className="text-sm leading-relaxed" data-omp-reason="true">
          {reason ?? "omp app could not use omp."}
        </p>
        <p className="text-muted-foreground text-sm leading-relaxed">
          omp app needs omp installed. It looks on your PATH, in <code>~/.bun/bin</code> and in{" "}
          <code>~/.local/bin</code>. In a terminal, run <code>omp --version</code>. When that prints
          a version, quit omp app (Ctrl+C in its terminal) and start it again.
        </p>
        <LogHint />
      </section>
    </main>
  );
}

/** omp runs with no model set up: the screen says what to set up, not that omp is missing. */
function NoModelScreen({ reason }: { readonly reason: string | undefined }) {
  return (
    <main
      aria-labelledby="omp-unavailable-title"
      className="flex min-h-dvh items-center justify-center bg-background px-6 py-12 text-foreground"
      data-omp-unavailable="true"
    >
      <section className="w-full max-w-xl space-y-4 text-center">
        <h1 className="text-xl font-semibold tracking-tight" id="omp-unavailable-title">
          No model is set up yet
        </h1>
        <p className="text-sm leading-relaxed" data-omp-reason="true">
          {reason ?? "omp app could not use omp."}
        </p>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Set an API key environment variable, such as <code>ANTHROPIC_API_KEY</code>, or sign in to
          a provider: run <code>omp</code> in a terminal and use <code>/login</code>. Then quit omp
          app (Ctrl+C in its terminal), start it again, and reload this page.
        </p>
        <LogHint />
      </section>
    </main>
  );
}
