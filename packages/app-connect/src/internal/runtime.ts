export interface Runtime {
  window: Window;
  fetch: typeof fetch;
  now(): number;
  random(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export function browserRuntime(): Runtime {
  return {
    window,
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    random: () => Math.random(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer),
  };
}
