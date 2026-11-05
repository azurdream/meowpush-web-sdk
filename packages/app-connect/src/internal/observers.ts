/** Observer failures never alter protocol state or become unhandled rejections. */
export function observe(callback: () => unknown): void {
  try { void Promise.resolve(callback()).catch(() => {}); } catch { /* caller-owned observer */ }
}
