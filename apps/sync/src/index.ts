export { createSyncServer, type SyncConfig, type SyncDeps, type SyncServer } from './server.js';
export { gate, mustStripLock, type GateDecision } from './ws/gate.js';
export { LockService } from './locks/lock-service.js';
export {
  encodeSyncStep1,
  encodeSyncStep2,
  encodeUpdate,
  encodeAwarenessRaw,
  encodeRpcResult,
  encodeServerEvent,
  inspectAwarenessUpdate,
} from './ws/codec.js';
