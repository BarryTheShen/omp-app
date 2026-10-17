import {
  AppFailure,
  FolderPath,
  type Rule,
  type RuleChanged,
  RuleDeleteArgs as RuleDeleteArgsSchema,
  type RuleListArgs,
  RuleListArgs as RuleListArgsSchema,
  RuleReadArgs as RuleReadArgsSchema,
  type RuleScope,
  RuleWriteArgs as RuleWriteArgsSchema,
} from "@omp-app/contracts";
import { act, cleanup, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OverlayHost } from "@/overlay";
import type { RuleStoreAdapter } from "../../ports";
import { useRulesController } from "../../rules/controller";

const folder = FolderPath.parse("/workspace/project");
const rule: Rule = {
  id: "release.md",
  name: "Release notes",
  scope: "project",
  content: "Keep release notes factual.",
  enabled: true,
  source: "project",
  revision: "file-r1",
};

interface FakeRuleState {
  scopeRevision: string;
  rule: Rule | undefined;
}

function adapter(
  overrides: Partial<RuleStoreAdapter> = {},
  state: FakeRuleState = { scopeRevision: "r1", rule },
): RuleStoreAdapter {
  const {
    list: listOverride,
    read: readOverride,
    write: writeOverride,
    delete: deleteOverride,
    subscribeChanged: subscribeOverride,
    ...otherOverrides
  } = overrides;
  const nextScopeRevision = () => `r${Number.parseInt(state.scopeRevision.slice(1), 10) + 1}`;
  const conflict = () =>
    new AppFailure({
      code: "conflict",
      message: "Rules changed elsewhere.",
      retryable: true,
    });
  return {
    list: vi.fn(async (args: RuleListArgs, options?: Parameters<RuleStoreAdapter["list"]>[1]) => {
      RuleListArgsSchema.parse(args);
      if (listOverride) return listOverride(args, options);
      const scopedRule = state.rule?.scope === args.scope ? state.rule : undefined;
      return {
        rules: scopedRule ? [scopedRule] : [],
        revision: state.scopeRevision,
      };
    }),
    read: vi.fn(
      async (
        args: Parameters<RuleStoreAdapter["read"]>[0],
        options?: Parameters<RuleStoreAdapter["read"]>[1],
      ) => {
        RuleReadArgsSchema.parse(args);
        if (readOverride) return readOverride(args, options);
        if (!state.rule) {
          throw new AppFailure({ code: "not_found", message: "Rule not found.", retryable: false });
        }
        return state.rule;
      },
    ),
    write: vi.fn(
      async (
        args: Parameters<RuleStoreAdapter["write"]>[0],
        options?: Parameters<RuleStoreAdapter["write"]>[1],
      ) => {
        RuleWriteArgsSchema.parse(args);
        if (args.expectedRevision !== state.scopeRevision) throw conflict();
        if (writeOverride) return writeOverride(args, options);
        if (!state.rule) {
          throw new AppFailure({ code: "not_found", message: "Rule not found.", retryable: false });
        }
        const previousRevision = state.scopeRevision;
        state.scopeRevision = nextScopeRevision();
        state.rule = {
          ...state.rule,
          content: args.content,
          enabled: args.enabled,
          revision: `file-${state.scopeRevision}`,
        };
        return { rule: state.rule, revision: state.scopeRevision, previousRevision };
      },
    ),
    delete: vi.fn(
      async (
        args: Parameters<RuleStoreAdapter["delete"]>[0],
        options?: Parameters<RuleStoreAdapter["delete"]>[1],
      ) => {
        RuleDeleteArgsSchema.parse(args);
        if (args.expectedRevision !== state.scopeRevision) throw conflict();
        if (deleteOverride) return deleteOverride(args, options);
        if (!state.rule) {
          throw new AppFailure({ code: "not_found", message: "Rule not found.", retryable: false });
        }
        state.rule = undefined;
        state.scopeRevision = nextScopeRevision();
        return { deleted: true as const, revision: state.scopeRevision };
      },
    ),
    subscribeChanged: vi.fn(
      (
        scope: { scope: RuleScope; folder: RuleListArgs["folder"] },
        listener: (change: RuleChanged) => void,
      ) => (subscribeOverride ? subscribeOverride(scope, listener) : () => undefined),
    ),
    ...otherOverrides,
  };
}

function wrapper({ children }: { readonly children: React.ReactNode }) {
  return <OverlayHost>{children}</OverlayHost>;
}

afterEach(() => cleanup());

