/** Vendor-free analytics hook. Console in development, no-op in production until wired to a provider. */
export function track(event: string, props: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.debug('[track]', event, props);
  }
}
