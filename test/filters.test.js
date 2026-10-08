import test from 'node:test';
import assert from 'node:assert/strict';
import { createFilters } from '../src/filters.js';
import { createIngestor } from '../src/ingestion.js';
import { fixture, waMessage } from './helpers.js';

test('name fragments match anywhere in a group title, ignoring case', () => {
  const filters = createFilters([' veli ']);
  for (const name of ['VELI GRUBU', '8/A VELI GRUBU', 'School veli group']) assert.equal(filters.matches(name), true);
  assert.equal(filters.matches('Unrelated group'), false);
});

test('Turkish I variants and composed/decomposed dotted I match consistently', () => {
  for (const term of ['veli', 'VELİ', 'velı', 'VELI\u0307']) {
    const filters = createFilters([term]);
    for (const name of ['VELI GRUBU', '8/A VELİ GRUBU', '8/A VELI\u0307 GRUBU', 'velı grubu']) {
      assert.equal(filters.matches(name), true, `${term} matches ${name}`);
    }
  }
  assert.equal(createFilters(['sen']).matches('ŞEN group'), false);
});

test('filters remain literal OR substrings and empty filters include every chat', () => {
  assert.equal(createFilters(['veli', 'school']).matches(null, 'School contact'), true);
  assert.equal(createFilters(['veli.*']).matches('VELI GRUBU'), false);
  assert.equal(createFilters([' ', '']).active, false);
  assert.equal(createFilters([]).matches(null), true);
});

test('group ingestion accepts matching name fragments and excludes unrelated groups', async (t) => {
  const f = fixture(t);
  const ingest = createIngestor({ store: f.store, filters: createFilters(['veli']) });
  const names = {
    'partial-title-one@g.us': 'VELI GRUBU',
    'partial-title-two@g.us': '8/A VELİ GRUBU',
    'partial-title-other@g.us': 'Unrelated group',
  };
  const sock = { groupMetadata: async (jid) => ({ subject: names[jid] }) };
  assert.equal(await ingest(Object.keys(names).map((jid, i) => waMessage(`partial-${i}`, { jid })), { sock }), 2);
  assert.deepEqual(f.store.messages().map((m) => m.jid), Object.keys(names).slice(0, 2));
});
