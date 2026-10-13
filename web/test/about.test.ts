// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'bun:test';
import { swUrl } from '../src/about';

test('every deploy gets its own service worker, even under the same version', () => {
  const before = swUrl({ version: '0.3.0', commit: 'd8c0750bae699470c26a6d70d23384e7311efd43' });
  const after = swUrl({ version: '0.3.0', commit: 'd19698d80c5e06fb44dc43a0e08e329cf90002f3' });
  expect(before).toBe('./sw.js?v=0.3.0&b=d8c0750bae69');
  expect(after).not.toBe(before);
  expect(swUrl({ version: '0.4.0-rc.1', commit: 'unknown' })).toBe('./sw.js?v=0.4.0-rc.1');
});
