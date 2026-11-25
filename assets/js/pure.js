/* Quire's dependency-free model.
   Money is calculated from decimal strings in minor units (cents, yen, …)
   so 0.1 × 0.2 does not drift. Nothing in this file touches the network
   or the DOM. Invoice text is stored as plain strings and later inserted
   with textContent only. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Quire = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_MINOR = 1000000000000n;

  var LIMITS = {
    name: 120,
    address: 400,
    contact: 120,
    taxId: 60,
    number: 40,
    po: 40,
    notes: 800,
    payment: 800,
    footer: 160,
    description: 400,
    prefix: 12,
    symbol: 8,
    taxLabel: 40,
    items: 40,
    drafts: 30,
    logo: 380000,
    padMax: 8,
    seqMax: 999999,
    decimal: 16
  };

  var CURRENCIES = [
    { code: 'USD', digits: 2, label: 'US dollar' },
    { code: 'EUR', digits: 2, label: 'Euro' },
    { code: 'GBP', digits: 2, label: 'British pound' },
    { code: 'CAD', digits: 2, label: 'Canadian dollar' },
    { code: 'AUD', digits: 2, label: 'Australian dollar' },
    { code: 'NZD', digits: 2, label: 'New Zealand dollar' },
    { code: 'CHF', digits: 2, label: 'Swiss franc' },
    { code: 'SEK', digits: 2, label: 'Swedish krona' },
    { code: 'NOK', digits: 2, label: 'Norwegian krone' },
    { code: 'DKK', digits: 2, label: 'Danish krone' },
    { code: 'JPY', digits: 0, label: 'Japanese yen' },
    { code: 'CNY', digits: 2, label: 'Chinese yuan' },
    { code: 'INR', digits: 2, label: 'Indian rupee' },
    { code: 'MXN', digits: 2, label: 'Mexican peso' },
    { code: 'BRL', digits: 2, label: 'Brazilian real' },
    { code: 'ZAR', digits: 2, label: 'South African rand' },
    { code: 'SGD', digits: 2, label: 'Singapore dollar' },
    { code: 'HKD', digits: 2, label: 'Hong Kong dollar' },
    { code: 'KRW', digits: 0, label: 'South Korean won' },
    { code: 'CUSTOM', digits: 2, label: 'Other symbol' }
  ];

  var WARNING_TEXT = {
    'line-negative': 'Quantities and rates cannot be negative.',
    'line-invalid': 'Use a decimal point for quantities and rates, for example 1.5 or 75.00.',
    'discount-negative': 'A discount cannot be negative.',
    'discount-invalid': 'Enter the discount as a number.',
    'discount-percent-capped': 'Percent discounts are capped at 100%.',
    'discount-amount-capped': 'The discount is capped so it cannot exceed the subtotal.',
    'tax-negative': 'The tax rate cannot be negative.',
    'tax-invalid': 'Enter the tax rate as a number.',
    'tax-capped': 'Tax is capped at 100% in this version.',
    overflow: 'That amount is too large to calculate.'
  };

  var TEMPLATES = {
    rule: 'Ledger',
    stamp: 'Seal',
    quiet: 'Plain'
  };

  var DEFAULT_FOOTER = 'Thank you for your business.';
  var LOGO_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
  var ID_RE = /^[A-Za-z0-9-]{8,80}$/;

  function currencyByCode(code) {
    for (var i = 0; i < CURRENCIES.length; i += 1) {
      if (CURRENCIES[i].code === code) return CURRENCIES[i];
    }
    return null;
  }

  function clampInt(value, min, max, fallback) {
    var n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max);
  }

  function createId() {
    if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  function cleanLogo(value) {
    if (typeof value !== 'string') return null;
    var compact = value.replace(/\s/g, '');
    if (compact.length < 32 || compact.length > LIMITS.logo) return null;
    if (!LOGO_RE.test(compact)) return null;
    return compact;
  }

  /* Accepts "1", "1.", "1.5", ".5", "1,200.50". Rejects letters and negatives. */
  function parseDecimal(input) {
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) return { ok: false, code: 'invalid' };
      input = String(input);
    }
    if (typeof input !== 'string') return { ok: false, code: 'invalid' };
    var original = input.trim().replace(/,/g, '');
    if (original === '') return { ok: true, blank: true };
    var sign = 1;
    var t = original;
    if (t.charAt(0) === '+') t = t.slice(1);
    else if (t.charAt(0) === '-') {
      sign = -1;
      t = t.slice(1);
    }
    if (t === '' || t === '.') return { ok: true, blank: true, incomplete: true };
    var incomplete = t.charAt(t.length - 1) === '.';
    if (incomplete) t = t.slice(0, -1);
    if (!/^(\d+(\.\d+)?|\.\d+)$/.test(t)) return { ok: false, code: 'invalid' };
    if (sign < 0) return { ok: false, code: 'negative' };
    var pieces = t.split('.');
    var whole = pieces[0];
    var frac = pieces[1] || '';
    var digits = (whole + frac).replace(/^0+(?=\d)/, '');
    return { ok: true, digits: digits, scale: frac.length, incomplete: incomplete };
  }

  function rescale(value, fromScale, toScale) {
    if (value < 0n) {
      var neg = new Error('negative');
      neg.code = 'negative';
      throw neg;
    }
    var next = value;
    if (toScale > fromScale) next = value * (10n ** BigInt(toScale - fromScale));
    else if (toScale < fromScale) {
      var base = 10n ** BigInt(fromScale - toScale);
      var q = value / base;
      var r = value % base;
      next = r * 2n >= base ? q + 1n : q;
    }
    if (next > MAX_MINOR) {
      var err = new Error('overflow');
      err.code = 'overflow';
      throw err;
    }
    return next;
  }

  function amountToMinor(input, outScale) {
    var parsed = parseDecimal(input);
    if (!parsed.ok) return { ok: false, minor: 0, code: parsed.code };
    if (parsed.blank) return { ok: true, minor: 0, blank: true, incomplete: !!parsed.incomplete };
    try {
      return { ok: true, minor: Number(rescale(BigInt(parsed.digits), parsed.scale, outScale)), incomplete: !!parsed.incomplete };
    } catch (err) {
      return { ok: false, minor: 0, code: 'overflow' };
    }
  }

  function multiplyToMinor(qty, rate, outScale) {
    var left = parseDecimal(qty);
    var right = parseDecimal(rate);
    var problems = [];
    if (!left.ok) problems.push({ code: left.code, side: 'qty' });
    if (!right.ok) problems.push({ code: right.code, side: 'rate' });
    if (problems.length) return { ok: false, minor: 0, problems: problems };
    if (left.blank || right.blank) {
      return { ok: true, minor: 0, blank: !!(left.blank && right.blank), incomplete: !!(left.incomplete || right.incomplete) };
    }
    try {
      var prod = BigInt(left.digits) * BigInt(right.digits);
      var minor = rescale(prod, left.scale + right.scale, outScale);
      return { ok: true, minor: Number(minor), incomplete: !!(left.incomplete || right.incomplete) };
    } catch (err) {
      return { ok: false, minor: 0, problems: [{ code: 'overflow' }] };
    }
  }

  function percentOfMinor(minor, percentInput) {
    var parsed = parseDecimal(percentInput);
    if (!parsed.ok) return { ok: false, minor: 0, code: parsed.code };
    if (parsed.blank) return { ok: true, minor: 0, blank: true };
    var hundred = 100n * (10n ** BigInt(parsed.scale));
    var digits = BigInt(parsed.digits);
    var used = digits;
    var capped = false;
    if (digits > hundred) {
      used = hundred;
      capped = true;
    }
    try {
      var num = BigInt(minor) * used;
      return { ok: true, minor: Number(rescale(num, parsed.scale + 2, 0)), capped: capped };
    } catch (err) {
      return { ok: false, minor: 0, code: 'overflow' };
    }
  }

  function computeInvoice(input) {
    var digits = clampInt(input && input.digits, 0, 4, 2);
    var items = input && Array.isArray(input.items) ? input.items : [];
    var lines = [];
    var warnings = [];
    var subtotal = 0n;

    items.forEach(function (item, index) {
      var result = multiplyToMinor(item && item.qty, item && item.rate, digits);
      if (!result.ok) {
        lines.push({ minor: 0 });
        result.problems.forEach(function (problem) {
          var code = problem.code === 'negative' ? 'line-negative' : problem.code === 'overflow' ? 'overflow' : 'line-invalid';
          warnings.push({ code: code, index: index, side: problem.side || null });
        });
        return;
      }
      var minor = BigInt(result.minor);
      if (subtotal + minor > MAX_MINOR) {
        lines.push({ minor: 0 });
        warnings.push({ code: 'overflow', index: index });
        return;
      }
      subtotal += minor;
      lines.push({ minor: Number(minor), blank: !!result.blank });
    });

    var discount = 0n;
    var type = input && input.discountType ? input.discountType : 'none';
    if (type === 'percent') {
      var percent = percentOfMinor(Number(subtotal), input.discountValue);
      if (!percent.ok) warnings.push({ code: percent.code === 'negative' ? 'discount-negative' : percent.code === 'overflow' ? 'overflow' : 'discount-invalid' });
      else {
        discount = BigInt(percent.minor);
        if (percent.capped && !percent.blank) warnings.push({ code: 'discount-percent-capped' });
      }
    } else if (type === 'amount') {
      var fixed = amountToMinor(input.discountValue, digits);
      if (!fixed.ok) warnings.push({ code: fixed.code === 'negative' ? 'discount-negative' : fixed.code === 'overflow' ? 'overflow' : 'discount-invalid' });
      else {
        discount = BigInt(fixed.minor);
        if (discount > subtotal) {
          discount = subtotal;
          if (!fixed.blank) warnings.push({ code: 'discount-amount-capped' });
        }
      }
    }
    if (discount > subtotal) discount = subtotal;
    var net = subtotal - discount;

    var tax = 0n;
    var taxResult = percentOfMinor(Number(net), input && input.taxRate);
    if (!taxResult.ok) warnings.push({ code: taxResult.code === 'negative' ? 'tax-negative' : taxResult.code === 'overflow' ? 'overflow' : 'tax-invalid' });
    else {
      tax = BigInt(taxResult.minor);
      if (taxResult.capped && !taxResult.blank) warnings.push({ code: 'tax-capped' });
    }

    return {
      lines: lines,
      subtotalMinor: Number(subtotal),
      discountMinor: Number(discount),
      netMinor: Number(net),
      taxMinor: Number(tax),
      totalMinor: Number(net + tax),
      warnings: warnings
    };
  }

  function formatMoney(minor, options) {
    var opts = options || {};
    var digits = clampInt(opts.digits, 0, 4, 2);
    var negative = Number(minor) < 0;
    var value = Math.abs(Number(minor)) / Math.pow(10, digits);
    var locale = opts.locale;
    var body;
    if (!opts.currency || opts.currency === 'CUSTOM') {
      var symbol = typeof opts.symbol === 'string' ? opts.symbol : '';
      var spaced = /^[A-Za-z]{2,}$/.test(symbol) ? symbol + '\u00a0' : symbol;
      body = spaced + value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    } else {
      body = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: opts.currency,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
      }).format(value);
    }
    return negative ? '-' + body : body;
  }

  function narrowSymbol(code, locale) {
    if (!code || code === 'CUSTOM') return '';
    try {
      var parts = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: code,
        currencyDisplay: 'narrowSymbol'
      }).formatToParts(0);
      for (var i = 0; i < parts.length; i += 1) {
        if (parts[i].type === 'currency') return parts[i].value;
      }
    } catch (err) {
      return code;
    }
    return code;
  }

  function digitsFor(invoice) {
    if (!invoice) return 2;
    if (invoice.currency === 'CUSTOM') return invoice.customDigits === 0 ? 0 : 2;
    var known = currencyByCode(invoice.currency);
    return known ? known.digits : 2;
  }

  function formatInvoiceNumber(prefix, seq, pad) {
    var p = cleanText(typeof prefix === 'string' ? prefix : '', LIMITS.prefix).replace(/[\r\n]+/g, '');
    var n = clampInt(seq, 0, LIMITS.seqMax, 0);
    var width = clampInt(pad, 1, LIMITS.padMax, 3);
    var text = String(n);
    while (text.length < width) text = '0' + text;
    return p + text;
  }

  function isoFromLocal(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1);
    var d = String(date.getDate());
    if (m.length < 2) m = '0' + m;
    if (d.length < 2) d = '0' + d;
    return y + '-' + m + '-' + d;
  }

  function todayISO(now) {
    return isoFromLocal(now instanceof Date ? now : new Date());
  }

  function parseISODate(iso) {
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    var parts = iso.split('-');
    var y = Number(parts[0]);
    var m = Number(parts[1]);
    var d = Number(parts[2]);
    var date = new Date(y, m - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
    return date;
  }

  function addDaysISO(iso, days) {
    var date = parseISODate(iso);
    if (!date || !Number.isFinite(Number(days))) return '';
    date.setDate(date.getDate() + Number(days));
    return isoFromLocal(date);
  }

  function formatLongDate(iso, locale) {
    var date = parseISODate(iso);
    if (!date) return '';
    return date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function daysBetween(fromIso, toIso) {
    var a = parseISODate(fromIso);
    var b = parseISODate(toIso);
    if (!a || !b) return null;
    var ms = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    return Math.round(ms / 86400000);
  }

  function dueStatus(due, today) {
    var delta = daysBetween(today, due);
    if (delta === null) return null;
    if (delta < 0) return { code: 'overdue', days: -delta };
    if (delta === 0) return { code: 'today', days: 0 };
    return { code: 'upcoming', days: delta };
  }

  function defaultSettings() {
    return {
      prefix: 'INV-',
      next: 1,
      pad: 3,
      currency: 'USD',
      customSymbol: '$',
      customDigits: 2,
      template: 'rule',
      paper: 'a4'
    };
  }

  function normalizeSettings(raw) {
    var base = defaultSettings();
    if (!raw || typeof raw !== 'object') return base;
    var prefix = cleanText(raw.prefix, LIMITS.prefix).replace(/[\r\n]+/g, '').trim();
    base.prefix = prefix || 'INV-';
    base.next = clampInt(raw.next, 1, LIMITS.seqMax, 1);
    base.pad = clampInt(raw.pad, 1, LIMITS.padMax, 3);
    base.currency = currencyByCode(raw.currency) ? raw.currency : 'USD';
    var symbol = cleanText(raw.customSymbol || '', LIMITS.symbol).trim();
    base.customSymbol = symbol || '$';
    base.customDigits = clampInt(raw.customDigits, 0, 2, 2) === 0 ? 0 : 2;
    base.template = Object.prototype.hasOwnProperty.call(TEMPLATES, raw.template) ? raw.template : 'rule';
    base.paper = raw.paper === 'letter' ? 'letter' : 'a4';
    return base;
  }

  function cleanDecimalField(value) {
    if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u001F]/g, '').slice(0, LIMITS.decimal);
  }

  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : createId(),
      description: cleanText(raw.description, LIMITS.description),
      qty: cleanDecimalField(raw.qty),
      rate: cleanDecimalField(raw.rate)
    };
  }

  function blankItem() {
    return { id: createId(), description: '', qty: '', rate: '' };
  }

  function normalizeInvoice(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var currency = currencyByCode(raw.currency) ? raw.currency : 'USD';
    var template = Object.prototype.hasOwnProperty.call(TEMPLATES, raw.template) ? raw.template : 'rule';
    var incoming = Array.isArray(raw.items) ? raw.items : [];
    var truncated = incoming.length > LIMITS.items;
    var items = [];
    incoming.slice(0, LIMITS.items).forEach(function (item) {
      var next = normalizeItem(item);
      if (next) items.push(next);
    });
    if (!items.length) items = [blankItem()];
    var discount = raw.discount && typeof raw.discount === 'object' ? raw.discount : {};
    var discountType = discount.type === 'percent' || discount.type === 'amount' ? discount.type : 'none';
    var tax = raw.tax && typeof raw.tax === 'object' ? raw.tax : {};
    var from = raw.from && typeof raw.from === 'object' ? raw.from : {};
    var to = raw.to && typeof raw.to === 'object' ? raw.to : {};
    var label = cleanText(tax.label, LIMITS.taxLabel).trim();
    return {
      id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : createId(),
      template: template,
      paper: raw.paper === 'letter' ? 'letter' : 'a4',
      currency: currency,
      customSymbol: cleanText(raw.customSymbol || '', LIMITS.symbol).trim() || '$',
      customDigits: clampInt(raw.customDigits, 0, 2, 2) === 0 ? 0 : 2,
      number: cleanText(raw.number, LIMITS.number),
      provisionalNumber: cleanText(raw.provisionalNumber, LIMITS.number),
      numberConsumed: !!raw.numberConsumed,
      issued: parseISODate(raw.issued) ? raw.issued : '',
      due: parseISODate(raw.due) ? raw.due : '',
      po: cleanText(raw.po, LIMITS.po),
      from: {
        name: cleanText(from.name, LIMITS.name),
        address: cleanText(from.address, LIMITS.address),
        contact: cleanText(from.contact, LIMITS.contact),
        taxId: cleanText(from.taxId, LIMITS.taxId)
      },
      to: {
        name: cleanText(to.name, LIMITS.name),
        address: cleanText(to.address, LIMITS.address),
        contact: cleanText(to.contact, LIMITS.contact)
      },
      items: items,
      discount: { type: discountType, value: cleanDecimalField(discount.value) },
      tax: { label: label || 'Tax', rate: cleanDecimalField(tax.rate) },
      notes: cleanText(raw.notes, LIMITS.notes),
      payment: cleanText(raw.payment, LIMITS.payment),
      footer: cleanText(raw.footer, LIMITS.footer),
      logo: cleanLogo(raw.logo),
      savedAt: typeof raw.savedAt === 'string' ? raw.savedAt.slice(0, 40) : null,
      origin: raw.origin === 'sample' ? 'sample' : 'user',
      truncated: truncated
    };
  }

  function normalizeState(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1) return null;
    if (raw.drafts !== undefined && !Array.isArray(raw.drafts)) return null;
    var incoming = Array.isArray(raw.drafts) ? raw.drafts : [];
    var drafts = [];
    incoming.slice(0, LIMITS.drafts).forEach(function (item) {
      var invoice = normalizeInvoice(item);
      if (!invoice) return;
      invoice.origin = 'user';
      drafts.push(invoice);
    });
    var ephemeral = raw.ephemeral ? normalizeInvoice(raw.ephemeral) : null;
    return {
      version: 1,
      settings: normalizeSettings(raw.settings),
      drafts: drafts,
      activeId: typeof raw.activeId === 'string' ? raw.activeId.slice(0, 80) : '',
      ephemeral: ephemeral,
      droppedDrafts: Math.max(0, incoming.length - LIMITS.drafts)
    };
  }

  function isMeaningful(invoice) {
    if (!invoice) return false;
    var from = invoice.from || {};
    var to = invoice.to || {};
    var bits = [from.name, from.address, from.contact, from.taxId, to.name, to.address, to.contact, invoice.po, invoice.notes, invoice.payment, invoice.logo];
    for (var i = 0; i < bits.length; i += 1) {
      if (String(bits[i] || '').trim()) return true;
    }
    var footer = String(invoice.footer || '').trim();
    if (footer && footer !== DEFAULT_FOOTER) return true;
    if (invoice.discount && invoice.discount.type !== 'none' && String(invoice.discount.value || '').trim()) return true;
    if (invoice.tax && String(invoice.tax.rate || '').trim()) return true;
    var items = invoice.items || [];
    for (var j = 0; j < items.length; j += 1) {
      if (String(items[j].description || '').trim() || String(items[j].qty || '').trim() || String(items[j].rate || '').trim()) return true;
    }
    return false;
  }

  function consumeNumber(invoice, settings) {
    var next = normalizeSettings(settings);
    if (!invoice || invoice.numberConsumed) return next;
    var provisional = invoice.provisionalNumber || '';
    if (provisional && invoice.number === provisional) {
      next.next = Math.min(LIMITS.seqMax, next.next + 1);
    }
    invoice.numberConsumed = true;
    return next;
  }

  function createBlank(settings) {
    var safe = normalizeSettings(settings);
    var number = formatInvoiceNumber(safe.prefix, safe.next, safe.pad);
    var issued = todayISO();
    return normalizeInvoice({
      id: createId(),
      template: safe.template,
      paper: safe.paper,
      currency: safe.currency,
      customSymbol: safe.customSymbol,
      customDigits: safe.customDigits,
      number: number,
      provisionalNumber: number,
      numberConsumed: false,
      issued: issued,
      due: addDaysISO(issued, 14),
      footer: DEFAULT_FOOTER,
      items: [blankItem()],
      tax: { label: 'Tax', rate: '' },
      discount: { type: 'none', value: '' },
      origin: 'user'
    });
  }

  function createSample() {
    var issued = todayISO();
    return normalizeInvoice({
      id: createId(),
      template: 'rule',
      paper: 'a4',
      currency: 'USD',
      number: 'INV-1048',
      provisionalNumber: '',
      numberConsumed: true,
      issued: issued,
      due: addDaysISO(issued, 14),
      po: 'PO-4481',
      from: {
        name: 'Northwind Atelier',
        address: 'Lisa Cho\n14 Kiln Lane\nHudson, NY 12534',
        contact: 'lisa@northwind.example',
        taxId: '12-3456789'
      },
      to: {
        name: 'Harper & Field',
        address: 'Accounts payable\n200 Mercer Street, Suite 4\nNew York, NY 10012',
        contact: 'ap@harperfield.example'
      },
      items: [
        { id: createId(), description: 'Stoneware bowl set, 12 pieces, commissioned form', qty: '1', rate: '840' },
        { id: createId(), description: 'Glaze tests and firing', qty: '6', rate: '75' },
        { id: createId(), description: 'Crating and insured local delivery', qty: '1', rate: '60' }
      ],
      discount: { type: 'percent', value: '10' },
      tax: { label: 'Sales tax', rate: '8' },
      notes: 'Glazes are lead-free and food safe. The set is packed to order and insured through delivery.',
      payment: 'Transfer to Example Bank, account ending 4242.\nInclude the invoice number with your payment.',
      footer: 'Thank you. We look forward to seeing these in the shop.',
      origin: 'sample'
    });
  }

  function lineHasContent(item) {
    if (!item) return false;
    return !!(String(item.description || '').trim() || String(item.qty || '').trim() || String(item.rate || '').trim());
  }

  return {
    LIMITS: LIMITS,
    CURRENCIES: CURRENCIES,
    WARNING_TEXT: WARNING_TEXT,
    TEMPLATES: TEMPLATES,
    DEFAULT_FOOTER: DEFAULT_FOOTER,
    currencyByCode: currencyByCode,
    cleanLogo: cleanLogo,
    cleanText: cleanText,
    createId: createId,
    parseDecimal: parseDecimal,
    amountToMinor: amountToMinor,
    multiplyToMinor: multiplyToMinor,
    computeInvoice: computeInvoice,
    formatMoney: formatMoney,
    narrowSymbol: narrowSymbol,
    digitsFor: digitsFor,
    formatInvoiceNumber: formatInvoiceNumber,
    todayISO: todayISO,
    parseISODate: parseISODate,
    addDaysISO: addDaysISO,
    formatLongDate: formatLongDate,
    daysBetween: daysBetween,
    dueStatus: dueStatus,
    defaultSettings: defaultSettings,
    normalizeSettings: normalizeSettings,
    normalizeInvoice: normalizeInvoice,
    normalizeState: normalizeState,
    isMeaningful: isMeaningful,
    consumeNumber: consumeNumber,
    createBlank: createBlank,
    createSample: createSample,
    lineHasContent: lineHasContent,
    blankItem: blankItem
  };
});
