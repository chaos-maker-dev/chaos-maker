import type {
  ChaosReport,
  FailureSummary,
  RuleHitSummary,
  SkipReasonSummary,
  TimelineEntry,
  TransportSummary,
} from './types';

export interface FormatReportHtmlOptions {
  /** Document title. When omitted, falls back to `report.meta.title ?? 'Chaos run'`. */
  title?: string;
}

function escapeHtml(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '<span class="muted">-</span>';
  return escapeHtml(value);
}

function ruleHitsBlock(rows: RuleHitSummary[]): string {
  if (rows.length === 0) return '<p class="empty">No rule hits.</p>';
  const body = rows
    .map(
      (r) => `<tr>
  <td><code>${escapeHtml(r.ruleId)}</code></td>
  <td>${cell(r.ruleName)}</td>
  <td class="num">${r.applied}</td>
  <td class="num">${r.skipped}</td>
  <td class="num">${r.total}</td>
  <td>${escapeHtml(r.types.join(', ')) || '<span class="muted">-</span>'}</td>
</tr>`,
    )
    .join('\n');
  return `<table class="grid">
<thead><tr><th>Rule ID</th><th>Name</th><th>Applied</th><th>Skipped</th><th>Total</th><th>Types</th></tr></thead>
<tbody>
${body}
</tbody>
</table>`;
}

function transportsBlock(rows: TransportSummary[]): string {
  if (rows.length === 0) return '<p class="empty">No transport activity.</p>';
  const body = rows
    .map(
      (r) => `<tr><td>${escapeHtml(r.kind)}</td><td class="num">${r.events}</td><td class="num">${r.applied}</td></tr>`,
    )
    .join('\n');
  return `<table class="grid">
<thead><tr><th>Kind</th><th>Events</th><th>Applied</th></tr></thead>
<tbody>
${body}
</tbody>
</table>`;
}

function skipReasonsBlock(rows: SkipReasonSummary[]): string {
  if (rows.length === 0) return '<p class="empty">No skips recorded.</p>';
  const body = rows
    .map(
      (r) => `<tr><td>${escapeHtml(r.stage)}</td><td>${cell(r.skippedAt)}</td><td class="num">${r.count}</td></tr>`,
    )
    .join('\n');
  return `<table class="grid">
<thead><tr><th>Stage</th><th>Skipped at</th><th>Count</th></tr></thead>
<tbody>
${body}
</tbody>
</table>`;
}

function failuresBlock(rows: FailureSummary[]): string {
  if (rows.length === 0) return '<p class="empty">No failures recorded.</p>';
  const body = rows
    .map(
      (r) => `<tr>
  <td>${r.ruleId ? `<code>${escapeHtml(r.ruleId)}</code>` : '<span class="muted">-</span>'}</td>
  <td>${escapeHtml(r.type)}</td>
  <td class="num">${cell(r.statusCode)}</td>
  <td class="num">${r.count}</td>
  <td>${cell(r.sampleUrl)}</td>
</tr>`,
    )
    .join('\n');
  return `<table class="grid">
<thead><tr><th>Rule ID</th><th>Type</th><th>Status</th><th>Count</th><th>Sample URL</th></tr></thead>
<tbody>
${body}
</tbody>
</table>`;
}

function timelineBlock(rows: TimelineEntry[]): string {
  if (rows.length === 0) return '<p class="empty">No events recorded.</p>';
  const body = rows
    .map(
      (entry) => `<li class="${entry.applied ? 'applied' : 'skipped'}">
  <span class="offset">+${entry.offsetMs}ms</span>
  <span class="title">${escapeHtml(entry.title)}</span>
  ${entry.ruleId ? `<span class="rule">rule <code>${escapeHtml(entry.ruleId)}</code></span>` : ''}
</li>`,
    )
    .join('\n');
  return `<ol class="timeline">
${body}
</ol>`;
}

const STYLE = `body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px; color: #1f2328; background: #f6f8fa; }
main { max-width: 960px; margin: 0 auto; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 24px; }
h1 { margin: 0 0 16px; font-size: 22px; }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0 0 24px; }
dl.meta dt { font-weight: 600; color: #57606a; }
dl.meta dd { margin: 0; }
details { border-top: 1px solid #d0d7de; padding: 12px 0; }
details > summary { cursor: pointer; font-weight: 600; font-size: 16px; }
table.grid { border-collapse: collapse; width: 100%; margin-top: 12px; font-size: 13px; }
table.grid th, table.grid td { border-bottom: 1px solid #d0d7de; padding: 6px 8px; text-align: left; vertical-align: top; }
table.grid th { background: #f6f8fa; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: #f6f8fa; padding: 1px 4px; border-radius: 4px; }
.muted { color: #8c959f; }
.empty { color: #8c959f; font-style: italic; margin: 12px 0; }
ol.timeline { list-style: none; padding: 0; margin: 12px 0 0; }
ol.timeline li { display: flex; gap: 12px; padding: 4px 0; border-bottom: 1px dotted #d0d7de; font-size: 13px; }
ol.timeline li.skipped { opacity: 0.6; }
ol.timeline .offset { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #57606a; min-width: 64px; }
ol.timeline .title { flex: 1; }
ol.timeline .rule { color: #57606a; font-size: 12px; }`;

/** Serialize a `ChaosReport` to a self-contained HTML document. The output
 *  embeds CSS inline, uses native `<details>` for collapsibles, and contains
 *  no `<script>` tags, no external URLs, and no absolute time strings other
 *  than the `data-generated-at` attribute on the meta block. Deterministic for
 *  a fixed report. */
export function formatReportHtml(
  report: ChaosReport,
  opts: FormatReportHtmlOptions = {},
): string {
  const title = opts.title ?? report.meta.title ?? 'Chaos run';
  const headerTitle = escapeHtml(`Chaos report: ${title}`);

  const meta = report.meta;
  const duration = meta.durationMs === null ? '-' : `${meta.durationMs} ms`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${headerTitle}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${headerTitle}</h1>
<dl class="meta">
  <dt>Seed</dt><dd><code>${escapeHtml(meta.replaySnippet)}</code></dd>
  <dt>Generated</dt><dd data-generated-at="${escapeHtml(meta.generatedAt)}">${escapeHtml(meta.generatedAt)}</dd>
  <dt>Events</dt><dd>${meta.eventCount} (applied ${meta.appliedCount}, skipped ${meta.skippedCount})</dd>
  <dt>Duration</dt><dd>${escapeHtml(duration)}</dd>
</dl>
<details open><summary>Rule hits</summary>${ruleHitsBlock(report.ruleHits)}</details>
<details open><summary>Transports</summary>${transportsBlock(report.transports)}</details>
<details open><summary>Skip reasons</summary>${skipReasonsBlock(report.skipReasons)}</details>
<details open><summary>Failures</summary>${failuresBlock(report.failures)}</details>
<details open><summary>Timeline</summary>${timelineBlock(report.timeline)}</details>
</main>
</body>
</html>
`;
}
