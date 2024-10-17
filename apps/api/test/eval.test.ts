import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runEvaluation, type EvalReport } from '../src/eval/run';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
let report: EvalReport;

beforeAll(async () => {
  env = await createTestEnv();
  report = await runEvaluation(env.app, env.db);
});
afterAll(() => env.close());

describe('AI evaluation (requirements section 11)', () => {
  it('meets every proposed pilot target with the local providers', () => {
    const misses = report.metrics.filter((m) => !m.pass).map((m) => `${m.name}: ${m.value} (target ${m.target})`);
    expect(misses).toEqual([]);
  });

  it('never discloses data across users or tenants', () => {
    expect(report.metrics.find((m) => m.name === 'Unauthorized disclosures')!.value).toBe(0);
  });
});
