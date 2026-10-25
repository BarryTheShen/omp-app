import { describe, expect, test } from "vitest";
import {
  SECURITY_ACTIONS,
  type SecurityActionId,
  securityActionOf,
  securityRequestOf,
} from "./actions";

describe("the security actions", () => {
  test("lists the eleven subcommands of omp's /security, in omp's order", () => {
    expect(SECURITY_ACTIONS.map((action) => action.id)).toEqual([
      "plan",
      "scan",
      "status",
      "cancel",
      "scans",
      "show",
      "import",
      "export",
      "validate",
      "compare",
      "disposition",
    ]);
  });

  test("asks before the actions that change something or spend model budget, and no others", () => {
    const asks = SECURITY_ACTIONS.filter((action) => action.confirmation !== undefined).map(
      (action) => action.id,
    );
    expect(asks).toEqual(["scan", "cancel", "import", "validate", "disposition"]);
  });

  test("every action that takes details gives a placeholder and a sentence of hint", () => {
    for (const action of SECURITY_ACTIONS) {
      if (action.details === "none") continue;
      expect(action.placeholder, action.id).toBeTruthy();
      expect(action.hint, action.id).toMatch(/\.$/);
    }
  });

  test("the disposition hint names the five statuses omp accepts", () => {
    const hint = securityActionOf("disposition").hint ?? "";
    for (const status of ["open", "false_positive", "accepted_risk", "fixed", "wont_fix"]) {
      expect(hint).toContain(status);
    }
  });

  test("looks an action up by id and refuses an id the catalog does not list", () => {
    expect(securityActionOf("compare").label).toBe("Compare two scans");
    expect(() => securityActionOf("nope" as "plan")).toThrow(
      "The security action nope is not in the catalog.",
    );
  });

  test("the plan hint names each option omp's plan reads", () => {
    const hint = securityActionOf("plan").hint ?? "";
    for (const option of [
      "--path",
      "--exclude",
      "--working-tree",
      "--diff",
      "--knowledge-base",
      "--output",
      "--archive-existing",
      "--credential",
    ]) {
      expect(hint, option).toContain(option);
    }
  });

  test("styles destructive only the actions that stop a scan or change stored findings", () => {
    const destructive = SECURITY_ACTIONS.filter(
      (action) => action.confirmation?.destructive === true,
    ).map((action) => action.id);
    expect(destructive).toEqual(["cancel", "import", "disposition"]);
    expect(securityActionOf("scan").confirmation?.destructive).toBe(false);
    expect(securityActionOf("validate").confirmation?.destructive).toBe(false);
  });
});

/** omp's own argument grammar for each subcommand, as its helper reads it (omp v18.12.6 slash-commands/helpers/security.ts). */
const OMP_GRAMMAR: readonly (readonly [SecurityActionId, string, string])[] = [
  ["plan", "", "plan"],
  ["plan", "--path src --exclude dist", "plan --path src --exclude dist"],
  ["plan", "--working-tree", "plan --working-tree"],
  ["plan", "--diff main HEAD", "plan --diff main HEAD"],
  ["plan", "--output out --archive-existing", "plan --output out --archive-existing"],
  ["plan", "--knowledge-base notes --credential 4", "plan --knowledge-base notes --credential 4"],
  ["scan", "", "scan"],
  ["scan", "secplan_1", "scan secplan_1"],
  ["status", "", "status"],
  ["status", "op-1", "status op-1"],
  ["cancel", "op-1", "cancel op-1"],
  ["scans", "", "scans"],
  ["show", "scan-1", "show scan-1"],
  ["show", "security://scans/scan-1/findings/f-1", "show security://scans/scan-1/findings/f-1"],
  ["import", "findings.sarif", "import findings.sarif"],
  [
    "export",
    "scan-1 --output out.sarif --format sarif",
    "export scan-1 --output out.sarif --format sarif",
  ],
  ["validate", "scan-1 f-1", "validate scan-1 f-1"],
  [
    "validate",
    "security://scans/scan-1/findings/f-1",
    "validate security://scans/scan-1/findings/f-1",
  ],
  ["compare", "scan-1 scan-2", "compare scan-1 scan-2"],
  ["disposition", "scan-1 f-1 fixed Patched in 2.1", "disposition scan-1 f-1 fixed Patched in 2.1"],
  ["disposition", "scan-1 f-1 open", "disposition scan-1 f-1 open"],
];

describe("securityRequestOf builds omp's command", () => {
  for (const [id, details, args] of OMP_GRAMMAR) {
    test(`${id} with "${details}" sends /security ${args}`, () => {
      expect(securityRequestOf(securityActionOf(id), details)).toEqual({
        request: { name: "security", args },
      });
    });
  }
});

describe("securityRequestOf", () => {
  test("sends the action and its trimmed details as one /security command", () => {
    const action = securityActionOf("status");
    expect(securityRequestOf(action, "  scan-42  ")).toEqual({
      request: { name: "security", args: "status scan-42" },
    });
  });

  test("sends the bare action when its details are optional and left empty", () => {
    expect(securityRequestOf(securityActionOf("scan"), "")).toEqual({
      request: { name: "security", args: "scan" },
    });
  });

  test("never sends details for an action that takes none", () => {
    expect(securityRequestOf(securityActionOf("scans"), "anything")).toEqual({
      request: { name: "security", args: "scans" },
    });
  });

  test("refuses a required action with no details, and says what is missing", () => {
    expect(securityRequestOf(securityActionOf("validate"), "   ")).toEqual({
      error: "Type the details this action needs.",
    });
  });

  test("refuses an empty cancel or export, which omp refuses without input", () => {
    for (const id of ["cancel", "export"] as const) {
      expect(securityRequestOf(securityActionOf(id), "")).toEqual({
        error: "Type the details this action needs.",
      });
    }
  });

  test("refuses details that span lines or hold control characters", () => {
    const action = securityActionOf("show");
    expect(securityRequestOf(action, "a\nb")).toEqual({ error: "Keep the details to one line." });
    expect(securityRequestOf(action, "a\u0007b")).toEqual({
      error: "Keep the details to one line.",
    });
  });

  test("refuses details longer than the limit", () => {
    expect(securityRequestOf(securityActionOf("show"), "x".repeat(301))).toEqual({
      error: "Keep the details under 300 characters.",
    });
    expect(securityRequestOf(securityActionOf("show"), "x".repeat(300))).toMatchObject({
      request: { name: "security" },
    });
  });
});
