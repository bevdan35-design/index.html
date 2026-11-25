'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'assets/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/css/quire.css'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/static.yml'), 'utf8');

assert.equal(html.includes('<form id="editor"'), true);
assert.equal(html.includes('assets/css/quire.css'), true);
assert.equal(html.includes('assets/js/pure.js'), true);
assert.equal(html.includes('assets/js/app.js'), true);
assert.equal(html.includes("connect-src 'none'"), true);
assert.equal(/<script(?![^>]*\bsrc=)/.test(html), false);
assert.equal(/\son[a-z]+=/i.test(html), false);
assert.equal(html.includes('innerHTML'), false);
assert.equal(app.includes('innerHTML'), false);
assert.equal(app.includes('fetch('), false);
assert.equal(app.includes('XMLHttpRequest'), false);
assert.equal(app.includes('eval('), false);
assert.equal(css.includes('#0B0B0C'), true);
assert.equal(css.includes('#C9A45C'), true);
assert.equal(css.includes('#F3EFE6'), true);
assert.equal(css.includes('@media print'), true);
assert.equal(workflow.startsWith('# Simple workflow'), true);
assert.equal(fs.existsSync(path.join(root, 'assets/brand/mark.svg')), true);
assert.equal(fs.existsSync(path.join(root, 'assets/fonts/cormorant-garamond-400.woff2')), true);
assert.equal(fs.existsSync(path.join(root, 'assets/fonts/karla-400.woff2')), true);

console.log('page.test.js: all assertions passed');
