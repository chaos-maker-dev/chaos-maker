import type {
  ChaosReport,
  ConnectionSummary,
  FailureSummary,
  PhaseSummary,
  RuleHitSummary,
  SkipReasonSummary,
  StreamingReadinessSummary,
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
      const phase = entry.phase ? ` ${code(entry.phase)}` : '';
      const chunk = entry.chunkIndex !== null ? ` chunk ${entry.chunkIndex}` : '';
      return `- \`+${entry.offsetMs}ms\` ${inline(entry.title)}${rule}${phase}${chunk}`;
    })
    .join('\n');
}

function phasesTable(rows: PhaseSummary[]): string {
  const lines: string[] = [
    '| Phase | Transport | Count | Applied |',
    '| --- | --- | ---: | ---: |',
  ];
  for (const r of rows) {
    lines.push(`| ${code(r.phase)} | ${cell(r.transport)} | ${r.count} | ${r.applied} |`);
  }
  return lines.join('\n');
}

function connectionLine(c: ConnectionSummary): string {
  const flags: string[] = [];
  if (c.truncated) flags.push('truncated');
  if (c.replayed) flags.push('replayed');
  if (c.unresolvedPauses > 0) flags.push(`${c.unresolvedPauses} unresolved pause(s)`);
  const flagText = flags.length ? ` **${flags.join(', ')}**` : '';
  const firstChunk = c.firstChunkOffsetMs === null ? '-' : `+${c.firstChunkOffsetMs}ms`;
  return [
    `### Connection ${code(c.connectionId)} (${cell(c.transport)})${flagText}`,
    '',
    `- URL: ${c.url ? code(c.url) : '-'}`,
    `- Events: ${c.events}, first chunk at ${firstChunk}, pauses ${c.pauses}`,
    '',
    c.entries
      .map((e) => {
        const phase = e.phase ? ` ${code(e.phase)}` : '';
        const chunk = e.chunkIndex !== null ? ` chunk ${e.chunkIndex}` : '';
        return `- \`+${e.offsetMs}ms\` ${inline(e.title)}${phase}${chunk}`;
      })
      .join('\n'),
  ].join('\n');
}

function connectionsBlock(rows: ConnectionSummary[]): string {
  return rows.map(connectionLine).join('\n\n');
}

function readinessBlock(r: StreamingReadinessSummary): string {
  const lines: string[] = [
    `- **Connections**: ${r.connections} (${r.completedWithoutInterruption} completed without interruption)`,
    `- **Truncated**: ${r.truncated}`,
    `- **Replayed**: ${r.replayed}`,
    `- **Unresolved pauses**: ${r.unresolvedPauses}`,
    '',
    '| Transport | Connections | Truncated | Replayed | Unresolved pauses |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const t of r.byTransport) {
    lines.push(`| ${cell(t.kind)} | ${t.connections} | ${t.truncated} | ${t.replayed} | ${t.unresolvedPauses} |`);
  }
  return lines.join('\n');
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

  const sections = [
    section('Rule hits', ruleHitsTable(report.ruleHits)),
    section('Transports', transportsTable(report.transports)),
    section('Skip reasons', skipReasonsTable(report.skipReasons)),
    section('Failures', failuresTable(report.failures)),
  ];
  // Streaming sections render only when the run streamed something, so
  // non-streaming reports stay byte-identical to previous releases.
  if (report.phases.length > 0) {
    sections.push(section('Streaming phases', phasesTable(report.phases)));
  }
  if (report.streamingReadiness) {
    sections.push(section('Streaming readiness', readinessBlock(report.streamingReadiness)));
  }
  if (report.connections.length > 0) {
    sections.push(section('Connections', connectionsBlock(report.connections)));
  }
  sections.push(section('Timeline', timelineList(report.timeline)));

  return `${header}${sections.join('\n')}`;
}
