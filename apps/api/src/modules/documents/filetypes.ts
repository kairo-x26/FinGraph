import { unzipSync } from 'fflate';

export const SUPPORTED_TYPES = {
  'application/pdf': { ext: ['pdf'], label: 'PDF' },
  'image/png': { ext: ['png'], label: 'PNG image' },
  'image/jpeg': { ext: ['jpg', 'jpeg'], label: 'JPEG image' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: ['docx'], label: 'Word document' },
  'text/plain': { ext: ['txt'], label: 'Text file' },
  'text/csv': { ext: ['csv'], label: 'CSV file' },
} as const;

export type SupportedMime = keyof typeof SUPPORTED_TYPES;

export function isSupportedMime(m: string): m is SupportedMime {
  return m in SUPPORTED_TYPES;
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Detects the file type from its content (magic bytes), never from the client's
 * declared type or the file extension.
 */
export function detectMime(buf: Buffer): SupportedMime | 'application/octet-stream' {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 4 && buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    try {
      const files = unzipSync(new Uint8Array(buf), {
        filter: (f) => f.name === '[Content_Types].xml' || f.name === 'word/document.xml',
      });
      if (files['word/document.xml'] && files['[Content_Types].xml']) return DOCX;
    } catch {
      /* not a valid zip */
    }
    return 'application/octet-stream';
  }
  if (looksLikeText(buf)) {
    const head = buf.subarray(0, 4096).toString('utf8');
    const lines = head.split(/\r?\n/).filter(Boolean).slice(0, 5);
    const commas = lines.map((l) => (l.match(/,/g) ?? []).length);
    if (lines.length >= 2 && commas[0]! > 0 && commas.every((c) => c === commas[0])) return 'text/csv';
    return 'text/plain';
  }
  return 'application/octet-stream';
}

function looksLikeText(buf: Buffer): boolean {
  if (!buf.length) return false;
  const sample = buf.subarray(0, 8192);
  // Control characters other than tab, newline, form feed and carriage return mean binary content.
  for (const b of sample) if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d) return false;
  try {
    // stream mode tolerates a multi-byte character cut off at the end of the sample
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: sample.length < buf.length });
    return true;
  } catch {
    return false;
  }
}

/** Declared and detected types are compatible (text/csv and text/plain are interchangeable). */
export function mimeMatches(declared: string, detected: string): boolean {
  if (declared === detected) return true;
  const text = new Set(['text/plain', 'text/csv']);
  if (text.has(declared) && text.has(detected)) return true;
  return false;
}

export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'document';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_').trim().slice(0, 200);
  return cleaned || 'document';
}
