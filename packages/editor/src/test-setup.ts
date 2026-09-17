import 'fake-indexeddb/auto';

// happy-dom lacks a few APIs ProseMirror touches.
if (typeof document !== 'undefined') {
  const proto = (globalThis as unknown as { Range?: { prototype: Record<string, unknown> } }).Range?.prototype;
  if (proto && !proto.getClientRects) {
    proto.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} });
    proto.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
  }
  if (!(globalThis as { URL: { createObjectURL?: unknown } }).URL.createObjectURL) {
    (globalThis as { URL: { createObjectURL?: unknown; revokeObjectURL?: unknown } }).URL.createObjectURL = () => 'blob:mock';
    (globalThis as { URL: { createObjectURL?: unknown; revokeObjectURL?: unknown } }).URL.revokeObjectURL = () => undefined;
  }
}
