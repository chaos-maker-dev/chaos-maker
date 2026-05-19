import type {
  ChaosReport,
  FailureSummary,
  RuleHitSummary,
  SkipReasonSummary,
  TimelineEntry,
  TransportSummary,
} from './types';

/** Escape `|`, backtick, and stray newlines so the value renders inside a
 *  Markdown table cell without breaking the row. */
function cell(value: string | number | null): string {
  if (value === null || value === undefined) return '-';
  const s = typeof value === 'string' ? value : String(value);
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function code(value: string | null): string {
  if (!value) return '-';
  const escaped = value.replace(/`/g, '\\`').replace(/\|/g, '\\|');
  return `\`${escaped}\``;
}

/** Sanitize free-form text (event titles, URLs, selectors) for inline Markdown
 *  rendering: collapse newlines to spaces and escape backticks plus pipes so a
 *  malicious or quirky URL/selector cannot break list-item or table layout. */
function inline(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, ' ')
    .replace(/`/g, '\\`')
    .replace(/\|/g, '\\|');
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}\n`;
}

function ruleHitsTable(rows: RuleHitSummary[]): string {
  if (rows.length === 0) return '_No rule hits._';
  const lines: string[] = [
    '| Rule ID | Name | Applied | Skipped | Total | Types |',
    '| --- | --- | ---: | ---: | ---: | --- |',
  ];
  for (const r of rows) {
    lines.push(
      `| ${code(r.ruleId)} | ${cell(r.ruleName)} | ${r.applied} | ${r.skipped} | ${r.total} | ${cell(r.types.join(', ') || '-')} |`,
    );
  }
  return lines.join('\n');
}

function transportsTable(rows: TransportSummary[]): string {
  if (rows.length === 0) return '_No transport activity._';
  const lines: string[] = ['| Kind | Events | Applied |', '| --- | ---: | ---: |'];
  for (const r of rows) {
    lines.push(`| ${cell(r.kind)} | ${r.events} | ${r.applied} |`);
  }
  return lines.join('\n');
}

function skipReasonsTable(rows: SkipReasonSummary[]): string {
  if (rows.length === 0) return '_No skips recorded._';
  const lines: string[] = ['| Stage | Skipped at | Count |', '| --- | --- | ---: |'];
  for (const r of rows) {
    lines.push(`| ${cell(r.stage)} | ${cell(r.skippedAt)} | ${r.count} |`);
  }
  return lines.join('\n');
}

function failuresTable(rows: FailureSummary[]): string {
  if (rows.length === 0) return '_No failures recorded._';
  const lines: string[] = [
    '| Rule ID | Type | Status | Count | Sample URL |',
    '| --- | --- | ---: | ---: | --- |',
  ];
  for (const r of rows) {
    lines.push(
      `| ${code(r.ruleId)} | ${cell(r.type)} | ${cell(r.statusCode)} | ${r.count} | ${cell(r.sampleUrl)} |`,
    );
  }
  return lines.join('\n');
}

function timelineList(rows: TimelineEntry[]): string {
  if (rows.length === 0) return '_No events recorded._';
  return rows
    .map((entry) => {
      const rule = entry.ruleId ? ` (rule ${code(entry.ruleId)})` : '';
      return `- \`+${entry.offsetMs}ms\` ${inline(entry.title)}${rule}`;
    })
    .join('\n');
}

/** Serialize a `ChaosReport` to a deterministic Markdown document suitable for
 *  PR comments and CI logs. The same report always produces byte-identical
 *  output. */
export function formatReportMarkdown(report: ChaosReport): string {
  const { meta } = report;
  const title = meta.title ?? 'Chaos run';
  const header = [
    `# Chaos report: ${title}`,
    '',
    `- **Seed**: \`${meta.replaySnippet}\``,
    `- **Generated**: ${meta.generatedAt}`,
    `- **Events**: ${meta.eventCount} (applied ${meta.appliedCount}, skipped ${meta.skippedCount})`,
    `- **Duration**: ${meta.durationMs === null ? '-' : `${meta.durationMs} ms`}`,
    '',
  ].join('\n');

  const body = [
    section('Rule hits', ruleHitsTable(report.ruleHits)),
    section('Transports', transportsTable(report.transports)),
    section('Skip reasons', skipReasonsTable(report.skipReasons)),
    section('Failures', failuresTable(report.failures)),
    section('Timeline', timelineList(report.timeline)),
  ].join('\n');

  return `${header}${body}`;
}
