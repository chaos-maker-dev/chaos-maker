import { test, expect, type Page } from '@playwright/test';
import { injectChaos, getChaosLog } from '@chaos-maker/playwright';

const BASE_URL = 'http://127.0.0.1:8080';
const GQL_URL_PATTERN = '127.0.0.1:8083/graphql';

async function fireOp(page: Page, buttonId: string, expectedStatus: 'ok' | 'error' = 'ok'): Promise<string> {
  await page.click(`#${buttonId}`);
  await expect(page.locator('#gql-status')).toContainText(expectedStatus);
  return (await page.locator('#gql-result').textContent()) ?? '';
}

// ---------------------------------------------------------------------------
// Operation-name matching in isolation: GetUser fails, GetProducts succeeds.
// ---------------------------------------------------------------------------
test.describe('GraphQL operation matching', () => {
  test('fails only the matching operation; others pass through', async ({ page }) => {
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

    // GetUser → 503 chaos.
    await fireOp(page, 'gql-get-user', 'error');
    await expect(page.locator('#gql-status')).toContainText('503');

    // SearchProducts → real server response (200).
    await fireOp(page, 'gql-search-products');
    await expect(page.locator('#gql-status')).toContainText('200');
    await expect(page.locator('#gql-result')).toContainText('Gizmo');

    const log = await getChaosLog(page);
    const failures = log.filter(e => e.type === 'network:failure' && e.applied);
    expect(failures).toHaveLength(1);
    expect(failures[0].detail.operationName).toBe('GetUser');
  });

  test('matches via a RegExp when the operation name starts with Get', async ({ page }) => {
    // RegExp matchers now ride through `injectChaos` directly via the
    // serializeForTransport / deserializeForTransport round-trip.
    await injectChaos(page, {
      network: {
        failures: [{
          urlPattern: GQL_URL_PATTERN,
          statusCode: 502,
          probability: 1,
          graphqlOperation: /^Get/,
        }],
      },
    });
    await page.goto(BASE_URL);

    await fireOp(page, 'gql-get-user', 'error');
    await expect(page.locator('#gql-status')).toContainText('502');

    // CreatePost should pass  -  doesn't match /^Get/.
    await fireOp(page, 'gql-create-post');
    await expect(page.locator('#gql-status')).toContainText('200');
  });

  test('combines urlPattern + methods + graphqlOperation as AND filters', async ({ page }) => {
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

    // POST GetUser → 401.
    await fireOp(page, 'gql-get-user', 'error');
    await expect(page.locator('#gql-status')).toContainText('401');

    // GET persisted GetUser → still 200 (methods includes only POST).
    await fireOp(page, 'gql-persisted-get');
    await expect(page.locator('#gql-status')).toContainText('200');
  });

  test('persisted-query GET ?operationName= matches when methods is [GET]', async ({ page }) => {
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

    await fireOp(page, 'gql-persisted-get', 'error');
    await expect(page.locator('#gql-status')).toContainText('504');

    const log = await getChaosLog(page);
    const failures = log.filter(e => e.type === 'network:failure' && e.applied);
    expect(failures.length).toBe(1);
    expect(failures[0].detail.operationName).toBe('GetUser');
  });

  test('multipart upload emits a graphql-body-unparseable diagnostic and does not chaos', async ({ page }) => {
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

    await page.click('#gql-multipart');
    // Wait for status to leave loading state  -  server returns 400 because the
    // fixture isn't a real graphql-multipart implementation, but that's fine:
    // the test cares that chaos's 599 was NOT injected over the real response.
    await page.waitForFunction(
      () => /^(ok |error |network-error)/.test(document.getElementById('gql-status')?.textContent ?? ''),
    );
    const status = await page.locator('#gql-status').textContent();
    expect(status).not.toContain('599');

    const log = await getChaosLog(page);
    const diag = log.find(e => e.detail.reason === 'graphql-body-unparseable');
    expect(diag).toBeDefined();
    expect(diag?.applied).toBe(false);
    expect(diag?.type).toBe('network:failure');
  });

  test('skips an anonymous query when matcher is set', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{
          urlPattern: GQL_URL_PATTERN,
          statusCode: 500,
          probability: 1,
          graphqlOperation: 'GetUser',
        }],
      },
    });
    await page.goto(BASE_URL);

    await fireOp(page, 'gql-anonymous');
    await expect(page.locator('#gql-status')).toContainText('200');
  });

  test('XHR POST GraphQL also matches by operationName', async ({ page }) => {
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

    await fireOp(page, 'gql-xhr-get-user', 'error');
    await expect(page.locator('#gql-status')).toContainText('503');

    const log = await getChaosLog(page);
    const failures = log.filter(e => e.type === 'network:failure' && e.applied);
    expect(failures[0].detail.operationName).toBe('GetUser');
  });
});
