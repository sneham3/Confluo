import { useEffect, useState } from 'react';
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import type { ImageAttrs } from '@confluo/editor-schema';

export interface ImageNodeViewOptions {
  /** Resolve a stored src (API asset URL) to a browsable URL (signed). */
  resolveUrl: (assetId: string | null, src: string | null) => Promise<string | null>;
  getProgress: (uploadId: string) => number | null;
  isUploader: (uploadId: string) => boolean;
  retry: (uploadId: string) => void;
  subscribe: (listener: () => void) => () => void;
}

const urlCache = new Map<string, string>();

export function ImageNodeView(props: ReactNodeViewProps) {
  const attrs = props.node.attrs as ImageAttrs;
  const options = (props.extension.options ?? {}) as Partial<ImageNodeViewOptions>;
  const [resolved, setResolved] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [broken, setBroken] = useState(false);

  useEffect(() => options.subscribe?.(() => setTick((t) => t + 1)) ?? undefined, [options]);

  const uploader = attrs.uploadId ? options.isUploader?.(attrs.uploadId) ?? false : false;
  const progress = attrs.uploadId ? options.getProgress?.(attrs.uploadId) ?? null : null;

  useEffect(() => {
    let cancelled = false;
    if (attrs.status !== 'ready') return;
    const key = attrs.assetId ?? attrs.src ?? '';
    if (!key) return;
    if (urlCache.has(key) && !broken) {
      setResolved(urlCache.get(key)!);
      return;
    }
    options
      .resolveUrl?.(attrs.assetId, attrs.src)
      .then((u) => {
        if (cancelled) return;
        if (u) urlCache.set(key, u);
        setResolved(u);
        setBroken(false);
      })
      .catch(() => !cancelled && setResolved(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attrs.assetId, attrs.src, attrs.status, broken]);

  void tick;

  if (attrs.status === 'uploading') {
    return (
      <NodeViewWrapper as="figure" className={`confluo-image is-uploading${props.selected ? ' is-selected' : ''}`} data-drag-handle>
        {uploader && attrs.src ? (
          <img src={attrs.src} alt={attrs.alt} draggable={false} />
        ) : (
          <div className="confluo-image__skeleton" aria-label="Image is being uploaded" />
        )}
        <div className="confluo-image__overlay" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress ?? 0) * 100)}>
          <span className="confluo-image__ring" style={{ ['--p' as string]: `${Math.round((progress ?? 0) * 100)}%` }} />
          <span className="confluo-image__label">{uploader ? `Uploading ${Math.round((progress ?? 0) * 100)}%` : 'Uploading…'}</span>
        </div>
      </NodeViewWrapper>
    );
  }

  if (attrs.status === 'failed') {
    return (
      <NodeViewWrapper as="figure" className={`confluo-image is-failed${props.selected ? ' is-selected' : ''}`} data-drag-handle>
        <div className="confluo-image__skeleton" />
        <div className="confluo-image__overlay">
          <span className="confluo-image__label">Upload failed</span>
          {uploader && attrs.uploadId && (
            <span className="confluo-image__actions">
              <button type="button" onClick={() => options.retry?.(attrs.uploadId!)}>
                Retry
              </button>
              <button type="button" onClick={() => props.deleteNode()}>
                Remove
              </button>
            </span>
          )}
        </div>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="figure" className={`confluo-image${props.selected ? ' is-selected' : ''}`} data-drag-handle>
      {resolved ? (
        <img
          src={resolved}
          alt={attrs.alt}
          width={attrs.width ?? undefined}
          draggable={false}
          onError={() => {
            const key = attrs.assetId ?? attrs.src ?? '';
            urlCache.delete(key);
            setBroken(true);
          }}
        />
      ) : (
        <div className="confluo-image__skeleton" aria-label="Loading image" />
      )}
    </NodeViewWrapper>
  );
}
