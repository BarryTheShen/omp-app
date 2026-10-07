import { createRoot } from "react-dom/client";
import "../../index.css";
import { HubCard } from "./hub";
import { recorded } from "./recorded-props";
import { TaskCard } from "./task";
import { WaitCard } from "./wait";

/** The T5 cards on recorded omp results: messages, jobs, the roster, a service log and background agents. */
function Playground() {
  return (
    <main className="min-h-screen bg-background text-foreground" data-testid="t5-playground">
      <header className="border-border bg-card border-b px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">T5 coordination and task cards</h1>
        <p className="text-muted-foreground text-sm">
          Messages, background jobs, the agent roster, a service log and background agents, from
          recorded omp results
        </p>
      </header>
      <section className="mx-auto grid w-full max-w-3xl gap-6 px-6 py-12">
        <WaitCard rendererProps={recorded("wait: two running tasks and a finished command")} />
        <HubCard rendererProps={recorded("hub: the agents in the roster")} />
        <TaskCard rendererProps={recorded("task: two reviewers started in the background")} />
      </section>
    </main>
  );
}

const root = document.getElementById("t5-playground-root");
if (!root) throw new Error("The T5 playground root is missing.");
createRoot(root).render(<Playground />);
