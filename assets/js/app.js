/* Quire in the browser.
   Reads and writes only this page and localStorage. Invoice strings are
   rendered with textContent. Logos must already be image data URLs. */
(function () {
  'use strict';

  var Q = window.Quire;
  var STORAGE_KEY = 'quire.v1';
  var BLOCKING = {
    'line-negative': true,
    'line-invalid': true,
    'discount-negative': true,
    'discount-invalid': true,
    'tax-negative': true,
    'tax-invalid': true,
    overflow: true
  };
  var BLURBS = {
    rule: 'Serif wordmark, a gold rule, and a double-rule total.',
    stamp: 'A light sheet, a display title, and a gold seal.',
    quiet: 'Wide spacing, sans type, and a single gold rule.'
  };
  var SETTING_IDS = { prefix: true, 'next-seq': true, pad: true };

  var state = {
    settings: Q.defaultSettings(),
    drafts: [],
    invoice: null,
    storageMode: 'ok',
    corruptRaw: '',
    noticeMode: null,
    lastWarnings: [],
    pendingImport: null,
    announcedTotal: ''
  };
  var saveTimer = 0;
  var announceTimer = 0;

  function el(id) {
    return document.getElementById(id);
  }

  function cloneInvoice(invoice) {
    return Q.normalizeInvoice(JSON.parse(JSON.stringify(invoice)));
  }

  function moneyOpts(invoice) {
    var digits = Q.digitsFor(invoice);
    if (invoice.currency === 'CUSTOM') {
      return { currency: 'CUSTOM', digits: digits, symbol: invoice.customSymbol.trim() || '\u00a4' };
    }
    return { currency: invoice.currency, digits: digits };
  }

  function format(minor, invoice) {
    try {
      return Q.formatMoney(minor, moneyOpts(invoice));
    } catch (err) {
      return String(minor);
    }
  }

  function symbolFor(invoice) {
    if (invoice.currency === 'CUSTOM') return invoice.customSymbol.trim() || '\u00a4';
    return Q.narrowSymbol(invoice.currency) || invoice.currency;
  }

  function totalsFor(invoice) {
    return Q.computeInvoice({
      digits: Q.digitsFor(invoice),
      items: invoice.items,
      discountType: invoice.discount.type,
      discountValue: invoice.discount.value,
      taxRate: invoice.tax.rate
    });
  }

  function setStatus(text, tone) {
    var node = el('save-status');
    node.textContent = text;
    node.classList.toggle('is-saved', tone === 'saved');
    node.classList.toggle('is-error', tone === 'error');
  }

  function toast(message) {
    var region = el('toasts');
    while (region.children.length >= 3) region.firstElementChild.remove();
    var item = document.createElement('div');
    item.className = 'toast';
    item.textContent = message;
    region.append(item);
    window.setTimeout(function () { item.remove(); }, 4200);
  }

  function showStorageProblem(message, withActions) {
    el('storage-banner-text').textContent = message;
    el('storage-banner').hidden = false;
    el('storage-actions').hidden = !withActions;
  }

  function hideAlert() {
    el('form-alert').hidden = true;
    el('form-alert').textContent = '';
  }

  function showAlert(message) {
    var node = el('form-alert');
    node.hidden = false;
    node.textContent = message;
  }

  function setView(view) {
    document.body.dataset.view = view === 'preview' ? 'preview' : 'edit';
    el('view-edit').setAttribute('aria-pressed', String(view !== 'preview'));
    el('view-preview').setAttribute('aria-pressed', String(view === 'preview'));
  }

  function buildCurrencyOptions() {
    var select = el('currency');
    var current = select.value || 'USD';
    select.replaceChildren();
    Q.CURRENCIES.forEach(function (currency) {
      var option = document.createElement('option');
      option.value = currency.code;
      option.textContent = currency.code === 'CUSTOM' ? 'Other symbol' : currency.code + ' \u2014 ' + currency.label;
      select.append(option);
    });
    select.value = Q.currencyByCode(current) ? current : 'USD';
  }

  function loadStore() {
    var raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      return { blocked: true };
    }
    if (!raw) return { empty: true };
    try {
      var parsed = JSON.parse(raw);
      var norm = Q.normalizeState(parsed);
      if (!norm) return { corrupt: true, raw: raw };
      norm.ok = true;
      return norm;
    } catch (err) {
      return { corrupt: true, raw: raw };
    }
  }

  function inDrafts(id) {
    return state.drafts.some(function (draft) { return draft.id === id; });
  }

  function upsert(invoice) {
    var copy = cloneInvoice(invoice);
    var index = -1;
    for (var i = 0; i < state.drafts.length; i += 1) {
      if (state.drafts[i].id === copy.id) index = i;
    }
    if (index === -1) state.drafts.unshift(copy);
    else state.drafts[index] = copy;
  }

  function payload() {
    var saved = inDrafts(state.invoice.id);
    return {
      version: 1,
      settings: Q.normalizeSettings(state.settings),
      drafts: state.drafts,
      activeId: saved ? state.invoice.id : '',
      ephemeral: saved ? null : cloneInvoice(state.invoice)
    };
  }

  function persist() {
    if (state.storageMode === 'blocked' || state.storageMode === 'corrupt') return false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload()));
      if (state.storageMode === 'quota') {
        state.storageMode = 'ok';
        el('storage-banner').hidden = true;
      }
      return true;
    } catch (err) {
      state.storageMode = 'quota';
      showStorageProblem('This browser ran out of room for drafts. Remove a logo or delete an old draft. The invoice on screen is unchanged, and nothing was uploaded.', false);
      return false;
    }
  }

  function readLines() {
    return Array.prototype.map.call(document.querySelectorAll('#line-items .line'), function (row) {
      return {
        id: row.dataset.id,
        description: row.querySelector('[data-field="description"]').value,
        qty: row.querySelector('[data-field="qty"]').value,
        rate: row.querySelector('[data-field="rate"]').value
      };
    });
  }

  function readSettings() {
    state.settings.prefix = el('prefix').value;
    var next = Number(el('next-seq').value);
    if (Number.isInteger(next) && next >= 1 && next <= Q.LIMITS.seqMax) state.settings.next = next;
    var pad = Number(el('pad').value);
    if (Number.isInteger(pad) && pad >= 1 && pad <= Q.LIMITS.padMax) state.settings.pad = pad;
  }

  function readForm() {
    var inv = state.invoice;
    var template = document.querySelector('input[name="template"]:checked');
    inv.template = template && Q.TEMPLATES[template.value] ? template.value : 'rule';
    inv.paper = el('paper').value === 'letter' ? 'letter' : 'a4';
    inv.currency = Q.currencyByCode(el('currency').value) ? el('currency').value : 'USD';
    inv.customSymbol = el('custom-symbol').value;
    inv.customDigits = el('custom-digits').value === '0' ? 0 : 2;
    inv.number = el('number').value;
    inv.issued = el('issued').value;
    inv.due = el('due').value;
    inv.po = el('po').value;
    inv.from.name = el('from-name').value;
    inv.from.address = el('from-address').value;
    inv.from.contact = el('from-contact').value;
    inv.from.taxId = el('from-tax').value;
    inv.to.name = el('to-name').value;
    inv.to.address = el('to-address').value;
    inv.to.contact = el('to-contact').value;
    inv.items = readLines();
    var discountType = el('discount-type').value;
    inv.discount.type = discountType === 'percent' || discountType === 'amount' ? discountType : 'none';
    inv.discount.value = el('discount-value').value;
    inv.tax.label = el('tax-label').value;
    inv.tax.rate = el('tax-rate').value;
    inv.notes = el('notes').value;
    inv.payment = el('payment').value;
    inv.footer = el('footer').value;
    state.settings.template = inv.template;
    state.settings.paper = inv.paper;
    state.settings.currency = inv.currency;
    state.settings.customDigits = inv.customDigits;
    if (inv.customSymbol.trim()) state.settings.customSymbol = inv.customSymbol.trim();
  }

  function lineField(label, name, value, kind, max, itemId) {
    var wrap = document.createElement('label');
    wrap.className = 'line-field line-field-' + name;
    var caption = document.createElement('span');
    caption.className = 'line-caption';
    caption.append(document.createTextNode(label));
    if (name === 'rate') {
      var symbol = document.createElement('span');
      symbol.className = 'affix';
      symbol.dataset.slot = 'symbol';
      caption.append(symbol);
    }
    var input = document.createElement('input');
    input.type = 'text';
    input.value = value || '';
    input.maxLength = max;
    input.dataset.field = name;
    input.id = 'line-' + itemId + '-' + name;
    input.setAttribute('aria-describedby', 'line-error-' + itemId);
    input.autocomplete = 'off';
    input.spellcheck = name === 'description';
    if (kind === 'decimal') input.inputMode = 'decimal';
    wrap.append(caption, input);
    return wrap;
  }

  function iconButton(action, label, disabled) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-button' + (action === 'trash' ? ' danger' : '');
    button.dataset.action = action;
    button.setAttribute('aria-label', label);
    button.disabled = disabled;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + action);
    svg.append(use);
    button.append(svg);
    return button;
  }

  function buildLine(item, index, total, fresh) {
    var row = document.createElement('div');
    row.className = 'line' + (fresh ? ' is-fresh' : '');
    row.dataset.id = item.id;
    row.append(
      lineField('Description', 'description', item.description, 'text', Q.LIMITS.description, item.id),
      lineField('Qty', 'qty', item.qty, 'decimal', Q.LIMITS.decimal, item.id),
      lineField('Rate', 'rate', item.rate, 'decimal', Q.LIMITS.decimal, item.id)
    );
    var amount = document.createElement('div');
    amount.className = 'line-amount';
    var caption = document.createElement('span');
    caption.className = 'line-caption';
    caption.textContent = 'Amount';
    var strong = document.createElement('strong');
    strong.dataset.slot = 'amount';
    strong.textContent = '\u2014';
    amount.append(caption, strong);
    var actions = document.createElement('div');
    actions.className = 'line-actions';
    actions.append(
      iconButton('up', 'Move line ' + (index + 1) + ' up', index === 0),
      iconButton('down', 'Move line ' + (index + 1) + ' down', index === total - 1),
      iconButton('trash', 'Remove line ' + (index + 1), false)
    );
    var err = document.createElement('p');
    err.className = 'field-error';
    err.dataset.slot = 'error';
    err.id = 'line-error-' + item.id;
    err.hidden = true;
    row.append(amount, actions, err);
    return row;
  }

  function writeLines(focus) {
    var host = el('line-items');
    var items = state.invoice.items;
    host.replaceChildren();
    items.forEach(function (item, index) {
      host.append(buildLine(item, index, items.length, !!(focus && focus.fresh && focus.id === item.id)));
    });
    el('lines-empty').hidden = items.length !== 0;
    el('add-line').disabled = items.length >= Q.LIMITS.items;
    if (!focus || !focus.id || typeof CSS === 'undefined' || !CSS.escape) return;
    var row = host.querySelector('[data-id="' + CSS.escape(focus.id) + '"]');
    if (!row) return;
    var target = row.querySelector(focus.selector || '[data-field="description"]');
    if (target && !target.disabled) target.focus();
    else {
      var fallback = row.querySelector('[data-field="description"]');
      if (fallback) fallback.focus();
    }
  }

  function writeForm() {
    var inv = state.invoice;
    document.querySelectorAll('input[name="template"]').forEach(function (input) {
      input.checked = input.value === inv.template;
    });
    el('paper').value = inv.paper === 'letter' ? 'letter' : 'a4';
    el('currency').value = Q.currencyByCode(inv.currency) ? inv.currency : 'USD';
    el('custom-symbol').value = inv.customSymbol || '';
    el('custom-digits').value = inv.customDigits === 0 ? '0' : '2';
    el('number').value = inv.number || '';
    el('issued').value = inv.issued || '';
    el('due').value = inv.due || '';
    el('po').value = inv.po || '';
    el('prefix').value = state.settings.prefix;
    el('next-seq').value = String(state.settings.next);
    el('pad').value = String(state.settings.pad);
    el('from-name').value = inv.from.name;
    el('from-address').value = inv.from.address;
    el('from-contact').value = inv.from.contact;
    el('from-tax').value = inv.from.taxId;
    el('to-name').value = inv.to.name;
    el('to-address').value = inv.to.address;
    el('to-contact').value = inv.to.contact;
    el('discount-type').value = inv.discount.type;
    el('discount-value').value = inv.discount.value;
    el('tax-label').value = inv.tax.label;
    el('tax-rate').value = inv.tax.rate;
    el('notes').value = inv.notes;
    el('payment').value = inv.payment;
    el('footer').value = inv.footer;
    writeLines(null);
    updateLogoUI();
    renderPreview();
  }

  function fill(id, value, placeholder) {
    var node = el(id);
    var text = String(value || '').trim();
    node.textContent = text || placeholder || '\u2014';
    node.classList.toggle('is-placeholder', !text);
  }

  function placeLogo(img, logo) {
    var clean = Q.cleanLogo(logo);
    if (!clean) {
      img.hidden = true;
      img.removeAttribute('src');
      return;
    }
    if (img.getAttribute('src') !== clean) img.setAttribute('src', clean);
    img.hidden = false;
  }

  function updateLogoUI() {
    var has = !!Q.cleanLogo(state.invoice.logo);
    placeLogo(el('logo-preview'), state.invoice.logo);
    el('logo-remove').hidden = !has;
    el('logo-label').textContent = has ? 'Replace logo' : 'Upload logo';
  }

  function setWarning(id, warning) {
    var node = el(id);
    if (!warning) {
      node.hidden = true;
      node.textContent = '';
      return;
    }
    node.hidden = false;
    node.textContent = Q.WARNING_TEXT[warning.code] || 'Check this value.';
  }

  function applyLineWarnings(warnings) {
    var rows = document.querySelectorAll('#line-items .line');
    Array.prototype.forEach.call(rows, function (row, index) {
      var mine = warnings.filter(function (warning) { return warning.index === index; });
      var qty = row.querySelector('[data-field="qty"]');
      var rate = row.querySelector('[data-field="rate"]');
      var err = row.querySelector('[data-slot="error"]');
      var qtyBad = mine.some(function (warning) {
        return warning.side === 'qty' || (!warning.side && warning.code === 'overflow');
      });
      var rateBad = mine.some(function (warning) {
        return warning.side === 'rate' || (!warning.side && warning.code === 'overflow');
      });
      qty.setAttribute('aria-invalid', qtyBad ? 'true' : 'false');
      rate.setAttribute('aria-invalid', rateBad ? 'true' : 'false');
      if (!mine.length) {
        err.hidden = true;
        err.textContent = '';
        return;
      }
      err.hidden = false;
      err.textContent = Q.WARNING_TEXT[mine[0].code] || 'Check this line.';
    });
  }

  function renderSheetLines(invoice, totals) {
    var body = el('sheet-lines');
    body.replaceChildren();
    var visible = [];
    invoice.items.forEach(function (item, index) {
      if (Q.lineHasContent(item)) visible.push({ item: item, line: totals.lines[index] || { minor: 0 } });
    });
    if (!visible.length) {
      var empty = document.createElement('tr');
      empty.className = 'sheet-empty';
      var cell = document.createElement('td');
      cell.colSpan = 4;
      cell.textContent = 'Line items will appear here.';
      empty.append(cell);
      body.append(empty);
      return;
    }
    visible.forEach(function (entry) {
      var row = document.createElement('tr');
      var desc = document.createElement('td');
      desc.className = 'pre';
      var description = entry.item.description.trim();
      desc.textContent = description || '\u2014';
      if (!description) desc.classList.add('is-placeholder');
      var qty = document.createElement('td');
      qty.className = 'num';
      qty.textContent = entry.item.qty.trim() || '\u2014';
      var rate = document.createElement('td');
      rate.className = 'num';
      var rateValue = entry.item.rate.trim();
      if (!rateValue) rate.textContent = '\u2014';
      else {
        var parsed = Q.amountToMinor(rateValue, Q.digitsFor(invoice));
        rate.textContent = parsed.ok && !parsed.blank ? format(parsed.minor, invoice) : rateValue;
      }
      var amount = document.createElement('td');
      amount.className = 'num';
      amount.textContent = format(entry.line.minor, invoice);
      row.append(desc, qty, rate, amount);
      body.append(row);
    });
  }

  function updateNotice() {
    var mode = state.invoice.origin === 'sample' ? 'sample' : Q.isMeaningful(state.invoice) ? 'hide' : 'empty';
    if (mode === state.noticeMode) return;
    state.noticeMode = mode;
    var host = el('notice');
    host.replaceChildren();
    if (mode === 'hide') {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    var copy = document.createElement('p');
    if (mode === 'sample') {
      copy.textContent = 'This is a sample for Northwind Atelier. It stays unsaved until you edit it.';
      var keep = document.createElement('button');
      keep.type = 'button';
      keep.className = 'button-primary';
      keep.textContent = 'Keep sample';
      keep.addEventListener('click', keepSample);
      var fresh = document.createElement('button');
      fresh.type = 'button';
      fresh.className = 'button-ghost';
      fresh.textContent = 'Start fresh';
      fresh.addEventListener('click', newInvoice);
      host.append(copy, keep, fresh);
      return;
    }
    copy.textContent = 'A fresh invoice. Add who it is from, who it is for, and at least one line.';
    host.append(copy);
  }

  function updateDueBadge(invoice) {
    var badge = el('due-badge');
    badge.className = 'badge screen-only';
    var status = Q.isMeaningful(invoice) ? Q.dueStatus(invoice.due, Q.todayISO()) : null;
    if (!status || status.code === 'upcoming' && status.days > 14) {
      badge.hidden = true;
      return;
    }
    badge.hidden = false;
    if (status.code === 'overdue') {
      badge.classList.add('badge-fault');
      badge.textContent = status.days === 1 ? 'Overdue by 1 day' : 'Overdue by ' + status.days + ' days';
    } else if (status.code === 'today') {
      badge.classList.add('badge-warn');
      badge.textContent = 'Due today';
    } else if (status.days === 1) {
      badge.classList.add('badge-quiet');
      badge.textContent = 'Due tomorrow';
    } else {
      badge.classList.add('badge-quiet');
      badge.textContent = 'Due in ' + status.days + ' days';
    }
  }

  function announceTotal(text) {
    window.clearTimeout(announceTimer);
    announceTimer = window.setTimeout(function () {
      if (text === state.announcedTotal) return;
      state.announcedTotal = text;
      el('sr-total').textContent = 'Invoice total ' + text;
    }, 900);
  }

  function renderPreview() {
    var invoice = state.invoice;
    var totals = totalsFor(invoice);
    state.lastWarnings = totals.warnings;
    document.body.dataset.paper = invoice.paper;
    el('sheet').dataset.template = invoice.template;
    el('template-blurb').textContent = BLURBS[invoice.template] || BLURBS.rule;
    el('print-hint').hidden = invoice.template !== 'stamp';
    el('custom-currency').hidden = invoice.currency !== 'CUSTOM';
    var discountType = invoice.discount.type;
    el('discount-value').disabled = discountType === 'none';
    el('discount-value-label').textContent = discountType === 'percent' ? 'Percent' : discountType === 'amount' ? 'Amount' : 'Value';

    placeLogo(el('sheet-logo'), invoice.logo);
    fill('sheet-from-name', invoice.from.name);
    fill('sheet-number', invoice.number);
    var seal = invoice.number.trim();
    el('sheet-seal').textContent = !seal ? '\u2014' : seal.length <= 8 ? seal : seal.slice(-6);

    var fromBits = [invoice.from.address, invoice.from.contact, invoice.from.taxId].some(function (value) { return String(value || '').trim(); });
    if (!fromBits) {
      fill('sheet-from-address', '');
      el('sheet-from-contact').hidden = true;
      el('sheet-from-tax').hidden = true;
    } else {
      var address = invoice.from.address.trim();
      el('sheet-from-address').hidden = !address;
      el('sheet-from-address').textContent = address;
      el('sheet-from-address').classList.remove('is-placeholder');
      var contact = invoice.from.contact.trim();
      el('sheet-from-contact').hidden = !contact;
      el('sheet-from-contact').textContent = contact;
      var taxId = invoice.from.taxId.trim();
      el('sheet-from-tax').hidden = !taxId;
      el('sheet-from-tax').textContent = taxId ? 'Tax ID ' + taxId : '';
    }

    fill('sheet-to-name', invoice.to.name);
    var toAddress = invoice.to.address.trim();
    el('sheet-to-address').hidden = !toAddress;
    el('sheet-to-address').textContent = toAddress;
    var toContact = invoice.to.contact.trim();
    el('sheet-to-contact').hidden = !toContact;
    el('sheet-to-contact').textContent = toContact;

    fill('sheet-issued', invoice.issued ? Q.formatLongDate(invoice.issued) : '');
    fill('sheet-due', invoice.due ? Q.formatLongDate(invoice.due) : '');
    var po = invoice.po.trim();
    el('sheet-po-row').hidden = !po;
    el('sheet-po').textContent = po;
    el('sheet-currency').textContent = invoice.currency === 'CUSTOM' ? (invoice.customSymbol.trim() || 'Other') : invoice.currency;

    var dueBad = invoice.issued && invoice.due && invoice.due < invoice.issued;
    el('due-warning').hidden = !dueBad;
    el('due-warning').textContent = dueBad ? 'The due date is before the issue date.' : '';

    renderSheetLines(invoice, totals);
    el('subtotal-amount').textContent = format(totals.subtotalMinor, invoice);
    var showDiscount = discountType !== 'none' && invoice.discount.value.trim() !== '';
    el('row-discount').hidden = !showDiscount;
    if (showDiscount) {
      var discountName = discountType === 'percent' ? 'Discount (' + invoice.discount.value.trim() + '%)' : 'Discount';
      el('discount-label').textContent = discountName;
      el('discount-amount').textContent = '\u2212' + format(totals.discountMinor, invoice);
    }
    var showTax = invoice.tax.rate.trim() !== '';
    el('row-tax').hidden = !showTax;
    if (showTax) {
      var taxName = (invoice.tax.label.trim() || 'Tax') + ' (' + invoice.tax.rate.trim() + '%)';
      el('tax-row-label').textContent = taxName;
      el('tax-amount').textContent = format(totals.taxMinor, invoice);
    }
    var totalText = format(totals.totalMinor, invoice);
    el('total-amount').textContent = totalText;
    el('action-total').textContent = totalText;

    var notes = invoice.notes.trim();
    el('sheet-notes-block').hidden = !notes;
    el('sheet-notes').textContent = notes;
    var payment = invoice.payment.trim();
    el('sheet-payment-block').hidden = !payment;
    el('sheet-payment').textContent = payment;
    var footer = invoice.footer.trim();
    el('sheet-foot').hidden = !footer;
    el('sheet-footer').textContent = footer;

    var rows = document.querySelectorAll('#line-items .line');
    Array.prototype.forEach.call(rows, function (row, index) {
      var slot = row.querySelector('[data-slot="amount"]');
      var item = invoice.items[index];
      var line = totals.lines[index];
      if (!slot || !item || !line) return;
      slot.textContent = Q.lineHasContent(item) ? format(line.minor, invoice) : '\u2014';
    });
    document.querySelectorAll('[data-slot="symbol"]').forEach(function (node) {
      node.textContent = symbolFor(invoice);
    });
    applyLineWarnings(totals.warnings);
    setWarning('adjust-warning', totals.warnings.find(function (warning) { return warning.code.indexOf('discount') === 0; }) || null);
    setWarning('tax-warning', totals.warnings.find(function (warning) { return warning.code.indexOf('tax') === 0; }) || null);
    var looseOverflow = totals.warnings.find(function (warning) {
      return warning.code === 'overflow' && warning.index === undefined;
    });
    if (looseOverflow && el('adjust-warning').hidden && el('tax-warning').hidden) setWarning('adjust-warning', looseOverflow);

    updateDueBadge(invoice);
    updateNotice();
    var status = invoice.origin === 'sample' ? 'Sample invoice' : Q.isMeaningful(invoice) ? 'Updates as you type' : 'Empty invoice';
    el('preview-status').textContent = status;
    var who = invoice.to.name.trim() || 'Untitled';
    var number = invoice.number.trim() || 'Draft';
    document.title = number + ' \u00b7 ' + who + ' \u2014 Quire';
    announceTotal(totalText);
  }

  function saveNow() {
    readForm();
    if (state.invoice.origin === 'sample') return false;
    var exists = inDrafts(state.invoice.id);
    if (!exists && !Q.isMeaningful(state.invoice)) {
      setStatus('Not saved yet');
      persist();
      return false;
    }
    if (!exists && state.drafts.length >= Q.LIMITS.drafts) {
      setStatus('Not saved. Draft limit reached.', 'error');
      toast('Delete a saved draft before this one can be kept. The limit is 30.');
      return false;
    }
    var before = state.settings.next;
    state.settings = Q.consumeNumber(state.invoice, state.settings);
    if (state.settings.next !== before && document.activeElement !== el('next-seq')) {
      el('next-seq').value = String(state.settings.next);
    }
    state.invoice.savedAt = new Date().toISOString();
    state.invoice.origin = 'user';
    upsert(state.invoice);
    var ok = persist();
    setStatus(ok ? 'Saved on this device' : 'Could not save in this browser', ok ? 'saved' : 'error');
    return ok;
  }

  function scheduleSave() {
    setStatus('Saving...');
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(function () {
      saveTimer = 0;
      saveNow();
    }, 450);
  }

  function onInvoiceInput() {
    var wasSample = state.invoice.origin === 'sample';
    hideAlert();
    readForm();
    if (wasSample) state.invoice.origin = 'user';
    renderPreview();
    scheduleSave();
  }

  function keepSample() {
    state.invoice.origin = 'user';
    state.noticeMode = null;
    var ok = saveNow();
    renderPreview();
    if (ok) toast('Sample kept in Drafts on this device.');
  }

  function newInvoice() {
    var exists = state.invoice && inDrafts(state.invoice.id);
    var meaningful = state.invoice && state.invoice.origin !== 'sample' && Q.isMeaningful(state.invoice);
    if (meaningful || exists) {
      var saved = saveNow();
      if (!saved && !exists) {
        toast('This invoice could not be saved. Free a draft slot, then try New again.');
        return;
      }
    }
    if (state.drafts.length >= Q.LIMITS.drafts) {
      toast('Delete a saved draft before starting another. This browser keeps 30.');
      openDrafts();
      return;
    }
    state.invoice = Q.createBlank(state.settings);
    state.noticeMode = null;
    writeForm();
    persist();
    setStatus('Not saved yet');
    toast('New invoice ' + state.invoice.number + '. It is kept once you add details.');
    setView('edit');
    el('from-name').focus();
  }

  function assignNumber() {
    readSettings();
    readForm();
    if (state.invoice.origin === 'sample') state.invoice.origin = 'user';
    var safe = Q.normalizeSettings(state.settings);
    var number = Q.formatInvoiceNumber(safe.prefix, safe.next, safe.pad);
    state.invoice.number = number;
    state.invoice.provisionalNumber = number;
    state.invoice.numberConsumed = false;
    state.settings = Q.consumeNumber(state.invoice, safe);
    el('number').value = state.invoice.number;
    el('prefix').value = state.settings.prefix;
    el('next-seq').value = String(state.settings.next);
    el('pad').value = String(state.settings.pad);
    renderPreview();
    saveNow();
    toast('This invoice is now ' + number + '.');
  }

  function addLine() {
    readForm();
    if (state.invoice.origin === 'sample') state.invoice.origin = 'user';
    if (state.invoice.items.length >= Q.LIMITS.items) {
      toast('This invoice holds up to 40 lines.');
      return;
    }
    var item = Q.blankItem();
    state.invoice.items.push(item);
    state.noticeMode = null;
    writeLines({ id: item.id, selector: '[data-field="description"]', fresh: true });
    renderPreview();
    scheduleSave();
  }

  function onLineClick(event) {
    var button = event.target.closest('button');
    if (!button || !button.dataset.action) return;
    var row = button.closest('.line');
    if (!row) return;
    readForm();
    if (state.invoice.origin === 'sample') state.invoice.origin = 'user';
    var index = -1;
    for (var i = 0; i < state.invoice.items.length; i += 1) {
      if (state.invoice.items[i].id === row.dataset.id) index = i;
    }
    if (index < 0) return;
    var action = button.dataset.action;
    var focus = null;
    if (action === 'trash') {
      state.invoice.items.splice(index, 1);
      var neighbor = state.invoice.items[index] || state.invoice.items[index - 1];
      focus = neighbor ? { id: neighbor.id, selector: '[data-field="description"]' } : null;
      writeLines(focus);
      if (!neighbor) el('add-line').focus();
    } else if (action === 'up' && index > 0) {
      var up = state.invoice.items[index - 1];
      state.invoice.items[index - 1] = state.invoice.items[index];
      state.invoice.items[index] = up;
      writeLines({ id: row.dataset.id, selector: '[data-action="up"]' });
    } else if (action === 'down' && index < state.invoice.items.length - 1) {
      var down = state.invoice.items[index + 1];
      state.invoice.items[index + 1] = state.invoice.items[index];
      state.invoice.items[index] = down;
      writeLines({ id: row.dataset.id, selector: '[data-action="down"]' });
    } else return;
    state.noticeMode = null;
    renderPreview();
    scheduleSave();
  }

  function focusWarning(warning) {
    if (typeof warning.index === 'number') {
      var rows = document.querySelectorAll('#line-items .line');
      var row = rows[warning.index];
      if (!row) return;
      var field = row.querySelector('[data-field="' + (warning.side === 'rate' ? 'rate' : 'qty') + '"]');
      if (field) field.focus();
      return;
    }
    if (warning.code.indexOf('discount') === 0) el('discount-value').focus();
    else if (warning.code.indexOf('tax') === 0) el('tax-rate').focus();
    else el('form-alert').focus();
  }

  function onPrint() {
    readForm();
    renderPreview();
    var blocking = state.lastWarnings.filter(function (warning) { return BLOCKING[warning.code]; });
    if (blocking.length) {
      showAlert(Q.WARNING_TEXT[blocking[0].code] || 'Fix the highlighted value before printing.');
      setView('edit');
      focusWarning(blocking[0]);
      return;
    }
    hideAlert();
    var dialog = el('drafts-dialog');
    if (dialog.open) dialog.close();
    var hasLines = state.invoice.items.some(Q.lineHasContent);
    setStatus(hasLines ? 'Print dialog open. Choose Save as PDF.' : 'Printing an invoice with no line items.');
    window.print();
  }

  function savedLabel(iso) {
    var date = new Date(iso || '');
    if (Number.isNaN(date.getTime())) return 'Saved on this device';
    return 'Saved ' + date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function renderDrafts() {
    var list = el('drafts-list');
    list.replaceChildren();
    var drafts = state.drafts.slice().sort(function (a, b) {
      return String(b.savedAt || '').localeCompare(String(a.savedAt || ''));
    });
    el('drafts-empty').hidden = drafts.length !== 0;
    drafts.forEach(function (draft) {
      var card = document.createElement('article');
      card.className = 'draft';
      var title = document.createElement('h3');
      title.textContent = draft.to.name.trim() || draft.from.name.trim() || 'Untitled draft';
      var meta = document.createElement('p');
      var totals = totalsFor(draft);
      meta.textContent = [
        draft.number.trim() || 'No number',
        format(totals.totalMinor, draft),
        Q.TEMPLATES[draft.template] || 'Ledger',
        savedLabel(draft.savedAt)
      ].join(' · ');
      var actions = document.createElement('div');
      actions.className = 'draft-actions';
      if (draft.id === state.invoice.id) {
        var current = document.createElement('span');
        current.className = 'hint';
        current.textContent = 'On screen';
        actions.append(current);
      } else {
        var open = document.createElement('button');
        open.type = 'button';
        open.className = 'button-ghost';
        open.textContent = 'Open';
        open.addEventListener('click', function () { openDraft(draft.id); });
        actions.append(open);
      }
      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'button-ghost';
      copy.textContent = 'Duplicate';
      copy.addEventListener('click', function () { duplicateDraft(draft.id); });
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button-ghost';
      remove.textContent = 'Delete';
      remove.addEventListener('click', function () { askDelete(card, draft.id); });
      actions.append(copy, remove);
      card.append(title, meta, actions);
      list.append(card);
    });
  }

  function askDelete(card, id) {
    if (card.querySelector('.confirm-inline')) return;
    var ask = document.createElement('div');
    ask.className = 'confirm-inline draft-actions';
    var text = document.createElement('p');
    text.textContent = 'Delete this draft from this browser?';
    var yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'button-danger';
    yes.textContent = 'Delete';
    yes.addEventListener('click', function () { deleteDraft(id); });
    var no = document.createElement('button');
    no.type = 'button';
    no.className = 'button-ghost';
    no.textContent = 'Cancel';
    no.addEventListener('click', function () { ask.remove(); });
    ask.append(text, yes, no);
    card.append(ask);
    yes.focus();
  }

  function openDrafts() {
    if (state.invoice && state.invoice.origin !== 'sample') saveNow();
    el('drafts-error').hidden = true;
    renderDrafts();
    var dialog = el('drafts-dialog');
    if (!dialog.open) dialog.showModal();
  }

  function openDraft(id) {
    var exists = inDrafts(state.invoice.id);
    var meaningful = state.invoice.origin !== 'sample' && Q.isMeaningful(state.invoice);
    if (exists || meaningful) {
      var saved = saveNow();
      if (!saved && !exists && Q.isMeaningful(state.invoice)) return;
    }
    var source = null;
    for (var i = 0; i < state.drafts.length; i += 1) {
      if (state.drafts[i].id === id) source = state.drafts[i];
    }
    if (!source) return;
    state.invoice = cloneInvoice(source);
    state.noticeMode = null;
    writeForm();
    persist();
    el('drafts-dialog').close();
    setView('edit');
    setStatus('Saved on this device', 'saved');
    toast('Opened ' + (state.invoice.number.trim() || 'draft') + '.');
  }

  function duplicateDraft(id) {
    if (state.drafts.length >= Q.LIMITS.drafts) {
      toast('Delete a draft before duplicating. The limit is 30.');
      return;
    }
    var source = null;
    for (var i = 0; i < state.drafts.length; i += 1) {
      if (state.drafts[i].id === id) source = state.drafts[i];
    }
    if (!source) return;
    var copy = cloneInvoice(source);
    copy.id = Q.createId();
    copy.origin = 'user';
    copy.items = copy.items.map(function (item) {
      return { id: Q.createId(), description: item.description, qty: item.qty, rate: item.rate };
    });
    copy.number = Q.formatInvoiceNumber(state.settings.prefix, state.settings.next, state.settings.pad);
    copy.provisionalNumber = copy.number;
    copy.numberConsumed = false;
    state.settings = Q.consumeNumber(copy, state.settings);
    copy.savedAt = new Date().toISOString();
    if (document.activeElement !== el('next-seq')) el('next-seq').value = String(state.settings.next);
    state.drafts.unshift(copy);
    state.invoice = cloneInvoice(copy);
    state.noticeMode = null;
    writeForm();
    var ok = persist();
    renderDrafts();
    setStatus(ok ? 'Saved on this device' : 'Could not save in this browser', ok ? 'saved' : 'error');
    toast('Duplicate saved as ' + copy.number + '.');
  }

  function deleteDraft(id) {
    var doomed = null;
    state.drafts = state.drafts.filter(function (draft) {
      if (draft.id === id) doomed = draft;
      return draft.id !== id;
    });
    if (state.invoice.id === id) {
      state.invoice = state.drafts.length ? cloneInvoice(state.drafts[0]) : Q.createBlank(state.settings);
      state.noticeMode = null;
      writeForm();
    }
    persist();
    renderDrafts();
    var name = doomed ? (doomed.to.name.trim() || doomed.number.trim() || 'Draft') : 'Draft';
    toast('Deleted ' + name + ' from this browser.');
  }

  function downloadBlob(filename, text, type) {
    var blob = new Blob([text], { type: type || 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function downloadBackup() {
    if (state.invoice.origin !== 'sample') saveNow();
    var data = payload();
    data.exportedAt = new Date().toISOString();
    downloadBlob('quire-drafts.json', JSON.stringify(data, null, 2), 'application/json');
    toast('Backup downloaded. It contains invoice details, so keep the file private.');
  }

  function onBackupFile(file) {
    el('drafts-error').hidden = true;
    if (!file) return;
    if (file.size > 8000000) {
      el('drafts-error').hidden = false;
      el('drafts-error').textContent = 'That backup is over 8 MB. Quire did not read it.';
      return;
    }
    var reader = new FileReader();
    reader.onerror = function () {
      el('drafts-error').hidden = false;
      el('drafts-error').textContent = 'Could not read that file.';
    };
    reader.onload = function () {
      try {
        var parsed = JSON.parse(String(reader.result));
        if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.drafts)) throw new Error('shape');
        var norm = Q.normalizeState({ version: 1, settings: parsed.settings, drafts: parsed.drafts });
        if (!norm || !norm.drafts.length) throw new Error('empty');
        state.pendingImport = norm;
        var summary = 'This backup has ' + norm.drafts.length + (norm.drafts.length === 1 ? ' invoice' : ' invoices') + '. Replace the drafts on this device?';
        if (norm.droppedDrafts) summary += ' Only the first 30 were kept.';
        el('import-summary').textContent = summary;
        el('import-confirm').hidden = false;
      } catch (err) {
        state.pendingImport = null;
        el('import-confirm').hidden = true;
        el('drafts-error').hidden = false;
        el('drafts-error').textContent = 'That file is not a Quire backup.';
      }
    };
    reader.readAsText(file);
  }

  function applyImport() {
    if (!state.pendingImport) return;
    state.settings = state.pendingImport.settings;
    state.drafts = state.pendingImport.drafts;
    state.invoice = cloneInvoice(state.drafts[0]);
    state.noticeMode = null;
    state.pendingImport = null;
    el('import-confirm').hidden = true;
    writeForm();
    var ok = persist();
    renderDrafts();
    setStatus(ok ? 'Saved on this device' : 'Could not save in this browser', ok ? 'saved' : 'error');
    toast(ok ? 'Backup restored on this device.' : 'Backup loaded, but this browser could not store it.');
  }

  function setLogoMessage(message) {
    var node = el('logo-error');
    node.hidden = !message;
    node.textContent = message || '';
  }

  function finishLogoRead(label) {
    el('logo-label').textContent = label;
  }

  function onLogoFile(file) {
    setLogoMessage('');
    if (!file) return;
    if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
      setLogoMessage('SVG logos are not accepted. Use a PNG, JPEG, WebP, or GIF.');
      return;
    }
    var allowed = /^image\/(png|jpeg|webp|gif)$/.test(file.type) || (file.type === '' && /\.(png|jpe?g|webp|gif)$/i.test(file.name));
    if (!allowed) {
      setLogoMessage('Use a PNG, JPEG, WebP, or GIF.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setLogoMessage('That file is over 8 MB. Choose a smaller image.');
      return;
    }
    var invoiceId = state.invoice.id;
    el('logo-label').textContent = 'Reading logo...';
    var reader = new FileReader();
    reader.onerror = function () {
      setLogoMessage('Could not read that image.');
      finishLogoRead('Upload logo');
    };
    reader.onload = function () {
      var image = new Image();
      image.onload = function () {
        if (state.invoice.id !== invoiceId) {
          finishLogoRead('Upload logo');
          return;
        }
        var edge = Math.max(image.width, image.height);
        if (!edge) {
          setLogoMessage('Could not read that image.');
          finishLogoRead('Upload logo');
          return;
        }
        var scale = Math.min(1, 480 / edge);
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        var context = canvas.getContext('2d');
        if (!context) {
          setLogoMessage('Could not read that image.');
          finishLogoRead('Upload logo');
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        var mime = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
        var store = function (finalBlob) {
          if (state.invoice.id !== invoiceId) return;
          if (!finalBlob) {
            setLogoMessage('Could not read that image.');
            finishLogoRead('Upload logo');
            return;
          }
          if (finalBlob.size > 350 * 1024) {
            setLogoMessage('That logo is still too large after resizing. Try a simpler image.');
            finishLogoRead(state.invoice.logo ? 'Replace logo' : 'Upload logo');
            return;
          }
          var stored = new FileReader();
          stored.onerror = function () {
            setLogoMessage('Could not store that image.');
            finishLogoRead('Upload logo');
          };
          stored.onload = function () {
            if (state.invoice.id !== invoiceId) return;
            var logo = Q.cleanLogo(String(stored.result));
            if (!logo) {
              setLogoMessage('Could not store that image.');
              finishLogoRead('Upload logo');
              return;
            }
            readForm();
            state.invoice.logo = logo;
            if (state.invoice.origin === 'sample') state.invoice.origin = 'user';
            updateLogoUI();
            renderPreview();
            scheduleSave();
            toast('Logo added. It stays on this device.');
          };
          stored.readAsDataURL(finalBlob);
        };
        canvas.toBlob(function (blob) {
          if (blob && blob.size > 350 * 1024 && mime !== 'image/jpeg') {
            canvas.toBlob(store, 'image/jpeg', 0.86);
            return;
          }
          store(blob);
        }, mime, 0.86);
      };
      image.onerror = function () {
        setLogoMessage('Could not read that image.');
        finishLogoRead('Upload logo');
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  }

  function removeLogo() {
    readForm();
    state.invoice.logo = null;
    if (state.invoice.origin === 'sample') state.invoice.origin = 'user';
    setLogoMessage('');
    updateLogoUI();
    renderPreview();
    scheduleSave();
  }

  function requestSample() {
    if (state.invoice.origin === 'sample') return;
    if (Q.isMeaningful(state.invoice) || inDrafts(state.invoice.id)) {
      el('sample-confirm').hidden = false;
      el('sample-confirm-yes').focus();
      return;
    }
    applySample();
  }

  function applySample() {
    if (state.invoice.origin !== 'sample' && (Q.isMeaningful(state.invoice) || inDrafts(state.invoice.id))) saveNow();
    state.invoice = Q.createSample();
    state.noticeMode = null;
    el('sample-confirm').hidden = true;
    writeForm();
    persist();
    setStatus('Sample, not saved yet');
    toast('Sample loaded. It is not kept until you edit it or choose Keep sample.');
  }

  function downloadCorrupt() {
    if (!state.corruptRaw) return;
    downloadBlob('quire-unreadable.json', state.corruptRaw, 'application/json');
  }

  function discardCorrupt() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* already unreadable */ }
    state.storageMode = 'ok';
    state.corruptRaw = '';
    el('storage-banner').hidden = true;
    persist();
    toast('The unreadable save was discarded from this browser.');
  }

  function onFormEvent(event) {
    if (SETTING_IDS[event.target.id]) {
      readSettings();
      persist();
      return;
    }
    onInvoiceInput();
  }

  function bind() {
    var form = el('editor');
    form.addEventListener('submit', function (event) { event.preventDefault(); });
    form.addEventListener('input', onFormEvent);
    form.addEventListener('change', function (event) {
      if (event.target.tagName === 'SELECT') onFormEvent(event);
    });
    document.querySelector('.segment').addEventListener('change', function (event) {
      if (event.target.name !== 'template') return;
      readForm();
      state.invoice.template = event.target.value;
      state.settings.template = event.target.value;
      renderPreview();
      if (inDrafts(state.invoice.id) && state.invoice.origin !== 'sample') saveNow();
      else persist();
    });
    el('paper').addEventListener('change', function () {
      readForm();
      renderPreview();
      if (inDrafts(state.invoice.id) && state.invoice.origin !== 'sample') saveNow();
      else persist();
    });
    el('prefix').addEventListener('blur', function () {
      if (!el('prefix').value.trim()) {
        el('prefix').value = 'INV-';
        state.settings.prefix = 'INV-';
        persist();
      }
    });
    el('add-line').addEventListener('click', addLine);
    el('line-items').addEventListener('click', onLineClick);
    el('assign-number').addEventListener('click', assignNumber);
    el('new-invoice').addEventListener('click', newInvoice);
    el('print').addEventListener('click', onPrint);
    el('action-print').addEventListener('click', onPrint);
    el('open-drafts').addEventListener('click', openDrafts);
    el('drafts-close').addEventListener('click', function () { el('drafts-dialog').close(); });
    el('drafts-dialog').addEventListener('click', function (event) {
      if (event.target === el('drafts-dialog')) el('drafts-dialog').close();
    });
    el('view-edit').addEventListener('click', function () { setView('edit'); });
    el('view-preview').addEventListener('click', function () { setView('preview'); });
    el('load-sample').addEventListener('click', requestSample);
    el('sample-confirm-yes').addEventListener('click', applySample);
    el('sample-confirm-no').addEventListener('click', function () { el('sample-confirm').hidden = true; });
    el('backup-download').addEventListener('click', downloadBackup);
    el('backup-file').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      event.target.value = '';
      onBackupFile(file);
    });
    el('import-yes').addEventListener('click', applyImport);
    el('import-no').addEventListener('click', function () {
      state.pendingImport = null;
      el('import-confirm').hidden = true;
    });
    el('logo-file').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      event.target.value = '';
      onLogoFile(file);
    });
    el('logo-remove').addEventListener('click', removeLogo);
    el('sheet-logo').addEventListener('error', function () { el('sheet-logo').hidden = true; });
    el('logo-preview').addEventListener('error', function () { el('logo-preview').hidden = true; });
    el('download-corrupt').addEventListener('click', downloadCorrupt);
    el('discard-corrupt').addEventListener('click', discardCorrupt);
    window.addEventListener('beforeprint', function () {
      readForm();
      renderPreview();
    });
    window.addEventListener('beforeunload', function () {
      if (!saveTimer) return;
      window.clearTimeout(saveTimer);
      saveTimer = 0;
      saveNow();
    });
  }

  function boot() {
    buildCurrencyOptions();
    var stored = loadStore();
    if (stored.blocked) {
      state.storageMode = 'blocked';
      state.invoice = Q.createSample();
      showStorageProblem('This browser is not storing data, so drafts disappear when you close the page. You can still print. Nothing is uploaded.', false);
    } else if (stored.corrupt) {
      state.storageMode = 'corrupt';
      state.corruptRaw = stored.raw || '';
      state.invoice = Q.createSample();
      showStorageProblem('A saved file in this browser could not be read. It was left untouched. You can download it or discard it. Nothing was uploaded.', true);
    } else if (stored.empty) {
      state.invoice = Q.createSample();
    } else {
      state.settings = stored.settings;
      state.drafts = stored.drafts;
      if (stored.ephemeral) state.invoice = stored.ephemeral;
      else if (stored.activeId) {
        for (var i = 0; i < state.drafts.length; i += 1) {
          if (state.drafts[i].id === stored.activeId) state.invoice = cloneInvoice(state.drafts[i]);
        }
      }
      if (!state.invoice && state.drafts.length) state.invoice = cloneInvoice(state.drafts[0]);
      if (!state.invoice) state.invoice = Q.createSample();
    }
    var skeleton = el('skeleton');
    if (skeleton) skeleton.remove();
    el('sheet-content').hidden = false;
    el('sheet').setAttribute('aria-busy', 'false');
    writeForm();
    if (state.invoice.origin === 'sample') setStatus('Sample, not saved yet');
    else if (inDrafts(state.invoice.id)) setStatus('Saved on this device', 'saved');
    else setStatus('Not saved yet');
  }

  bind();
  boot();
})();
