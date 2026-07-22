import assert from 'node:assert/strict';
import test from 'node:test';
import { phoneDigitsMatch, QUOTE_SUBMIT_TEXT } from '../modules/form-fill-helpers.js';
import { classifyCheckOutcome, classifyFormOutcome } from './outcomes.js';

test('429 is rate limited but 503 remains a site failure', () => {
  assert.equal(
    classifyCheckOutcome({
      statusCode: 429,
      completedSuccessfully: false,
      egressVerified: true,
    }),
    'rate_limited'
  );
  assert.equal(
    classifyCheckOutcome({
      statusCode: 429,
      completedSuccessfully: false,
      egressVerified: false,
    }),
    'rate_limited'
  );
  assert.equal(
    classifyCheckOutcome({
      statusCode: 503,
      completedSuccessfully: false,
      egressVerified: true,
    }),
    'site_failure'
  );
});

test('unverified egress is monitor error even when target loaded', () => {
  assert.equal(
    classifyCheckOutcome({
      statusCode: 200,
      completedSuccessfully: true,
      egressVerified: false,
    }),
    'monitor_error'
  );
});

test('recognizes common quote-form submit labels case-insensitively', () => {
  for (const label of [
    'GET MY FREE MOCKUP',
    'Get Free Mockup',
    'get mockup',
    'Submit',
    'submit now',
    'Submit and Get Free Mockup',
    'GET FREE QUOTES & MOCKUPS',
  ]) {
    assert.match(label, QUOTE_SUBMIT_TEXT);
  }
});

test('confirmed form submission wins while retaining unverified egress metadata', () => {
  assert.equal(
    classifyFormOutcome({
      statusCode: 200,
      submissionConfirmed: true,
      monitorError: true,
      egressVerified: false,
    }),
    'success'
  );
});

test('verifies formatted phone fields by their digits', () => {
  assert.equal(phoneDigitsMatch('(555) 010-0100', '5550100100'), true);
  assert.equal(phoneDigitsMatch('(555) 555-1234', '+1 555 555 1234'), true);
  assert.equal(phoneDigitsMatch('', '5550100100'), false);
  assert.equal(phoneDigitsMatch('5550109999', '5550100100'), false);
});
