#!/usr/bin/env node
/*
 * สร้าง FORM_HEADERS ใน Code.gs จาก forms-spec.js (ใช้ตรรกะเดียวกับหน้าเว็บ)
 *   node scripts/sync-headers.js          เขียนทับบล็อก FORM_HEADERS ใน Code.gs
 *   node scripts/sync-headers.js --check  ตรวจอย่างเดียว (exit 1 ถ้าไม่ตรง)
 * รันทุกครั้งที่แก้ forms-spec.js แล้ว clasp push
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function expectedHeaders() {
  const html = read('index.html');
  const core = /<script id="survey-core">([\s\S]*?)<\/script>/.exec(html);
  if (!core) throw new Error('survey-core script not found in index.html');
  const ctx = vm.createContext({});
  vm.runInContext(read('forms-spec.js'), ctx);
  vm.runInContext(core[1], ctx);
  return JSON.parse(vm.runInContext('JSON.stringify(Object.fromEntries(FORMS.map(function (f) { return [f.key, columnNames(f)]; })))', ctx));
}

const START = /\/\* <<< FORM_HEADERS:[^\n]*\*\/\n/;
const END = /\/\* <<< END FORM_HEADERS >>> \*\//;

function render(headers) {
  const body = Object.keys(headers).map((k) =>
    '  ' + k + ': [\n' + headers[k].map((h) => '    ' + JSON.stringify(h) + ',').join('\n') + '\n  ],').join('\n');
  return 'var FORM_HEADERS = {\n' + body + '\n};\n';
}

function sync(check) {
  const code = read('Code.gs');
  const s = START.exec(code);
  const e = END.exec(code);
  if (!s || !e || e.index < s.index) throw new Error('FORM_HEADERS markers not found in Code.gs');
  const from = s.index + s[0].length;
  const next = code.slice(0, from) + render(expectedHeaders()) + code.slice(e.index);
  if (check) return next === code;
  fs.writeFileSync(path.join(ROOT, 'Code.gs'), next);
  return true;
}

module.exports = { expectedHeaders, sync };

if (require.main === module) {
  const check = process.argv.includes('--check');
  const ok = sync(check);
  if (check) {
    console.log(ok ? 'FORM_HEADERS ตรงกับ forms-spec.js' : 'FORM_HEADERS ไม่ตรงกับ forms-spec.js — รัน node scripts/sync-headers.js');
    process.exit(ok ? 0 : 1);
  }
  console.log('อัปเดต FORM_HEADERS ใน Code.gs แล้ว');
}
