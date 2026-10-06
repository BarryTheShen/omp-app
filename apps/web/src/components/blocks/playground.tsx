import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { EmptyState, InlineError, ListRow, Panel, Section, SettingRow, Toolbar } from "./index";

function Playground() {
  const [retryCount, setRetryCount] = useState(0);
  const [refreshCount, setRefreshCount] = useState(0);
  const [theme, setTheme] = useState("System");
  const [enabled, setEnabled] = useState(true);
  const [selectedSession, setSelectedSession] = useState("Recent project session");
  const [savedMessage, setSavedMessage] = useState("Applied");
  const [showEmpty, setShowEmpty] = useState(true);

  return (
    <main
      className="bg-background text-foreground min-h-screen space-y-6 p-6"
      data-testid="ui-blocks-playground"
    >
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">UI building blocks</h1>
        <p className="text-muted-foreground text-sm">
          Shared panel, section, row, toolbar, empty-state, and inline-error views.
        </p>
      </header>

      <div className="min-w-0 space-y-6">
        <Panel
          title="Session details"
          titleId="blocks-panel-title"
          description="Recent activity and actions"
          actions={
            <Toolbar ariaLabel="Panel actions">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRefreshCount((count) => count + 1)}
              >
                Refresh
              </Button>
            </Toolbar>
          }
          footer={
            <span className="text-muted-foreground text-xs">Refresh count: {refreshCount}</span>
          }
        >
          <p>Panel body stays in its own scroll region.</p>
          <p className="text-muted-foreground mt-2 text-sm">Panel content.</p>
        </Panel>

        <Section
          heading="Appearance"
          description="Theme controls share this section heading and spacing."
          actions={<span className="text-muted-foreground text-xs">{savedMessage}</span>}
        >
          <SettingRow
            title="Color theme"
            description="Preview light, dark, or system before saving."
          >
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setTheme((current) =>
                  current === "System" ? "Dark" : current === "Dark" ? "Light" : "System",
                )
              }
            >
              {theme}
            </Button>
          </SettingRow>
          <SettingRow
            title="A long setting label that wraps onto a second line when the viewport narrows"
            detail="Source: project · overrides default"
          >
            <Button type="button" variant="outline" onClick={() => setEnabled((value) => !value)}>
              {enabled ? "Enabled" : "Disabled"}
            </Button>
          </SettingRow>
        </Section>

        <Section heading="Sessions" variant="plain" headingLevel={3}>
          <div className="space-y-1">
            <ListRow
              title="Recent project session"
              detail="Updated today · main"
              selected={selectedSession === "Recent project session"}
              tabIndex={0}
              onSelect={() => setSelectedSession("Recent project session")}
            />
            <ListRow
              title="Unavailable session"
              detail="Read-only"
              selected={selectedSession === "Unavailable session"}
              disabled
              onSelect={() => setSelectedSession("Unavailable session")}
            />
          </div>
        </Section>

        <Toolbar ariaLabel="Settings actions" alignment="end">
          <Button
            type="button"
            variant="outline"
            onClick={() => setSavedMessage("Changes discarded")}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => setSavedMessage("Changes saved")}>
            Save changes
          </Button>
        </Toolbar>

        {showEmpty ? (
          <EmptyState
            title="No sessions in this folder"
            hint="Start a new chat to create an omp session."
            action={
              <Button type="button" size="sm" onClick={() => setShowEmpty(false)}>
                New chat
              </Button>
            }
          />
        ) : (
          <p className="text-muted-foreground text-center text-sm" role="status">
            A new session is ready.
          </p>
        )}

        <InlineError
          message={`Unable to load the session list. Retry count: ${retryCount}`}
          onRetry={() => setRetryCount((count) => count + 1)}
        />
      </div>
    </main>
  );
}

const root = document.getElementById("ui-blocks-root");
if (!root) throw new Error("UI blocks playground root is missing.");
createRoot(root).render(<Playground />);
