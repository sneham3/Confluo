import { ApiError, type ApiClient, type RequestInitLite } from '@confluo/editor';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
export const API_BASE = `${API_URL}/v1`;

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * Typed fetch wrapper. Bearer token lives in memory; on a 401 it asks the AuthProvider for a
 * refreshed token once and retries. Cookies are always included (refresh cookie on /v1/auth).
 */
class Api implements ApiClient {
  private token: string | null = null;
  private refresher: (() => Promise<string | null>) | null = null;
  private refreshing: Promise<string | null> | null = null;

  setToken(token: string | null) {
    this.token = token;
  }

  getToken() {
    return this.token;
  }

  setRefresher(fn: (() => Promise<string | null>) | null) {
    this.refresher = fn;
  }

  private async refreshOnce(): Promise<string | null> {
    if (!this.refresher) return null;
    if (!this.refreshing) {
      this.refreshing = this.refresher().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  async request<T>(method: Method, path: string, body?: unknown, init: RequestInitLite = {}, retry = true): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers ?? {}) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'include',
      signal: init.signal,
      keepalive: init.keepalive,
    });
    if (res.status === 401 && retry && !path.startsWith('/auth/')) {
      const t = await this.refreshOnce();
      if (t) return this.request<T>(method, path, body, init, false);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      throw new ApiError(res.status, err?.code ?? 'INTERNAL', err?.message ?? `Request failed (${res.status})`, err?.details);
    }
    return json as T;
  }

  get<T = unknown>(path: string, init?: RequestInitLite) {
    return this.request<T>('GET', path, undefined, init);
  }
  post<T = unknown>(path: string, body?: unknown, init?: RequestInitLite) {
    return this.request<T>('POST', path, body, init);
  }
  patch<T = unknown>(path: string, body?: unknown, init?: RequestInitLite) {
    return this.request<T>('PATCH', path, body, init);
  }
  put<T = unknown>(path: string, body?: unknown, init?: RequestInitLite) {
    return this.request<T>('PUT', path, body, init);
  }
  delete<T = unknown>(path: string, init?: RequestInitLite) {
    return this.request<T>('DELETE', path, undefined, init);
  }
}

export const api = new Api();
export { ApiError };
