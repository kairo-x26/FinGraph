import type { Tx } from '../../db';

interface FactLite {
  field_key: string;
  field_label: string;
  group_key: string | null;
  value: unknown;
  value_text: string | null;
  status: string;
}

export interface FieldChange {
  key: string;
  label: string;
  change: 'added' | 'removed' | 'changed' | 'unchanged';
  before: string | null;
  after: string | null;
}

/** Identity of a repeated group (e.g. an owner) is its name, not its position. */
function factKey(f: FactLite, groupNames: Map<string, string>) {
  if (!f.group_key) return f.field_key;
  const [group] = f.group_key.split(':');
  return `${group}[${groupNames.get(f.group_key) ?? f.group_key}].${f.field_key.split('.')[1]}`;
}

async function factsOf(tx: Tx, versionId: string) {
  const rows = await tx.many<FactLite>(
    `select field_key, field_label, group_key, value, value_text, status from extracted_facts
      where version_id = $1 and status not in ('rejected', 'superseded')`,
    [versionId],
  );
  const names = new Map<string, string>();
  for (const r of rows) {
    if (r.group_key && /\.(name|owner)$/.test(r.field_key)) names.set(r.group_key, String(r.value_text ?? r.value).toLowerCase());
  }
  return new Map(rows.map((r) => [factKey(r, names), r]));
}

function lineDiff(a: string, b: string) {
  const la = a.split('\n').map((l) => l.trim()).filter(Boolean);
  const lb = b.split('\n').map((l) => l.trim()).filter(Boolean);
  const sa = new Set(la);
  const sb = new Set(lb);
  return {
    added: lb.filter((l) => !sa.has(l)).slice(0, 50),
    removed: la.filter((l) => !sb.has(l)).slice(0, 50),
    unchanged: lb.filter((l) => sa.has(l)).length,
  };
}

/**
 * Compares two document versions (or two documents of the same type) field by
 * field, plus a line-level text diff (AI-08).
 */
export async function compareVersions(tx: Tx, fromVersion: string, toVersion: string) {
  const [a, b] = [await factsOf(tx, fromVersion), await factsOf(tx, toVersion)];
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const fields: FieldChange[] = keys.map((k) => {
    const x = a.get(k);
    const y = b.get(k);
    const before = x ? (x.value_text ?? JSON.stringify(x.value)) : null;
    const after = y ? (y.value_text ?? JSON.stringify(y.value)) : null;
    const change: FieldChange['change'] = !x ? 'added' : !y ? 'removed' : JSON.stringify(x.value) === JSON.stringify(y.value) ? 'unchanged' : 'changed';
    return { key: k, label: (y ?? x)!.field_label, change, before, after };
  });
  const text = async (v: string) =>
    (await tx.many<{ text: string }>('select text from document_pages where version_id = $1 order by page_no', [v])).map((p) => p.text).join('\n');
  return {
    from_version_id: fromVersion,
    to_version_id: toVersion,
    summary: {
      changed: fields.filter((f) => f.change === 'changed').length,
      added: fields.filter((f) => f.change === 'added').length,
      removed: fields.filter((f) => f.change === 'removed').length,
      unchanged: fields.filter((f) => f.change === 'unchanged').length,
    },
    fields: fields.filter((f) => f.change !== 'unchanged').concat(fields.filter((f) => f.change === 'unchanged')),
    text: lineDiff(await text(fromVersion), await text(toVersion)),
  };
}
