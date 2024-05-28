const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const pad = (n: number) => String(n).padStart(2, '0');

function validDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1800 || y > 2200) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Parses ISO, US numeric (MM/DD/YYYY) and long-form ("March 4, 2019") dates to YYYY-MM-DD. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return validDate(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return validDate(+m[3]!, +m[1]!, +m[2]!);
  m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) {
    const month = MONTHS.findIndex((x) => x.startsWith(m![1]!.toLowerCase().slice(0, 3)));
    if (month >= 0) return validDate(+m[3]!, month + 1, +m[2]!);
  }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m) {
    const month = MONTHS.findIndex((x) => x.startsWith(m![2]!.toLowerCase().slice(0, 3)));
    if (month >= 0) return validDate(+m[3]!, month + 1, +m[1]!);
  }
  return null;
}

export function parsePercent(raw: string): number | null {
  const m = raw.match(/(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)/i) ?? raw.match(/^\s*(\d{1,3}(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 0 && v <= 100 ? v : null;
}

export function parseMoney(raw: string): { amount: number; currency: string } | null {
  const m = raw.replace(/\s/g, '').match(/^(-)?(\$|USD|EUR|€|£)?(-)?([\d,]+(?:\.\d{1,2})?)$/i);
  if (!m) return null;
  const amount = Number(m[4]!.replace(/,/g, '')) * (m[1] || m[3] ? -1 : 1);
  if (!Number.isFinite(amount)) return null;
  const sym = (m[2] ?? '$').toUpperCase();
  const currency = sym === '$' || sym === 'USD' ? 'USD' : sym === '€' || sym === 'EUR' ? 'EUR' : 'GBP';
  return { amount, currency };
}

/** US Employer Identification Number: two digits, hyphen, seven digits. */
export function parseEin(raw: string): string | null {
  const m = raw.match(/\b(\d{2})-?(\d{7})\b/);
  return m ? `${m[1]}-${m[2]}` : null;
}

/** Name normalization used for matching (not display). */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.,'’"()]/g, '')
    .replace(/\b(the|inc|incorporated|llc|l l c|ltd|limited|lp|l p|llp|corp|corporation|co|company|plc|gmbh|na|n a)\b/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ORG_HINTS = /\b(llc|l\.l\.c\.|inc\.?|incorporated|ltd\.?|limited|lp|l\.p\.|llp|corp\.?|corporation|company|holdings|partners|trust|fund|bank|n\.a\.|plc|gmbh|group|capital|ventures)\b/i;

export function looksLikeOrganization(name: string): boolean {
  return ORG_HINTS.test(name);
}
