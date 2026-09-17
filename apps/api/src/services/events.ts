import type { PubSub } from '@confluo/adapters';
import type { ServerEventType } from '@confluo/shared';

export interface DocEvent {
  type: ServerEventType;
  payload: unknown;
}

/** Publish a JSON server event on `doc:{docId}:events` for the sync server to fan out. */
export async function publishDocEvent(pubsub: PubSub, docId: string, event: DocEvent): Promise<void> {
  await pubsub.publish(
    `doc:${docId}:events`,
    JSON.stringify({ type: event.type, payload: event.payload, ts: Date.now(), origin: 'api' }),
  );
}
