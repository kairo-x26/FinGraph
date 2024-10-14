/**
 * Minimal Prometheus metrics registry (text exposition format 0.0.4). Kept in
 * process; scrape each API and worker instance separately.
 */
type Labels = Record<string, string>;

const key = (l: Labels) =>
  Object.keys(l)
    .sort()
    .map((k) => `${k}="${String(l[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',');

class Counter {
  private values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1) {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) lines.push(`${this.name}${k ? `{${k}}` : ''} ${v}`);
    return lines.join('\n');
  }
}

class Histogram {
  private series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: number[],
  ) {}
  observe(labels: Labels, value: number) {
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    this.buckets.forEach((b, i) => value <= b && s!.counts[i]!++);
    s.sum += value;
    s.count++;
  }
  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const sep = k ? ',' : '';
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket{${k}${sep}le="${b}"} ${s.counts[i]}`));
      lines.push(`${this.name}_bucket{${k}${sep}le="+Inf"} ${s.count}`);
      lines.push(`${this.name}_sum${k ? `{${k}}` : ''} ${s.sum}`);
      lines.push(`${this.name}_count${k ? `{${k}}` : ''} ${s.count}`);
    }
    return lines.join('\n');
  }
}

export const metrics = {
  httpRequests: new Counter('fingraph_http_requests_total', 'HTTP requests by route and status class'),
  httpDuration: new Histogram('fingraph_http_request_duration_seconds', 'HTTP request latency', [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 15]),
  jobs: new Counter('fingraph_jobs_total', 'Background jobs by kind and outcome'),
  jobDuration: new Histogram('fingraph_job_duration_seconds', 'Background job duration', [0.1, 0.5, 1, 5, 15, 60, 300]),
  aiQuestions: new Counter('fingraph_ai_questions_total', 'Evidence questions by outcome'),
};

export function renderMetrics(extra: string[] = []) {
  return [...Object.values(metrics).map((m) => m.render()), ...extra].join('\n\n') + '\n';
}
