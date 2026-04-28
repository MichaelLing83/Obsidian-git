/**
 * Custom isomorphic-git HTTP transport backed by Obsidian's `requestUrl`.
 *
 * Obsidian's `requestUrl`:
 * - Works on both desktop (Electron) and mobile (Android/iOS WebView)
 * - Bypasses CORS restrictions on desktop via Electron's `net` module
 * - Supports binary request/response bodies via ArrayBuffer
 *
 * This replaces both `isomorphic-git/http/web` (fetch-based, CORS-blocked on
 * desktop) and `isomorphic-git/http/node` (Node-built-ins, crashes on mobile).
 */

import { requestUrl } from "obsidian";

const HTTP_TIMEOUT_MS = 120000;

// Drain an async-iterable body into a single Uint8Array.
async function collect(
  iterable: AsyncIterableIterator<Uint8Array> | Iterable<Uint8Array>
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of iterable as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Wrap a single Uint8Array in an async iterable (isomorphic-git body format).
function wrapBody(data: Uint8Array): AsyncIterableIterator<Uint8Array> {
  let done = false;
  return {
    next(): Promise<IteratorResult<Uint8Array>> {
      if (done) return Promise.resolve({ value: undefined as any, done: true });
      done = true;
      return Promise.resolve({ value: data, done: false });
    },
    return(): Promise<IteratorResult<Uint8Array>> {
      done = true;
      return Promise.resolve({ value: undefined as any, done: true });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

interface GitHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: AsyncIterableIterator<Uint8Array> | null;
}

interface GitHttpResponse {
  url: string;
  method: string;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: AsyncIterableIterator<Uint8Array>;
}

async function request({
  url,
  method = "GET",
  headers = {},
  body,
}: GitHttpRequest): Promise<GitHttpResponse> {
  // Collect streaming body (if any) into a single buffer.
  let bodyBuffer: ArrayBuffer | undefined;
  if (body) {
    const bytes = await collect(body);
    bodyBuffer = bytes.buffer as ArrayBuffer;
  }

  const res = await requestUrl({
    url,
    method,
    headers,
    body: bodyBuffer,
    timeout: HTTP_TIMEOUT_MS,
    // Don't throw on non-2xx — let isomorphic-git handle status codes.
    throw: false,
  } as any);

  // Normalise headers: requestUrl returns a plain object.
  const responseHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(res.headers ?? {})) {
    responseHeaders[key.toLowerCase()] = value;
  }

  return {
    url,
    method,
    statusCode: res.status,
    statusMessage: "",
    headers: responseHeaders,
    body: wrapBody(new Uint8Array(res.arrayBuffer)),
  };
}

const obsidianHttpTransport = { request };
export default obsidianHttpTransport;
