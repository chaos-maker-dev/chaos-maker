import type { ChaosReport } from './types';

export interface FormatReportJsonOptions {
  /** When true (default), output is indented with two spaces and ends with a
   *  trailing newline so the file is diff-friendly. When false, output is a
   *  single compact line with no trailing newline. */
  pretty?: boolean;
}

/** Serialize a `ChaosReport` to JSON. Output is deterministic: a fixed report
 *  always produces byte-identical output. Key order is preserved because every
 *  field in the report is created in the same order by `buildChaosReport`. */
export function formatReportJson(
  report: ChaosReport,
  opts: FormatReportJsonOptions = {},
): string {
  const pretty = opts.pretty ?? true;
  if (pretty) {
    return JSON.stringify(report, null, 2) + '\n';
  }
  return JSON.stringify(report);
}
