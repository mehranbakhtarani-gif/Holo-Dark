import assert from 'node:assert/strict';
import { getSafeRuntimeErrorMessage } from '../src/lib/uiRuntimeSafety';

const production = getSafeRuntimeErrorMessage(new Error('sensitive backend response'), true);
assert.equal(production, 'خطای غیرمنتظره رخ داد. لطفاً دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.');

const development = getSafeRuntimeErrorMessage(
  new Error('request failed: Bearer abc.def.ghi api_key=super-secret'),
  false,
);
assert.match(development, /Bearer \[REDACTED\]/);
assert.match(development, /api_key=\[REDACTED\]/);
assert.ok(!development.includes('super-secret'));
assert.equal(getSafeRuntimeErrorMessage('', false), 'خطای غیرمنتظره رخ داد. لطفاً دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.');
console.log('UI runtime safety tests passed');
