/** Minimal typed event emitter. Listener errors are isolated so one broken
 *  subscriber (e.g. skin code) can't break the engine's event fan-out.
 *  Internally untyped; the public on/emit signatures carry the types. */
export class Emitter<M extends Record<string, unknown[]>> {
  private listeners = new Map<keyof M, Set<Function>>()

  on<K extends keyof M>(event: K, fn: (...args: M[K]) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(fn)
    return () => {
      set.delete(fn)
    }
  }

  emit<K extends keyof M>(event: K, ...args: M[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const fn of [...set]) {
      try {
        fn(...args)
      } catch (err) {
        console.error(`listener for '${String(event)}' threw`, err)
      }
    }
  }

  removeAll(): void {
    this.listeners.clear()
  }
}
