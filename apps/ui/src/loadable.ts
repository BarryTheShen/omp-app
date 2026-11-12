import { type ComponentType, createElement, type ReactNode, use } from "react";

/**
 * A component whose code loads when it is first wanted, or earlier with `preload`, and that draws at once once its code
 * is there. `React.lazy` suspends at its first draw even when its code was loaded long before (it learns so from a
 * promise, a moment later), and React then shows a suspended boundary's content no sooner than 300 ms after its
 * fallback (`FALLBACK_THROTTLE_MS` in react-dom 19): every first open of a preloaded page waited that long. This one
 * suspends only while its code is really loading. Like `lazy`, a load that failed stays failed.
 */
export function loadable<P extends object>(
  load: () => Promise<ComponentType<P>>,
): {
  readonly Component: (props: P) => ReactNode;
  readonly preload: () => Promise<ComponentType<P>>;
} {
  let loaded: ComponentType<P> | undefined;
  let loading: Promise<ComponentType<P>> | undefined;
  const preload = (): Promise<ComponentType<P>> => {
    loading ??= load().then((component) => {
      loaded = component;
      return component;
    });
    return loading;
  };
  const Component = (props: P): ReactNode => createElement(loaded ?? use(preload()), props);
  return { Component, preload };
}
