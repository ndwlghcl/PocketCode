import type { KVStorage } from '../native';

const queues = new WeakMap<KVStorage, Promise<unknown>>();
/** 读改写放进同一队列；失败不让后续操作永久卡住。 */
export function localTransaction<T>(storage: KVStorage, operation: () => Promise<T>): Promise<T> {
  const run = (queues.get(storage) ?? Promise.resolve()).then(operation, operation);
  queues.set(storage, run);
  void run.finally(() => { if (queues.get(storage) === run) queues.delete(storage); }).catch(() => undefined);
  return run;
}
