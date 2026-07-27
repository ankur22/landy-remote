#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(root, 'docs/config/index.html'), 'utf8');
var workflow = fs.readFileSync(path.join(root, '.github/workflows/pages.yml'), 'utf8');

function includes(value, message) {
  assert(html.indexOf(value) !== -1, message);
}

includes('pebblejs://close#', 'configuration must return through Pebble close URL');
includes('encodeURIComponent(JSON.stringify(payload))',
  'configuration payload must be encoded in the URL fragment');
includes('type="password"', 'password must use a masked input');
includes('id="store-pin"', 'PIN storage must have an explicit opt-in');
includes('Anyone who can unlock your phone can unlock your car.',
  'PIN risk warning must be shown verbatim');
includes('not affiliated with or endorsed by Jaguar Land Rover',
  'liability/affiliation disclaimer must be visible');
assert(
  /id="store-pin"[^>]*type="checkbox"(?![^>]*checked)/.test(html) ||
    /type="checkbox"[^>]*id="store-pin"(?![^>]*checked)/.test(html),
  'PIN storage must be off by default'
);
assert.strictEqual(/\blocalStorage\b/.test(html), false,
  'the hosted page must not retain secrets in browser storage');
assert.strictEqual(/\b(fetch|XMLHttpRequest)\s*\(/.test(html), false,
  'the hosted page must not send credentials over a network request');

assert(workflow.indexOf('actions/configure-pages@v5') !== -1,
  'Pages workflow must configure GitHub Pages');
assert(workflow.indexOf('actions/upload-pages-artifact@v4') !== -1,
  'Pages workflow must upload the static docs site');
assert(workflow.indexOf('actions/deploy-pages@v4') !== -1,
  'Pages workflow must deploy through the supported Pages action');
assert(/path:\s*docs/.test(workflow), 'Pages artifact must contain only docs/');

console.log('config page: 13 assertions passed');
