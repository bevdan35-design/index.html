'use strict';

const assert = require('node:assert/strict');
const Quire = require('../assets/js/pure.js');

const USD = { currency: 'USD', digits: 2, locale: 'en-US' };

function compute(partial) {
  return Quire.computeInvoice(Object.assign({ digits: 2, items: [], discountType: 'none', discountValue: '', taxRate: '' }, partial));
}

function codes(result) {
  return result.warnings.map((warning) => warning.code);
}

const sample = Quire.createSample();
const sampleTotal = Quire.computeInvoice({
  digits: 2,
  items: sample.items,
  discountType: sample.discount.type,
  discountValue: sample.discount.value,
  taxRate: sample.tax.rate
});
assert.equal(sampleTotal.subtotalMinor, 135000);
assert.equal(sampleTotal.discountMinor, 13500);
assert.equal(sampleTotal.netMinor, 121500);
assert.equal(sampleTotal.taxMinor, 9720);
assert.equal(sampleTotal.totalMinor, 131220);
assert.deepEqual(sampleTotal.warnings, []);
assert.equal(Quire.formatMoney(sampleTotal.totalMinor, USD), '$1,312.20');

assert.equal(compute({ items: [{ qty: '0.1', rate: '0.2' }] }).lines[0].minor, 2);
assert.equal(compute({ items: [{ qty: '1', rate: '1.005' }] }).lines[0].minor, 101);
assert.equal(compute({ items: [{ qty: '1.', rate: '75' }] }).lines[0].minor, 7500);
assert.equal(compute({ items: [{ qty: '', rate: '' }] }).lines[0].minor, 0);
assert.deepEqual(codes(compute({ items: [{ qty: '', rate: '' }] })), []);

const negative = compute({ items: [{ qty: '-1', rate: '20' }, { qty: '2', rate: '5' }] });
assert.equal(negative.lines[0].minor, 0);
assert.equal(negative.subtotalMinor, 1000);
assert.ok(codes(negative).includes('line-negative'));

const invalid = compute({ items: [{ qty: '12a', rate: '1' }] });
assert.ok(codes(invalid).includes('line-invalid'));
assert.equal(invalid.side || invalid.warnings[0].side, 'qty');

const yen = Quire.computeInvoice({ digits: 0, items: [{ qty: '1', rate: '75.5' }, { qty: '2', rate: '75.4' }], discountType: 'none', taxRate: '' });
assert.equal(yen.lines[0].minor, 76);
assert.equal(yen.lines[1].minor, 151);

const afterDiscount = compute({
  items: [{ qty: '1', rate: '100' }],
  discountType: 'percent',
  discountValue: '50',
  taxRate: '10'
});
assert.equal(afterDiscount.discountMinor, 5000);
assert.equal(afterDiscount.taxMinor, 500);
assert.equal(afterDiscount.totalMinor, 5500);

const cappedPercent = compute({ items: [{ qty: '1', rate: '80' }], discountType: 'percent', discountValue: '150' });
assert.equal(cappedPercent.discountMinor, 8000);
assert.equal(cappedPercent.totalMinor, 0);
assert.ok(codes(cappedPercent).includes('discount-percent-capped'));

const cappedAmount = compute({ items: [{ qty: '1', rate: '40' }], discountType: 'amount', discountValue: '55' });
assert.equal(cappedAmount.discountMinor, 4000);
assert.ok(codes(cappedAmount).includes('discount-amount-capped'));

assert.ok(codes(compute({ items: [{ qty: '1', rate: '10' }], discountType: 'amount', discountValue: 'nope' })).includes('discount-invalid'));
assert.ok(codes(compute({ taxRate: '-2', items: [{ qty: '1', rate: '10' }] })).includes('tax-negative'));
assert.ok(codes(compute({ items: [{ qty: '1', rate: '10' }], taxRate: '250' })).includes('tax-capped'));

const huge = compute({ items: [{ qty: '999999999999', rate: '999999999999' }] });
assert.ok(codes(huge).includes('overflow'));
assert.equal(huge.totalMinor, 0);