describe("rules controller", () => {
  test("loads, filters and saves a rule through CAS", async () => {
    const store = adapter();
    const { result } = renderHook(
      () => useRulesController({ adapter: store, folder, open: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.state.rules).toHaveLength(1));
    await act(async () => result.current.actions.select(rule.id));
    act(() => result.current.actions.setDraft("Updated rule."));
    await act(async () => result.current.actions.save());
    expect(store.write).toHaveBeenCalledWith(
      expect.objectContaining({ id: rule.id, expectedRevision: "r1", content: "Updated rule." }),
      expect.anything(),
    );
    expect(result.current.state.error).toBeNull();
  });

  test("keeps the draft and refuses stale saves until Overwrite is confirmed", async () => {
    const state = { scopeRevision: "r1", rule };
    let emit: (() => void) | undefined;
    const store = adapter(
      {
        subscribeChanged: vi.fn((_scope, listener) => {
          emit = () => {
            state.scopeRevision = "r2";
            state.rule = { ...rule, content: "Newer rule from elsewhere.", revision: "file-r2" };
            listener({
              folder,
              scope: "project",
              id: rule.id,
              revision: "r2",
              reason: "filesystem",
            });
          };
          return () => undefined;
        }),
      },
      state,
    );
    const { result } = renderHook(
      () => useRulesController({ adapter: store, folder, open: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.state.rules).toHaveLength(1));
    await act(async () => result.current.actions.select(rule.id));
    act(() => result.current.actions.setDraft("Keep my draft."));
    act(() => emit?.());
    await waitFor(() => expect(result.current.state.conflict).toBe(true));
    expect(result.current.state.draft).toBe("Keep my draft.");
    expect(result.current.state.revision).toBe("r2");

    await act(async () => result.current.actions.save());
    expect(store.write).not.toHaveBeenCalled();
    await act(async () => result.current.actions.keepDraft());
    expect(result.current.state.draftKept).toBe(true);
    await act(async () => result.current.actions.save());
    expect(store.write).not.toHaveBeenCalled();

    let overwrite: Promise<void> | undefined;
    act(() => {
      overwrite = result.current.actions.overwrite();
    });
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Overwrite rule" }));
      await overwrite;
    });
    expect(store.write).toHaveBeenCalledWith(
      expect.objectContaining({
        id: rule.id,
        content: "Keep my draft.",
        expectedRevision: "r2",
      }),
      expect.anything(),
    );
    expect(result.current.state.conflict).toBe(false);
    expect(result.current.state.draftDirty).toBe(false);
    expect(result.current.state.rules[0]?.content).toBe("Keep my draft.");
  });
  test("uses a null folder for global rules and the project folder otherwise", async () => {
    const store = adapter();
    const { result } = renderHook(
      () => useRulesController({ adapter: store, folder, open: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.state.rules).toHaveLength(1));
    await act(async () => result.current.actions.setScope("global"));
    await waitFor(() =>
      expect(store.list).toHaveBeenCalledWith({ folder: null, scope: "global" }, expect.anything()),
    );
    await act(async () => result.current.actions.setScope("project"));
    await waitFor(() =>
      expect(store.list).toHaveBeenCalledWith({ folder, scope: "project" }, expect.anything()),
    );
  });

  test("keeps a dirty draft across an external change and reloads the newer file", async () => {
    let revision = "r1";
    let emit: (() => void) | undefined;
    const store = adapter({
      list: vi.fn(async () => ({
        rules: [
          {
            ...rule,
            content: revision === "r1" ? rule.content : "Newer rule content.",
            revision: revision === "r1" ? "r1-file" : "r2-file",
          },
        ],
        revision,
      })),
      read: vi.fn(async () => ({ ...rule, content: "Newer rule content.", revision: "r2-file" })),
      subscribeChanged: vi.fn((_scope, listener) => {
        emit = () => {
          revision = "r2";
          listener({
            folder,
            scope: "project",
            id: rule.id,
            revision: "r2",
            reason: "filesystem",
          });
        };
        return () => undefined;
      }),
    });
    const { result } = renderHook(
      () => useRulesController({ adapter: store, folder, open: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.state.rules).toHaveLength(1));
    await act(async () => result.current.actions.select(rule.id));
    act(() => result.current.actions.setDraft("Keep my draft."));
    act(() => emit?.());
    await waitFor(() => expect(result.current.state.conflict).toBe(true));
    expect(result.current.state.draft).toBe("Keep my draft.");
    await act(async () => result.current.actions.reloadSelected());
    expect(result.current.state.draft).toBe("Newer rule content.");
    expect(result.current.state.fileRevision).toBe("r2-file");
    expect(result.current.state.revision).toBe("r2");
    expect(result.current.state.conflict).toBe(false);
  });

  test("keeps action errors inline and clears saving after close aborts a write", async () => {
    const deferred = Promise.withResolvers<{
      readonly rule: Rule;
      readonly revision: string;
      readonly previousRevision: string;
    }>();
    const store = adapter({
      write: vi.fn(() => deferred.promise),
    });
    const { result } = renderHook(
      () => useRulesController({ adapter: store, folder, open: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.state.rules).toHaveLength(1));
    await act(async () => result.current.actions.select(rule.id));
    act(() => result.current.actions.setDraft("Draft while saving."));
    act(() => void result.current.actions.save());
    await waitFor(() => expect(result.current.state.saving).toBe(true));
    act(() => result.current.actions.close());
    act(() => result.current.actions.open());
    expect(result.current.state.saving).toBe(false);
    deferred.resolve({
      rule: { ...rule, content: "Draft while saving.", revision: "r2-file" },
      revision: "r2",
      previousRevision: "r1",
    });
  });

  test("uses the scope revision for delete after reloading a newer file", async () => {
    const store = adapter({
      read: vi.fn(async () => ({ ...rule, content: "Reloaded rule.", revision: "file-r2" })),
    });
    const { result } = renderHook(
      () => useRulesController({ adapter: store, folder, open: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.state.rules).toHaveLength(1));
    await act(async () => result.current.actions.select(rule.id));
    await act(async () => result.current.actions.reloadSelected());
    expect(result.current.state.revision).toBe("r1");
    let removing: Promise<void> | undefined;
    act(() => {
      removing = result.current.actions.remove();
    });
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete rule" }));
      await removing;
    });
    expect(store.delete).toHaveBeenCalledWith(
      expect.objectContaining({ folder, scope: "project", expectedRevision: "r1" }),
      expect.anything(),
    );
  });
});
