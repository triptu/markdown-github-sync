/** Stored on the host, rather than in module state, so a new plugin bundle joins the same queue. */
const queueKey = Symbol.for("github-vault-sync.serial-queues.v1");
interface Queue { tail: Promise<unknown> }
function isQueue(value: unknown): value is Queue {
  return typeof value === "object" && value !== null && Reflect.get(value, "tail") instanceof Promise;
}
function queueFor(host: object, key: string): Queue {
  let queues: unknown = Reflect.get(host, queueKey);
  if (queues === undefined) {
    queues = new Map<string, Queue>();
    Object.defineProperty(host, queueKey, { value: queues });
  }
  if (!(queues instanceof Map)) throw new Error("Invalid sync ownership registry");
  let queue: unknown = queues.get(key);
  if (queue === undefined) {
    queue = { tail: Promise.resolve() };
    queues.set(key, queue);
  }
  if (!isQueue(queue)) throw new Error("Invalid sync queue");
  return queue;
}
export function serialize<T>(host: object, key: string, task: () => Promise<T>): Promise<T> {
  const queue = queueFor(host, key);
  const result = queue.tail.then(task, task);
  queue.tail = result.catch(() => undefined);
  return result;
}
const ownerKey = Symbol.for("github-vault-sync.owner.v1");
const eventsKey = Symbol.for("github-vault-sync.local-events.v1");
interface LocalRename { id: number; from: string; to: string }
interface LocalEvents { observed: number; persisted: number; renames: LocalRename[] }
function isEvents(value: unknown): value is LocalEvents {
  if (typeof value !== "object" || value === null) return false;
  const observed: unknown = Reflect.get(value, "observed"), persisted: unknown = Reflect.get(value, "persisted");
  const renames: unknown = Reflect.get(value, "renames");
  return typeof observed === "number" && Number.isSafeInteger(observed) && observed >= 0 &&
    typeof persisted === "number" && Number.isSafeInteger(persisted) && persisted >= 0 && persisted <= observed &&
    Array.isArray(renames) && renames.every((rename: unknown) =>
      typeof rename === "object" && rename !== null && Number.isSafeInteger(Reflect.get(rename, "id")) &&
      typeof Reflect.get(rename, "from") === "string" && typeof Reflect.get(rename, "to") === "string");

}
export class PluginOwnership {
  private retired = false;
  private admitted = new Set<Promise<unknown>>();
  private events: LocalEvents;
  constructor(private host: object) {
    let events: unknown = Reflect.get(host, eventsKey);
    if (events === undefined) {
      events = { observed: 0, persisted: 0, renames: [] };
      Object.defineProperty(host, eventsKey, { value: events });
    }
    if (!isEvents(events)) throw new Error("Invalid local event registry");
    this.events = events;
    const prior: unknown = Reflect.get(host, ownerKey);
    if (prior !== undefined) {
      if (typeof prior !== "object" || prior === null || typeof Reflect.get(prior, "retire") !== "function")
        throw new Error("Invalid sync owner");
      Reflect.apply(Reflect.get(prior, "retire"), prior, []);
    }
    Reflect.set(host, ownerKey, this);
  }
  recordRename(from: string, to: string): void {
    this.assertActive();
    this.events.renames.push({ id: this.events.observed + 1, from, to });
  }
  hasPendingRenames(): boolean { return this.events.renames.length > 0; }
  pendingRenames(): readonly LocalRename[] { return this.events.renames.slice(); }
  acknowledgeRename(id: number): void {
    if (this.events.renames[0]?.id !== id) throw new Error("Rename ownership changed.");
    this.events.renames.shift();
  }
  recordLocalChange(): number {
    this.assertActive();
    return ++this.events.observed;
  }
  pendingLocalChange(): number | null {
    return this.events.observed > this.events.persisted ? this.events.observed : null;
  }
  acknowledgeLocalChange(revision: number): void {
    this.events.persisted = Math.max(this.events.persisted, revision);
  }
  assertActive(): void {
    if (this.retired || Reflect.get(this.host, ownerKey) !== this)
      throw new Error("This sync instance has retired. Reopen the plugin to continue.");
  }
  run<T>(task: () => Promise<T>): Promise<T> {
    return serialize(this.host, "plugin-lifetime", async () => {
      this.assertActive();
      return task();
    });
  }
  /** Drain work whose synchronous admission already happened (notably event invalidation). */
  track<T>(pending: Promise<T>, after?: () => Promise<void>): Promise<T> {
    this.admitted.add(pending);
    void pending.then(() => this.admitted.delete(pending), () => this.admitted.delete(pending));
    const settled = pending.then(
      value => ({ kind: "completed" as const, value }),
      error => ({ kind: "failed" as const, error }),
    );
    return serialize(this.host, "plugin-lifetime", async () => {
      const result = await settled;
      this.assertActive();
      if (result.kind === "failed") throw result.error;
      await after?.();
      return result.value;
    });
  }
  async drainAdmissions(): Promise<void> {
    while (this.admitted.size) await Promise.all([...this.admitted]);
    this.assertActive();
  }
  /** Obsidian does not await onunload. Successors wait on this same queue themselves. */
  retire(): Promise<unknown> {
    this.retired = true;
    return queueFor(this.host, "plugin-lifetime").tail;
  }
  fence<T extends object>(port: T): T {
    return new Proxy(port, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          this.assertActive();
          return Reflect.apply(value, target, args);
        };
      },
    });
  }
  queued<T extends object>(api: T, current: () => boolean): T {
    return new Proxy(api, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (key === "notifyLocalChange") return (...args: unknown[]) => {
          this.assertActive();
          if (!current()) throw new Error("Sync configuration changed. Reopen this preview.");
          const revision = this.recordLocalChange();
          const pending = Promise.resolve(Reflect.apply(value, target, args)).then((result: unknown) => {
            if (typeof result === "object" && result !== null && ["invalidated", "unenrolled"].includes(Reflect.get(result, "kind")))
              this.acknowledgeLocalChange(revision);
            return result;
          });
          return this.track(pending);
        };
        return (...args: unknown[]) => this.run(async () => {
          if (!current()) throw new Error("Sync configuration changed. Reopen this preview.");
          return Reflect.apply(value, target, args);
        });
      },
    });
  }
}
