/**
 * A test extension for the chat host's dialogs: `/dialogs <kind>` opens one of omp's dialogs through the host's UI
 * context and reports the answer omp got as a notice; `/dialogs show` sets a status, a widget, the title and the editor
 * text, and `/dialogs clear` clears that status and widget. Install it as `extensions/dialogs.ts` in a chat's agent folder,
 * with omp's own discovery on.
 */
export const DIALOGS_EXTENSION = `
export default function (pi) {
  pi.registerCommand("dialogs", {
    description: "Opens one dialog for the chat host's tests",
    handler: async (args, ctx) => {
      const report = (text) => ctx.ui.notify(text, "info");
      switch (args.trim()) {
        case "confirm":
          report("confirmed " + (await ctx.ui.confirm("Run the check?", "It takes a minute")));
          return;
        case "select":
          report("picked " + (await ctx.ui.select("Colour", ["red", { label: "blue", description: "like the sky" }], { initialIndex: 1 })));
          return;
        case "input":
          report("typed " + (await ctx.ui.input("Name", "your name")));
          return;
        case "editor":
          report("edited " + (await ctx.ui.editor("Message", "draft")));
          return;
        case "timeout":
          report("timed out with " + (await ctx.ui.select("Quick", ["a", "b"], { timeout: 300 })));
          return;
        case "approve":
          report("approved " + JSON.stringify(await ctx.ui.approve({
            full: "Run ls?",
            compact: "ls",
            session: "Approve for this session",
            grants: [{ scope: "folder", label: "Approve Directory: ~/src", alwaysLabel: "Always Approve Directory: ~/src" }],
          })));
          return;
        case "ask":
          if (!ctx.ui.askDialog) {
            report("no ask dialog");
            return;
          }
          report("asked " + JSON.stringify(await ctx.ui.askDialog([
            { id: "colour", question: "Which colour?", options: [{ label: "red" }, { label: "blue" }] },
          ])));
          return;
        case "show":
          ctx.ui.setStatus("build", "Running");
          ctx.ui.setWidget("build", ["step 1"]);
          ctx.ui.setTitle("Build");
          ctx.ui.setEditorText("draft text");
          report("shown");
          return;
        case "clear":
          ctx.ui.setStatus("build", undefined);
          ctx.ui.setWidget("build", undefined);
          report("cleared");
          return;
      }
    },
  });
}
`;