assert.equal(Quire.formatInvoiceNumber('INV-', 12, 3), 'INV-012');
assert.equal(Quire.formatInvoiceNumber('', 7, 4), '0007');
assert.equal(Quire.formatInvoiceNumber('INV-\n', 1, 3), 'INV-001');

assert.equal(Quire.addDaysISO('2026-01-31', 1), '2026-02-01');
assert.equal(Quire.addDaysISO('2026-11-25', 14), '2026-12-09');
assert.equal(Quire.parseISODate('2026-02-31'), null);
assert.equal(Quire.parseISODate('2026-11-25').getDate(), 25);
assert.equal(Quire.daysBetween('2026-11-25', '2026-12-09'), 14);
assert.deepEqual(Quire.dueStatus('2026-11-24', '2026-11-25'), { code: 'overdue', days: 1 });
assert.equal(Quire.dueStatus('2026-11-25', '2026-11-25').code, 'today');

assert.equal(Quire.formatMoney(1000, { currency: 'JPY', digits: 0, locale: 'en-US' }), '¥1,000');
assert.equal(Quire.formatMoney(1234, { currency: 'CUSTOM', digits: 2, locale: 'en-US', symbol: 'Ks' }), 'Ks\u00a012.34');
assert.equal(Quire.narrowSymbol('EUR', 'en-US'), '€');

const blank = Quire.createBlank(Quire.defaultSettings());
assert.equal(blank.number, 'INV-001');
assert.equal(Quire.isMeaningful(blank), false);
assert.equal(Quire.isMeaningful(sample), true);
const consumed = Quire.consumeNumber(blank, Quire.defaultSettings());
assert.equal(consumed.next, 2);
assert.equal(blank.numberConsumed, true);
const custom = Quire.createBlank(Quire.defaultSettings());
custom.number = 'ABC';
const skipped = Quire.consumeNumber(custom, Quire.defaultSettings());
assert.equal(skipped.next, 1);

const hostile = Quire.normalizeInvoice({
  from: { name: '<script>alert(1)</script>' },
  logo: 'data:image/svg+xml;base64,PHN2Zy8+',
  items: [{ description: 'ok', qty: '1', rate: '2' }]
});
assert.equal(hostile.from.name, '<script>alert(1)</script>');
assert.equal(hostile.logo, null);

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
assert.equal(Quire.cleanLogo(png), png);
assert.equal(Quire.cleanLogo('data:text/html;base64,AAAA'), null);

const tooMany = [];
for (let i = 0; i < 45; i += 1) tooMany.push({ description: 'Line ' + i, qty: '1', rate: '1' });
assert.equal(Quire.normalizeInvoice({ items: tooMany }).items.length, 40);

const state = Quire.normalizeState({
  version: 1,
  settings: { prefix: 'Q-', next: 4, pad: 4, template: 'stamp', paper: 'letter', currency: 'JPY' },
  drafts: [{ id: 'draft-one', to: { name: 'Ada' }, origin: 'sample', items: [{ qty: '1', rate: '3' }] }],
  ephemeral: { origin: 'sample', number: 'INV-1048' }
});
assert.equal(state.settings.prefix, 'Q-');
assert.equal(state.settings.next, 4);
assert.equal(state.settings.template, 'stamp');
assert.equal(state.settings.currency, 'JPY');
assert.equal(state.drafts[0].origin, 'user');
assert.equal(state.drafts[0].to.name, 'Ada');
assert.equal(state.ephemeral.origin, 'sample');
assert.equal(Quire.normalizeState({ version: 2, drafts: [] }), null);
assert.equal(Quire.normalizeState({ version: 1, drafts: 'nope' }), null);

const junk = Quire.normalizeSettings({ prefix: '', next: -5, pad: 99, currency: 'NOPE', template: 'fancy' });
assert.equal(junk.prefix, 'INV-');
assert.equal(junk.next, 1);
assert.equal(junk.pad, 8);
assert.equal(junk.currency, 'USD');
assert.equal(junk.template, 'rule');

console.log('pure.test.js: all assertions passed');
