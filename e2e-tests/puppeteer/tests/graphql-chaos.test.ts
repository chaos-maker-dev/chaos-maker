import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { injectChaos, getChaosLog } from '@chaos-maker/puppeteer';
import type { ChaosEvent } from '@chaos-maker/core';
import { launchBrowser, BASE_URL, getText } from './helpers';

const GQL_URL_PATTERN = '127.0.0.1:8083/graphql';

let browser: Browser;
let page: Page;

beforeAll(async () => { browser = await launchBrowser(); });
afterAll(async () => { await browser.close(); });

beforeEach(async () => { page = await browser.newPage(); });
afterEach(async () => { await page.close(); });

async function fireOp(p: Page, buttonId: string): Promise<void> {
  await p.click(`#${buttonId}`);
  // Status flips from "loading …" to either "ok …", "error …", or "network-error".
  await p.waitForFunction(
    () => {
      const t = document.getElementById('gql-status')?.textContent ?? '';
      return /^(ok |error |network-error|xhr ok |xhr error |xhr network-error)/.test(t);
    },
    { timeout: 10_000 },
  );
}

describe('GraphQL operation matching', () => {
  it('fails only the matching operation; others pass through', async () => {
    await injectChaos(page, {
      network: {
        failures: [{
          urlPattern: GQL_URL_PATTERN,
          statusCode: 503,
          probability: 1,
          graphqlOperation: 'GetUser',
        }],
      },
    });
    await page.goto(BASE_URL);

    await fireOp(page, 'gql-get-user');
    expect(await getText(page, '#gql-status')).toContain('503');

    await fireOp(page, 'gql-search-products');
    expect(await getText(page, '#gql-status')).toContain('200');

    const log = (await getChaosLog(page)) as ChaosEvent[];
    const failures = log.filter((e) => e.type === 'network:failure' && e.applied);
    expect(failures).toHaveLength(1);
    expect(failures[0].detail.operationName).toBe('GetUser');
  });

  it('combines methods + graphqlOperation as AND filters', async () => {
    await injectChaos(page, {
      network: {
        failures: [{
          urlPattern: GQL_URL_PATTERN,
          methods: ['POST'],
          statusCode: 401,
          probability: 1,
          graphqlOperation: 'GetUser',
        }],
      },
    });
    await page.goto(BASE_URL);

    await fireOp(page, 'gql-get-user');
    expect(await getText(page, '#gql-status')).toContain('401');

    await fireOp(page, 'gql-persisted-get');
    expect(await getText(page, '#gql-status')).toContain('200');
  });

  it('persisted-query GET ?operationName= matches with methods=[GET]', async () => {
    await injectChaos(page, {
      network: {
        failures: [{
          urlPattern: GQL_URL_PATTERN,
          methods: ['GET'],
          statusCode: 504,
          probability: 1,
          graphqlOperation: 'GetUser',
        }],
      },
    });
    await page.goto(BASE_URL);

    await fireOp(page, 'gql-persisted-get');
    expect(await getText(page, '#gql-status')).toContain('504');
    const log = (await getChaosLog(page)) as ChaosEvent[];
    const failures = log.filter((e) => e.type === 'network:failure' && e.applied);
    expect(failures.length).toBe(1);
    expect(failures[0].detail.operationName).toBe('GetUser');
  });

  it('multipart upload emits a graphql-body-unparseable diagnostic', async () => {
    await injectChaos(page, {
      network: {
        failures: [{
          urlPattern: GQL_URL_PATTERN,
          statusCode: 599,
          probability: 1,
          graphqlOperation: 'CreatePost',
        }],
      },
    });
    await page.goto(BASE_URL);

    await fireOp(page, 'gql-multipart');
    // Server returns 400 because the fixture isn't a real multipart impl  - 
    // test only cares that chaos's 599 was NOT injected over the real response.
    expect(await getText(page, '#gql-status')).not.toContain('599');

    const log = (await getChaosLog(page)) as ChaosEvent[];
    const diag = log.find((e) => e.detail.reason === 'graphql-body-unparseable');
    expect(diag).toBeDefined();
    expect(diag?.applied).toBe(false);
    expect(diag?.type).toBe('network:failure');
  });

  it('XHR POST GraphQL matches by operationName', async () => {
    await injectChaos(page, {
      network: {
        failures: [{
          urlPattern: GQL_URL_PATTERN,
          statusCode: 503,
          probability: 1,
          graphqlOperation: 'GetUser',
        }],
      },
    });
    await page.goto(BASE_URL);

    await fireOp(page, 'gql-xhr-get-user');
    expect(await getText(page, '#gql-status')).toContain('503');
    const log = (await getChaosLog(page)) as ChaosEvent[];
    const failures = log.filter((e) => e.type === 'network:failure' && e.applied);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].detail.operationName).toBe('GetUser');
  });
});
