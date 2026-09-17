import { Redis } from 'ioredis';
import type { PubSub, PubSubHandler } from './types.js';

export class RedisPubSub implements PubSub {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly handlers = new Map<string, Set<PubSubHandler>>();

  constructor(url: string) {
    this.pub = new Redis(url);
    this.sub = new Redis(url);
    this.sub.on('messageBuffer', (channelBuf: Buffer, message: Buffer) => {
      const channel = channelBuf.toString();
      const hs = this.handlers.get(channel);
      if (!hs) return;
      const data = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
      for (const h of hs) {
        try {
          h(data);
        } catch {
          /* ignore */
        }
      }
    });
  }

  async publish(channel: string, data: Uint8Array | string) {
    await this.pub.publish(channel, typeof data === 'string' ? data : Buffer.from(data));
  }

  async subscribe(channel: string, handler: PubSubHandler) {
    let hs = this.handlers.get(channel);
    if (!hs) {
      hs = new Set();
      this.handlers.set(channel, hs);
      await this.sub.subscribe(channel);
    }
    hs.add(handler);
    return async () => {
      const set = this.handlers.get(channel);
      set?.delete(handler);
      if (set && set.size === 0) {
        this.handlers.delete(channel);
        await this.sub.unsubscribe(channel);
      }
    };
  }

  async close() {
    await Promise.all([this.pub.quit(), this.sub.quit()]);
  }
}
