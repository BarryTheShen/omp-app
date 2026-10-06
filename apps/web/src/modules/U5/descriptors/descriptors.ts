import type { Descriptor } from "@omp-app/contracts";

/** U5 owns the complete E3 todo exemplar, except no N1/S3 rows. */
export const U5Descriptors = [
  {
    kind: "command",
    id: "U5.todoCommand",
    owner: "U5",
    title: "Todo command and structured operations",
    covers: [
      "E3.todo-command",
      "E3.todo-append",
      "E3.todo-copy",
      "E3.todo-done",
      "E3.todo-drop",
      "E3.todo-edit",
      "E3.todo-export",
      "E3.todo-import",
      "E3.todo-rm",
      "E3.todo-start",
    ],
    requires: ["omp.ui"],
    slash: { name: "todo", source: "builtin" },
  },
  {
    kind: "panel",
    id: "U5.todo",
    owner: "U5",
    title: "Todo checklist and reminders",
    covers: ["E3.todo-checklist-panel", "E3.todo-reminder-panel"],
    requires: ["omp.ui"],
  },
] as const satisfies readonly Descriptor[];
