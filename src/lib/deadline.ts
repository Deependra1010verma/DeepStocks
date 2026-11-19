/** Bound even providers that fail to settle after their AbortSignal fires. */
export class DeadlineError extends Error {
  constructor(message = 'Operation deadline exceeded') { super(message); this.name = 'TimeoutError'; }
}

export function beforeDeadline<T>(work: () => PromiseLike<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted || Date.now() >= deadline) { reject(new DeadlineError()); return; }
    const finish = (fn: () => void) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(); };
    const abort = () => finish(() => reject(new DeadlineError()));
    const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(work).then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

export function assertTimeRemaining(deadline: number, signal?: AbortSignal): void {
  if (signal?.aborted || Date.now() >= deadline) throw new DeadlineError();
}
