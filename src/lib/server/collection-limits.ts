// ponytail: shared in-process admission for the single server replica; use a shared limiter only when scaling replicas.
let active = 0;
const hosts = new Map<string, number>();
const queue: { host: string; admit: () => void }[] = [];
// ponytail: a linear scan avoids per-host queues; split queues only if measured pending volume makes scanning costly.
function drain() {
  for (let i = 0; i < queue.length && active < 9;) {
    const waiter = queue[i];
    if ((hosts.get(waiter.host) ?? 0) >= 2) {
      i++;
      continue;
    }
    queue.splice(i, 1);
    waiter.admit();
  }
}
export function acquireCollectionPermit(url: URL, signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      reject(signal!.reason);
      drain();
    };
    const waiter = {
      host,
      admit: () => {
        signal?.removeEventListener("abort", abort);
        active++;
        hosts.set(host, (hosts.get(host) ?? 0) + 1);
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          active--;
          const left = hosts.get(host)! - 1;
          if (left) hosts.set(host, left);
          else hosts.delete(host);
          drain();
        });
      },
    };
    signal?.addEventListener("abort", abort, { once: true });
    queue.push(waiter);
    drain();
  });
}
