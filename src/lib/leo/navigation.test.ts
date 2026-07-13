import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_CONSOLE_SECTION_DOMAINS,
  createDefaultConsoleSectionDomains,
  normalizeConsoleSectionDomain,
} from './navigation';

test('every Internal Console section defaults to the existing L1 surface', () => {
  assert.deepEqual(DEFAULT_CONSOLE_SECTION_DOMAINS, {
    realtime: 'l1',
    archive: 'l1',
    validation: 'l1',
  });
});

test('section-domain state copies are independent', () => {
  const first = createDefaultConsoleSectionDomains();
  first.realtime = 'leo';
  const second = createDefaultConsoleSectionDomains();
  assert.equal(second.realtime, 'l1');
  assert.equal(DEFAULT_CONSOLE_SECTION_DOMAINS.realtime, 'l1');
});

test('unknown persisted domains fail closed to L1', () => {
  assert.equal(normalizeConsoleSectionDomain('leo'), 'leo');
  assert.equal(normalizeConsoleSectionDomain('LEO'), 'l1');
  assert.equal(normalizeConsoleSectionDomain(null), 'l1');
});
