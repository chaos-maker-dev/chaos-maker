import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import {
  buildChaosReport,
  filterEventsByTransport,
  formatReportHtml,
  formatReportJson,
  formatReportMarkdown,
  getChaosLog,
  getChaosSeed,
  injectChaos,
} from '@chaos-maker/playwright';

const BASE_URL = 'http://127.0.0.1:8080';
const API_PATTERN = '/api/data.json';

test.describe('Chaos reporting utilities', () => {
  test('buildChaosReport produces a stable structured report from a real run', async ({ page }) => {
    await injectChaos(page, {
      seed: 7,
      debug: true,
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0 }],
        latencies: [{ urlPattern: API_PATTERN, delayMs: 10, probability: 0 }],
      },
    });
    await page.goto(BASE_URL);

    for (let i = 0; i < 3; i++) {
      await page.click('#fetch-data');
      await expect(page.locator('#status')).toHaveText('Error!');
    }

    const events = await getChaosLog(page);
    const seed = await getChaosSeed(page);
    const report = buildChaosReport(events, { seed, title: 'reporting e2e', now: 1_700_000_000_000 });

    expect(report.meta.seed).toBe(seed);
    expect(report.meta.title).toBe('reporting e2e');
    expect(report.meta.eventCount).toBe(events.length);
    expect(report.meta.appliedCount).toBeGreaterThanOrEqual(3);
    expect(report.meta.replaySnippet).toBe(`chaos seed: ${seed}`);

    const failureHits = report.ruleHits.find((r) => r.types.includes('failure'));
    expect(failureHits, 'expected at least one failure rule hit').toBeDefined();
    expect(failureHits!.applied).toBeGreaterThanOrEqual(3);

    const networkRow = report.transports.find((r) => r.kind === 'network');
    expect(networkRow, 'expected a network transport row').toBeDefined();
    expect(networkRow!.events).toBeGreaterThanOrEqual(3);
    expect(networkRow!.applied).toBeGreaterThanOrEqual(3);

    expect(report.failures.some((f) => f.statusCode === 503)).toBe(true);
    expect(report.timeline.length).toBe(events.length);
    expect(report.timeline[0].offsetMs).toBe(0);
  });

  test('filterEventsByTransport narrows to a single bucket', async ({ page }) => {
    await injectChaos(page, {
      seed: 11,
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 500, probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');
    await expect(page.locator('#status')).toHaveText('Error!');

    const events = await getChaosLog(page);
    const networkOnly = filterEventsByTransport(events, 'network');
    expect(networkOnly.length).toBeGreaterThan(0);
    expect(networkOnly.every((e) => e.type.startsWith('network:'))).toBe(true);
    expect(filterEventsByTransport(events, 'websocket')).toEqual([]);
  });

  test('formatReportJson / Markdown / Html each emit valid documents', async ({ page }, testInfo) => {
    await injectChaos(page, {
      seed: 19,
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');
    await expect(page.locator('#status')).toHaveText('Error!');

    const events = await getChaosLog(page);
    const seed = await getChaosSeed(page);
    const report = buildChaosReport(events, { seed, title: 'reporting e2e: formats' });

    const json = formatReportJson(report);
    const md = formatReportMarkdown(report);
    const html = formatReportHtml(report);

    expect(() => JSON.parse(json)).not.toThrow();
    expect(md).toContain('# Chaos report: reporting e2e: formats');
    expect(md).toContain('## Rule hits');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Chaos report: reporting e2e: formats</title>');
    expect(html.toLowerCase()).not.toContain('<script');

    const outDir = testInfo.outputDir;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'report.json'), json);
    writeFileSync(join(outDir, 'report.md'), md);
    writeFileSync(join(outDir, 'report.html'), html);
    await testInfo.attach('chaos-report.json', { path: join(outDir, 'report.json'), contentType: 'application/json' });
    await testInfo.attach('chaos-report.md', { path: join(outDir, 'report.md'), contentType: 'text/markdown' });
    await testInfo.attach('chaos-report.html', { path: join(outDir, 'report.html'), contentType: 'text/html' });
  });
});
