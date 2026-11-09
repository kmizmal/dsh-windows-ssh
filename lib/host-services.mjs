/**
 * Read a host service from an agent context without declaring it in this plugin's `inject` list.
 *
 * A plain property read (`ctx.shell`) on a fiber-backed context proxy throws
 * `cannot get property "shell" without inject`, and optional chaining does not soften it —
 * the proxy's get trap throws before `?.` can apply. `ctx.get(name)` is the reflection path
 * that needs no inject declaration, which is how the host's own packages reach `fs`/`shell`.
 * A missing or inactive provider yields `undefined`, so callers keep failing closed.
 *
 * Plain object contexts (tests, embeddings) have no `get`; they are not proxies, so a plain
 * read is safe there and keeps that seam working.
 */
export function hostService(ctx, name) {
  if (!ctx) return undefined;
  if (typeof ctx.get === 'function') {
    try { return ctx.get(name); } catch { return undefined; }
  }
  try { return ctx[name]; } catch { return undefined; }
}
