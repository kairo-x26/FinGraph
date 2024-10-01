'use client';

import { useId, useState } from 'react';
import { Table, Td, Th } from '@/ui';

export interface Series {
  key: string;
  label: string;
  color: string;
}

export interface Datum {
  label: string;
  values: Record<string, number>;
  /** Extra lines for the tooltip. */
  note?: string;
}

/**
 * Stacked bar chart in plain SVG: thin bars with a 2px surface gap between
 * segments, rounded data ends, a recessive grid, a legend for 2+ series, hover
 * tooltips and a table view for screen readers and exact values.
 */
export function BarChart({ title, data, series, height = 180, empty = 'No data yet.' }: { title: string; data: Datum[]; series: Series[]; height?: number; empty?: string }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const total = (d: Datum) => series.reduce((s, x) => s + (d.values[x.key] ?? 0), 0);
  const max = Math.max(1, ...data.map(total));
  // counts: integer ticks only
  const nice = (() => {
    if (max <= 4) return Math.max(1, Math.ceil(max));
    const pow = 10 ** Math.floor(Math.log10(max));
    const n = Math.ceil(max / pow) * pow;
    return n % 2 ? n + pow : n;
  })();
  const ticks = nice <= 4 ? Array.from({ length: nice + 1 }, (_, i) => i) : [0, nice / 2, nice];
  const W = 600;
  const padL = 32;
  const padB = 22;
  const plotH = height - padB - 8;
  const band = data.length ? (W - padL) / data.length : 0;
  const barW = Math.min(28, Math.max(6, band * 0.55));
  const y = (v: number) => 8 + plotH - (v / nice) * plotH;

  return (
    <figure className="flex flex-col gap-2" aria-labelledby={`${id}-t`}>
      <div className="flex items-baseline justify-between gap-2">
        <figcaption id={`${id}-t`} className="text-sm font-semibold">
          {title}
        </figcaption>
        <button className="text-2xs text-register hover:underline" onClick={() => setAsTable((t) => !t)}>
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {series.length > 1 && (
        <ul className="flex gap-3 text-2xs text-ink-muted" aria-label="Legend">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      {data.length === 0 ? (
        <p className="py-8 text-center text-xs text-ink-muted">{empty}</p>
      ) : asTable ? (
        <Table caption={title}>
          <thead>
            <tr>
              <Th>Period</Th>
              {series.map((s) => (
                <Th key={s.key} numeric>
                  {s.label}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.label}>
                <Td className="text-xs">{d.label}</Td>
                {series.map((s) => (
                  <Td key={s.key} numeric className="text-xs">
                    {d.values[s.key] ?? 0}
                  </Td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label={`${title}. Use "Show table" for values.`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke="var(--rule)" strokeWidth={1} />
                <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--ink-faint)">
                  {t}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx = padL + band * i + band / 2;
              let acc = 0;
              const segs = series.map((s) => {
                const v = d.values[s.key] ?? 0;
                const y0 = y(acc);
                acc += v;
                return { s, v, y0, y1: y(acc) };
              });
              const top = segs.filter((g) => g.v > 0).at(-1);
              return (
                <g key={d.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  <rect x={cx - band / 2} y={8} width={band} height={plotH} fill={hover === i ? 'var(--sheet-sunk)' : 'transparent'} />
                  {segs.map((g) =>
                    g.v > 0 ? (
                      <rect
                        key={g.s.key}
                        x={cx - barW / 2}
                        y={g.y1 + (g === top ? 0 : 1)}
                        width={barW}
                        // 2px surface gap between stacked segments
                        height={Math.max(1, g.y0 - g.y1 - (g === top ? 0 : 2))}
                        rx={g === top ? 4 : 0}
                        fill={g.s.color}
                      />
                    ) : null,
                  )}
                  {(data.length <= 16 || i % Math.ceil(data.length / 8) === 0) && (
                    <text x={cx} y={height - 6} textAnchor="middle" fontSize={10} fill="var(--ink-muted)">
                      {d.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {hover !== null && data[hover] && (
            <div
              role="tooltip"
              className="pointer-events-none absolute top-0 z-10 rounded-[var(--radius-control)] border border-rule bg-sheet px-2.5 py-1.5 text-2xs shadow-[var(--shadow-sheet)]"
              style={{ left: `min(calc(${((padL + band * hover + band / 2) / W) * 100}% + 8px), calc(100% - 150px))` }}
            >
              <p className="font-semibold">{data[hover].label}</p>
              {series.map((s) => (
                <p key={s.key} className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm" style={{ background: s.color }} />
                  {s.label}: <span className="tabular-nums">{data[hover]!.values[s.key] ?? 0}</span>
                </p>
              ))}
              {data[hover].note && <p className="text-ink-muted">{data[hover].note}</p>}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
