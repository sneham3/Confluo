export { useCollabDoc, type UseCollabDocResult } from './use-collab-doc';
export { createCollabDoc, acquireCollabDoc, type CollabDocHandle } from './collab-doc';
export { SaveController, type SaveControllerOptions, type SaveState } from './save-controller';
export { UploadManager, type UploadManagerOptions } from './upload-manager';
export { createCollabEditorExtensions, type CollabExtensionOptions } from './extensions';
export { TicketedWebsocketProvider, type TicketedProviderOptions } from './provider';
export {
  LockManager,
  softLockPlugin,
  softLockKey,
  selectionBlocks,
  transactionBlocks,
  transactionDamagedBlocks,
  blocksInRange,
  isRemoteTransaction,
  type LockManagerOptions,
  type LockRpc,
} from './soft-lock';
export { anchorFromSelection, resolveAnchor, blockRange, blockIdAt, encodeRelativePositionAt } from './anchors';
export { ImageNodeView, type ImageNodeViewOptions } from './image-node-view';
export { Awareness } from 'y-protocols/awareness';
export {
  ApiError,
  isApiError,
  type ApiClient,
  type RequestInitLite,
  type Peer,
  type LockHolder,
  type ConnectionState,
  type DeniedReason,
  type ConnectionLogEntry,
  type ServerEvent,
  type CollabUser,
  type CollabDocOptions,
  type CollabSnapshot,
  type CommentAnchor,
  type TicketResponse,
} from './types';
