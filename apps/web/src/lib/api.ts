/** Problem details returned by the API (RFC 9457). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  correlation_id?: string;
  errors?: { path: string; message: string }[];
  [key: string]: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem,
  ) {
    super(problem.title);
  }
  get code() {
    return this.problem.code;
  }
}

function csrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|; )fg_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

type Query = Record<string, string | number | boolean | undefined | null | string[]>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export function apiUrl(path: string, query?: Query) {
  const url = new URL(`/api${path}`, typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else url.searchParams.set(k, String(v));
  }
  return url.pathname + url.search;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  let body: BodyInit | undefined;
  if (opts.body instanceof Blob || opts.body instanceof ArrayBuffer) {
    body = opts.body as BodyInit;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  } else if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    body = '{}';
  }
  if (method !== 'GET') {
    const csrf = csrfToken();
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  const res = await fetch(apiUrl(path, opts.query), { method, headers, body, credentials: 'same-origin', signal: opts.signal });
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const problem: Problem =
      typeof data === 'object' && data
        ? (data as Problem)
        : { type: 'about:blank', title: 'The request failed.', status: res.status, code: 'http_error' };
    throw new ApiError(res.status, problem);
  }
  return data as T;
}

/** Upload a file through the signed-URL flow and register it as a document. */
export async function uploadFile(
  caseId: string,
  file: File,
  extra: { title?: string; restricted?: boolean; replaces_document_id?: string; replaced_reason?: string } = {},
) {
  const mime = file.type || guessMime(file.name);
  const init = await api<{ upload_id: string; upload_url: string }>('/v1/documents/uploads', {
    body: { case_id: caseId, filename: file.name, mime_type: mime, size_bytes: file.size },
  });
  // the signed URL is complete and public-facing; use it exactly as issued
  const put = await fetch(init.upload_url, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', ...(csrfToken() ? { 'x-csrf-token': csrfToken()! } : {}) },
    body: file,
    credentials: 'same-origin',
  });
  if (!put.ok) throw new ApiError(put.status, await put.json().catch(() => ({ title: 'Upload failed.', status: put.status, code: 'upload_failed', type: '' })));
  return api<{ document_id: string; job_id?: string; status: string; duplicate?: boolean }>('/v1/documents', {
    body: { upload_id: init.upload_id, ...extra },
  });
}

function guessMime(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  return (
    {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      txt: 'text/plain',
      csv: 'text/csv',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }[ext ?? ''] ?? 'application/octet-stream'
  );
}

/** Human message for an error, with validation details when present. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.problem.errors?.length) return err.problem.errors.map((e) => e.message).join(' ');
    return err.problem.title;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}
