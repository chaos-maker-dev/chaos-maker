// Baseline  -  AUT without chaos. If these fail, chaos-specific failures
// elsewhere point at the page, not the adapter.
import { browser, $ } from '@wdio/globals';

describe('Resilience baseline', () => {
  it('fetches and displays data without chaos', async () => {
    await browser.url('/');
    await $('#fetch-data').click();
    await expect($('#status')).toHaveText('Success!');
    await expect($('#result')).toHaveTextContaining('"userId": 1');
  });

  it('XHR fetches data without chaos', async () => {
    await browser.url('/');
    await $('#xhr-get').click();
    await expect($('#xhr-status')).toHaveText('Success!');
    await expect($('#xhr-result')).toHaveTextContaining('"userId": 1');
  });
});
