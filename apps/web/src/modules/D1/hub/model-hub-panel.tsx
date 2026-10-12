import { useCallback, useMemo, useSyncExternalStore } from "react";
import { ModelHub, type ModelHubActions } from "./model-hub";
import type { ModelHubController } from "./model-hub-controller";

/**
 * Connects the model dialog's view to its controller: the view reads the controller's snapshot and calls
 * its actions. The controller is made when the dialog opens and disposed when it closes, so it keeps its
 * identity for as long as the dialog is open.
 */
export function ModelHubPanel({ controller }: { readonly controller: ModelHubController }) {
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(() => listener()),
    [controller],
  );
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
  const view = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const actions = useMemo<ModelHubActions>(
    () => ({
      selectScope: (scope) => controller.setScope(scope),
      setQuery: (query) => controller.setQuery(query),
      setSessionModel: (model) => void controller.setSessionModel(model),
      startRoleAssignment: (roleId) => controller.startRoleAssignment(roleId),
      startModelAssignment: (key) => controller.startModelAssignment(key),
      cancelAssignment: () => controller.cancelAssignment(),
      chooseModel: (model) => void controller.chooseModel(model),
      chooseRole: (roleId) => void controller.chooseRole(roleId),
      clearRole: (roleId) => void controller.clearRole(roleId),
      moveCycleRole: (roleId, direction) => void controller.moveCycleRole(roleId, direction),
      savePreset: (name) => void controller.savePreset(name),
      switchPreset: (name) => void controller.switchPreset(name),
      deletePreset: (name) => void controller.deletePreset(name),
      refreshModels: () => void controller.refreshModels(),
      dismissNotice: () => controller.dismissNotice(),
    }),
    [controller],
  );
  return <ModelHub view={view} actions={actions} />;
}
