import { strToU8, zipSync } from 'fflate';
import type { AppContext } from '../../context';
import { canonicalJson, sha256Hex } from '../../lib/crypto';
import { recordAudit, verifyAuditChain } from '../audit/service';
import { emitEvent } from '../events/outbox';
import { PermanentJobError } from '../jobs/errors';
import type { JobContext } from '../jobs/worker';

export const BUILD_EXPORT_JOB = 'build_export';
export const EXPORT_FORMAT = 'fingraph-evidence-package/1';

export interface ExportScope {
  include_files: boolean;
  include_ai: boolean;
  include_audit_trail: boolean;
  /** Documents visible to the requester when the export was requested. */
  document_ids: string[];
  requested_by_name: string | null;
}

/**
 * Builds a versioned, self-describing evidence package (WF-05): case record,
 * documents and versions with checksums, approved facts, relationships with
 * evidence, decisions with policy versions, AI interactions and the case audit
 * trail. Every file's SHA-256 is listed in manifest.json.
 */
export function exportHandler(ctx: AppContext) {
  return async ({ job }: JobContext) => {
    const exportId = String(job.payload.export_id);
    const tenantId = job.tenant_id;
    const tx = <T>(fn: Parameters<typeof ctx.db.tenant<T>>[1]) => ctx.db.tenant(tenantId, fn);

    const exp = await tx((t) =>
      t.one<{ id: string; case_id: string; version_no: number; status: string; scope: ExportScope; requested_by: string | null; created_at: Date }>(
        'select * from audit_exports where id = $1',
        [exportId],
      ),
    );
    if (!exp) throw new PermanentJobError('not_found', 'export not found');
    if (exp.status === 'ready') return { skipped: true };
    await tx((t) => t.query(`update audit_exports set status = 'building', error = null where id = $1`, [exportId]));

    const files: Record<string, Uint8Array> = {};
    const add = (path: string, data: unknown) => {
      files[path] = typeof data === 'string' ? strToU8(data) : data instanceof Uint8Array ? data : strToU8(JSON.stringify(data, null, 2));
    };
    const docIds = exp.scope.document_ids;

    const data = await tx(async (t) => {
      const kase = await t.one(
        `select c.id, c.reference, c.case_type, c.subject_name, c.customer_ref, c.status, c.risk_level, c.created_at, c.closed_at,
                c.review_started_at, a.display_name as assignee, p.key as policy_key, p.version as policy_version, p.rules as policy_rules,
                ct.version as checklist_version, ct.items as checklist_items
           from cases c left join users a on a.id = c.assignee_id
           left join compliance_policies p on p.id = c.policy_id
           left join checklist_templates ct on ct.id = c.checklist_template_id
          where c.id = $1`,
        [exp.case_id],
      );
      const documents = await t.many(
        `select d.id, d.title, d.category, d.category_source, d.evidence_date, d.created_at, d.purged_at,
                coalesce(json_agg(json_build_object('version_id', v.id, 'version_no', v.version_no, 'filename', v.filename,
                   'mime_type', v.mime_type, 'size_bytes', v.size_bytes, 'sha256', v.sha256, 'status', v.status,
                   'source', v.source, 'uploaded_at', v.created_at, 'processed_at', v.processed_at,
                   'current', v.id = d.current_version_id, 'scan', v.scan_result) order by v.version_no), '[]') as versions
           from documents d join document_versions v on v.document_id = d.id
          where d.id = any($1) group by d.id order by d.created_at`,
        [docIds],
      );
      const facts = await t.many(
        `select f.id, f.document_id, f.version_id, f.field_key, f.field_label, f.value, f.value_text, f.group_key, f.confidence,
                f.critical, f.status, f.evidence_page, f.evidence_start, f.evidence_end, f.evidence_quote, f.reviewed_at,
                u.display_name as reviewed_by,
                (select coalesce(json_agg(json_build_object('action', r.action, 'previous_value', r.previous_value,
                    'new_value', r.new_value, 'comment', r.comment, 'at', r.created_at, 'by', ru.display_name) order by r.created_at), '[]')
                   from fact_reviews r left join users ru on ru.id = r.reviewer_id where r.fact_id = f.id) as review_history
           from extracted_facts f left join users u on u.id = f.reviewed_by
          where f.document_id = any($1) and f.status in ('approved', 'corrected', 'rejected')
          order by f.document_id, f.group_key nulls first, f.field_key`,
        [docIds],
      );
      const relationships = await t.many(
        `select r.id, s.display_name as source, r.relationship_type, tg.display_name as target, r.ownership_pct, r.role_title,
                r.review_status, r.valid_from, r.valid_to, r.evidence_document_id, r.evidence_document_version_id, r.evidence_page,
                r.evidence_quote, r.origin, r.confidence, r.reviewed_at, u.display_name as reviewed_by, r.review_comment
           from entity_relationships r join entities s on s.id = r.source_entity_id join entities tg on tg.id = r.target_entity_id
           left join users u on u.id = r.reviewed_by
          where r.case_id = $1 and r.evidence_document_id = any($2) order by r.created_at`,
        [exp.case_id, docIds],
      );
      const decisions = await t.many(
        `select d.kind, d.outcome, d.from_status, d.to_status, d.rationale, d.created_at, u.display_name as decided_by,
                d.policy_id, d.policy_version, d.snapshot
           from review_decisions d left join users u on u.id = d.decided_by where d.case_id = $1 order by d.created_at`,
        [exp.case_id],
      );
      const waivers = await t.many(
        `select w.item_key, w.reason, w.created_at, w.revoked_at, u.display_name as waived_by
           from checklist_waivers w left join users u on u.id = w.waived_by where w.case_id = $1`,
        [exp.case_id],
      );
      const ai = exp.scope.include_ai
        ? await t.many(
            `select i.id, i.question, i.status, i.answer, i.claims, i.citations, i.flags, i.provider, i.model, i.prompt_version,
                    i.retrieval, i.source_versions, i.created_at, u.display_name as asked_by
               from ai_interactions i left join users u on u.id = i.user_id
              where i.case_id = $1 and i.source_versions <@ (select coalesce(array_agg(v.id), '{}') from document_versions v where v.document_id = any($2))
              order by i.created_at`,
            [exp.case_id, docIds],
          )
        : [];
      const trail = exp.scope.include_audit_trail
        ? await t.many(
            `select seq, occurred_at, actor_type, actor_id, action, resource_type, resource_id, correlation_id, details, prev_hash, hash
               from audit_events where (resource_type = 'case' and resource_id = $1) or details->>'case_id' = $1 order by seq`,
            [exp.case_id],
          )
        : [];
      const chain = exp.scope.include_audit_trail ? await verifyAuditChain(t, tenantId) : null;
      const holds = await t.many(`select reason, created_at, released_at from legal_holds where case_id = $1`, [exp.case_id]);
      return { kase, documents, facts, relationships, decisions, waivers, ai, trail, chain, holds };
    });

    add('case.json', { ...data.kase, legal_holds: data.holds, checklist_waivers: data.waivers });
    add('documents.json', data.documents);
    add('facts.json', data.facts);
    add('relationships.json', data.relationships);
    add('decisions.json', data.decisions);
    if (exp.scope.include_ai) add('ai_interactions.json', data.ai);
    if (exp.scope.include_audit_trail) add('audit_trail.json', { chain_verification: data.chain, events: data.trail });

    const missingFiles: string[] = [];
    if (exp.scope.include_files) {
      const versions = await tx((t) =>
        t.many<{ id: string; document_id: string; filename: string; storage_key: string | null; status: string }>(
          `select v.id, v.document_id, v.filename, v.storage_key, v.status from document_versions v
            where v.document_id = any($1) and v.status <> 'quarantined'`,
          [docIds],
        ),
      );
      for (const v of versions) {
        if (!v.storage_key) {
          missingFiles.push(v.id);
          continue;
        }
        add(`files/${v.document_id}/${v.id}-${v.filename.replace(/[^A-Za-z0-9._-]/g, '_')}`, new Uint8Array(await ctx.storage.get(v.storage_key)));
      }
    }

    const createdAt = new Date().toISOString();
    const manifest = {
      format: EXPORT_FORMAT,
      export_id: exp.id,
      export_version: exp.version_no,
      case_id: exp.case_id,
      case_reference: (data.kase as { reference: string }).reference,
      created_at: createdAt,
      requested_by: exp.scope.requested_by_name,
      scope: { ...exp.scope, document_ids: undefined, documents: docIds.length },
      policy: { key: (data.kase as { policy_key: string }).policy_key, version: (data.kase as { policy_version: number }).policy_version },
      files: Object.fromEntries(Object.entries(files).map(([p, b]) => [p, { sha256: sha256Hex(b), bytes: b.length }])),
      unavailable_files: missingFiles,
      notice:
        'Evidence package generated by FinGraph. Extracted facts and AI answers are review aids; the recorded human decisions are authoritative.',
    };
    add('manifest.json', manifest);
    add(
      'README.txt',
      `FinGraph evidence package ${manifest.case_reference} v${exp.version_no}\nCreated ${createdAt}\n\nmanifest.json lists every file with its SHA-256.\nVerify: sha256sum <file> and compare with the manifest.\n`,
    );

    const zip = Buffer.from(zipSync(files, { level: 6, mtime: new Date(createdAt) }));
    const key = `tenants/${tenantId}/exports/${exp.case_id}/${exp.id}.zip`;
    await ctx.storage.put(key, zip, { contentType: 'application/zip' });
    const sha = sha256Hex(zip);
    await tx(async (t) => {
      await t.query(
        `update audit_exports set status = 'ready', storage_key = $2, sha256 = $3, size_bytes = $4, manifest = $5, ready_at = now()
          where id = $1`,
        [exp.id, key, sha, zip.length, JSON.stringify({ ...manifest, manifest_sha256: sha256Hex(canonicalJson(manifest)) })],
      );
      await recordAudit(t, {
        tenantId,
        actor: { type: 'system', id: 'exports' },
        action: 'audit.export_built',
        resourceType: 'audit_export',
        resourceId: exp.id,
        details: { case_id: exp.case_id, sha256: sha, bytes: zip.length, files: Object.keys(files).length },
      });
      await emitEvent(t, {
        tenantId,
        type: 'audit.export_created',
        resource: { type: 'audit_export', id: exp.id },
        data: { case_id: exp.case_id, version_no: exp.version_no, sha256: sha },
      });
    });
    return { sha256: sha, bytes: zip.length, files: Object.keys(files).length };
  };
}
