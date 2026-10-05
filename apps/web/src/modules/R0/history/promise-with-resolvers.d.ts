/**
 * `Promise.withResolvers` (ES2024) runs on Bun/Vitest's engine today, but this package's shared
 * `lib` target is ES2023. Declare just the one static member locally instead of widening the
 * repo-wide lib (owned by U0) to a newer ECMAScript target.
 */
interface PromiseConstructor {
  withResolvers<T>(): {
    readonly promise: Promise<T>;
    readonly resolve: (value: T | PromiseLike<T>) => void;
    readonly reject: (reason?: unknown) => void;
  };
}
