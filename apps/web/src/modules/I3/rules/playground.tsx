import { AppFailure, FolderPath } from "@omp-app/contracts";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { OverlayHost } from "@/overlay";
import type { RuleStoreAdapter } from "../ports";
import { useRulesController } from "./controller";
import { RulesPanel } from "./panel";

const root = document.getElementById("i3-3-rules-playground-root");
if (!root) throw new Error("The I3.3 rules playground root is missing.");
const folder = FolderPath.parse("/workspace/project");

function fakeAdapter(): RuleStoreAdapter {
  let rule = {
    id: "release.md" as const,
    name: "Release notes",
    scope: "project" as const,
    content: "Keep release notes factual.",
    enabled: true,
    source: "project" as const,
    revision: "file-r1",
  };
  let scopeRevision = "scope-r1";
  let deleted = false;
  let conflict = true;
  let deleteFailure = true;
  const validateScope = (scope: "global" | "project", requestedFolder: string | null) => {
    if (scope === "global" ? requestedFolder !== null : requestedFolder === null) {
      throw new AppFailure({
        code: "invalid_args",
        message: "The rule scope and folder do not match.",
        retryable: false,
      });
    }
  };
  return {
    list: async (args) => {
      validateScope(args.scope, args.folder);
      return { rules: deleted ? [] : [rule], revision: scopeRevision };
    },
    read: async (args) => {
      validateScope(args.scope, args.folder);
      return rule;
    },
    write: async (args) => {
      validateScope(args.scope, args.folder);
      if (args.expectedRevision !== scopeRevision) {
        throw new AppFailure({
          code: "conflict",
          message: "Rule files changed; reload before saving.",
          retryable: true,
        });
      }
      if (conflict) {
        conflict = false;
        scopeRevision = "scope-r2";
        rule = { ...rule, content: "Newer rule from elsewhere.", revision: "file-r2" };
        throw new AppFailure({
          code: "conflict",
          message: "Rule changed elsewhere.",
          retryable: true,
        });
      }
      rule = { ...rule, content: args.content, enabled: args.enabled, revision: "file-r3" };
      const previousRevision = scopeRevision;
      scopeRevision = "scope-r3";
      return { rule, revision: scopeRevision, previousRevision };
    },
    delete: async (args) => {
      validateScope(args.scope, args.folder);
      if (args.expectedRevision !== scopeRevision) {
        throw new AppFailure({
          code: "conflict",
          message: "Rule files changed; reload before deleting.",
          retryable: true,
        });
      }
      if (deleteFailure) {
        deleteFailure = false;
        throw new AppFailure({
          code: "internal",
          message: "Rule could not be deleted.",
          retryable: true,
        });
      }
      deleted = true;
      scopeRevision = "scope-r4";
      return { deleted: true as const, revision: scopeRevision };
    },
    subscribeChanged: () => () => undefined,
  };
}

function Playground() {
  const adapter = useMemo(() => fakeAdapter(), []);
  const controller = useRulesController({ adapter, folder, open: true });
  return <RulesPanel controller={controller} />;
}

createRoot(root).render(
  <OverlayHost>
    <Playground />
  </OverlayHost>,
);
