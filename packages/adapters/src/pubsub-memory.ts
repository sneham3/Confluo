import type { PubSub, PubSubHandler } from './types.js';

/** In-process pub/sub. Delivery is asynchronous (next tick) to mimic a network bus. */
export class MemoryPubSub implements PubSub {
  private readonly channels = new Map<string, Set<PubSubHandler>>();

  async publish(channel: string, data: Uint8Array | string) {
    const subs = this.channels.get(channel);
    if (!subs || subs.size === 0) return;
    const copy = typeof data === 'string' ? data : new Uint8Array(data);
    for (const h of subs) {
      queueMicrotask(() => {
        try {
          h(copy);
        } catch {
          /* subscriber errors never break the bus */
        }
      });
    }
  }

  async subscribe(channel: string, handler: PubSubHandler) {
    let subs = this.channels.get(channel);
    if (!subs) {
      subs = new Set();
      this.channels.set(channel, subs);
    }
    subs.add(handler);
    return async () => {
      subs!.delete(handler);
      if (subs!.size === 0) this.channels.delete(channel);
    };
  }

  async close() {
    this.channels.clear();
  }
}
