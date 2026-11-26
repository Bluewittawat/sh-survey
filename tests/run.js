#!/usr/bin/env node
/*
 * ชุดทดสอบแบบไม่ต้องติดตั้งอะไรเพิ่ม: node tests/run.js
 *  - โหลด forms-spec.js + ส่วน <script id="survey-core"> จาก index.html ใน vm
 *  - โหลด Code.gs พร้อม mock ของ SpreadsheetApp / LockService / ContentService
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const plain = (x) => JSON.parse(JSON.stringify(x));
const eq = (a, b, msg) => assert.deepStrictEqual(plain(a), plain(b), msg);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e)); }
}

/* ------------------------------------------------------------- load front-end core */
const html = read('index.html');
const coreMatch = /<script id="survey-core">([\s\S]*?)<\/script>/.exec(html);
if (!coreMatch) throw new Error('survey-core script not found in index.html');
const ctx = vm.createContext({ console });
vm.runInContext(read('forms-spec.js'), ctx, { filename: 'forms-spec.js' });
vm.runInContext(coreMatch[1], ctx, { filename: 'index.html#survey-core' });
const C = vm.runInContext(`({ CONFIG, FORMS, CORE_ITEMS, intro, OTHER, OTHER_PREFIX, KNOWN_TYPES, MAXLEN,
  findForm, isQuestion, isRequired, levelOf, gridColumn, validateItem, progressOf, buildPayload, columnNames,
  isScriptUrlSet })`, ctx);

const find = (spec, pred) => {
  for (const p of spec.pages) for (const it of p.items) if (pred(it)) return it;
  return null;
};
const allItems = (spec) => spec.pages.flatMap((p) => p.items);

console.log('\nforms-spec / index.html core');

test('มีครบ 4 ชุด SH1–SH4 และ findForm ใช้ได้', () => {
  eq(C.FORMS.map((f) => f.key), ['SH1', 'SH2', 'SH3', 'SH4']);
  assert.strictEqual(C.findForm('SH3').key, 'SH3');
  assert.strictEqual(C.findForm('SH9'), null);
});

test('ทุกข้อมีชนิดที่รู้จัก และมีข้อมูลที่ชนิดนั้นต้องใช้', () => {
  for (const spec of C.FORMS) {
    for (const it of allItems(spec)) {
      assert.ok(C.KNOWN_TYPES.includes(it.type), `${spec.key}: unknown type ${it.type}`);
      assert.ok(typeof it.title === 'string' && it.title.trim(), `${spec.key}: item without title`);
      if (it.type === 'mc' || it.type === 'cb') assert.ok(Array.isArray(it.choices) && it.choices.length, it.title);
      if (it.type === 'grid') {
        assert.ok(it.rows.length && it.cols.length, it.title);
        for (const c of it.cols) assert.ok(Number.isInteger(C.levelOf(c)), `col without level: ${c}`);
      }
    }
  }
});

test('index.html มีตัวแสดงผล (RENDERERS) ครบทุกชนิดใน KNOWN_TYPES', () => {
  const m = /const RENDERERS = \{([\s\S]*?)\};/.exec(html);
  assert.ok(m, 'RENDERERS not found');
  const keys = [...m[1].matchAll(/^\s*(\w+):/gm)].map((x) => x[1]);
  eq([...keys].sort(), [...C.KNOWN_TYPES].sort());
});

test('ชื่อคอลัมน์ไม่ซ้ำกันภายในแต่ละชุด และไม่ขึ้นต้นด้วย _', () => {
  for (const spec of C.FORMS) {
    const cols = C.columnNames(spec);
    const dup = cols.filter((c, i) => cols.indexOf(c) !== i);
    eq(dup, [], `${spec.key} duplicate columns`);
    assert.ok(cols.every((c) => c.charAt(0) !== '_'));
    assert.ok(cols.length + 3 <= 150, `${spec.key} exceeds 150 params`);
  }
});

test('ไม่มี innerHTML / outerHTML / insertAdjacentHTML / document.write ใน index.html', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(html));
});

test('ข้อคำถามใน index.html ไม่ได้พิมพ์ซ้ำ (มาจาก forms-spec.js)', () => {
  for (const spec of C.FORMS) {
    for (const it of allItems(spec)) {
      if (it.title.length > 12) assert.ok(!html.includes(it.title), `title duplicated in index.html: ${it.title}`);
    }
  }
});

test('intro แปลงเป็นย่อหน้าได้ และใส่ชื่อกลุ่ม', () => {
  const lines = C.intro('กลุ่มทดสอบ').split('\n');
  assert.strictEqual(lines[0], 'คำชี้แจง');
  assert.ok(lines.some((l) => l.includes('กลุ่มทดสอบ')));
});

console.log('\nvalidation');
const SH1 = C.findForm('SH1');
const SH3 = C.findForm('SH3');
const grid5 = find(SH1, (i) => i.type === 'grid');
const mcOther = find(SH1, (i) => i.type === 'mc' && i.other);
const mcPlain = find(SH1, (i) => i.type === 'mc' && !i.other);
const cbMax = find(SH1, (i) => i.type === 'cb' && i.max);
const cbFree = find(SH1, (i) => i.type === 'cb' && !i.max);
const paraOpt = find(SH1, (i) => i.type === 'para');
const textOpt = find(SH1, (i) => i.type === 'text');
const scale = find(SH3, (i) => i.type === 'scale');

test('section ไม่ต้องตอบ', () => {
  assert.strictEqual(C.validateItem(find(SH1, (i) => i.type === 'section'), undefined), null);
});

test('ข้อบังคับว่าง → ไม่ผ่าน', () => {
  assert.ok(C.validateItem(mcPlain, undefined));
  assert.ok(C.validateItem(mcPlain, { value: '' }));
  assert.ok(C.validateItem(cbFree, { values: [] }));
  assert.ok(C.validateItem(scale, ''));
});

test('mc: ค่าที่ไม่อยู่ในตัวเลือก → ไม่ผ่าน, ตัวเลือกถูก → ผ่าน', () => {
  assert.ok(C.validateItem(mcPlain, { value: 'ค่าแปลก ๆ' }));
  assert.strictEqual(C.validateItem(mcPlain, { value: mcPlain.choices[0] }), null);
});

test('grid ไม่ครบ → ไม่ผ่าน และบอกแถวที่ขาด', () => {
  const rows = {};
  grid5.rows.forEach((r, i) => { if (i !== 2 && i !== 6) rows[r] = grid5.cols[0]; });
  const e = C.validateItem(grid5, { rows });
  assert.ok(e, 'should fail');
  eq(e.missingRows, [grid5.rows[2], grid5.rows[6]]);
  assert.ok(e.message.includes('(3) ' + grid5.rows[2]) && e.message.includes('(7) ' + grid5.rows[6]), e.message);
  assert.ok(e.message.includes('2 แถว'));
});

test('grid ว่างทั้งหมด → บอกว่ายังไม่ได้ตอบทุกแถว', () => {
  const e = C.validateItem(grid5, undefined);
  assert.strictEqual(e.missingRows.length, grid5.rows.length);
});

test('grid ครบ → ผ่าน; ค่าที่ไม่อยู่ใน cols นับว่ายังไม่ตอบ', () => {
  const rows = Object.fromEntries(grid5.rows.map((r) => [r, grid5.cols[1]]));
  assert.strictEqual(C.validateItem(grid5, { rows }), null);
  rows[grid5.rows[0]] = '9 ไม่มีจริง';
  eq(C.validateItem(grid5, { rows }).missingRows, [grid5.rows[0]]);
});

test('เลือก other แต่ไม่กรอก → ไม่ผ่าน (mc และ cb)', () => {
  const e1 = C.validateItem(mcOther, { value: C.OTHER, other: '   ' });
  assert.ok(e1 && e1.field === 'other');
  assert.strictEqual(C.validateItem(mcOther, { value: C.OTHER, other: 'งานซ่อมบำรุง' }), null);
  const e2 = C.validateItem(cbMax, { values: [cbMax.choices[0], C.OTHER], other: '' });
  assert.ok(e2 && e2.field === 'other');
});

test('cb เลือกเกิน max → ไม่ผ่าน; other นับเป็น 1 ข้อ', () => {
  assert.ok(C.validateItem(cbMax, { values: cbMax.choices.slice(0, 4) }));
  assert.ok(C.validateItem(cbMax, { values: cbMax.choices.slice(0, 3).concat(C.OTHER), other: 'x' }));
  assert.strictEqual(C.validateItem(cbMax, { values: cbMax.choices.slice(0, 2).concat(C.OTHER), other: 'x' }), null);
  assert.strictEqual(C.validateItem(cbMax, { values: cbMax.choices.slice(0, 3) }), null);
});

test('ข้อไม่บังคับปล่อยว่างได้', () => {
  assert.strictEqual(C.isRequired(paraOpt), false);
  assert.strictEqual(C.validateItem(paraOpt, undefined), null);
  assert.strictEqual(C.validateItem(paraOpt, '   '), null);
  assert.strictEqual(C.validateItem(textOpt, ''), null);
});

test('text/para เกินความยาว → ไม่ผ่าน', () => {
  assert.ok(C.validateItem(textOpt, 'ก'.repeat(501)));
  assert.strictEqual(C.validateItem(textOpt, 'ก'.repeat(500)), null);
  assert.ok(C.validateItem(paraOpt, 'ก'.repeat(2001)));
});

test('scale รับเฉพาะจำนวนเต็ม 1–5', () => {
  assert.strictEqual(C.validateItem(scale, 4), null);
  assert.ok(C.validateItem(scale, 6));
  assert.ok(C.validateItem(scale, 2.5));
});

test('ความคืบหน้านับข้อบังคับ โดย grid นับทีละแถว', () => {
  const p0 = C.progressOf(SH1, {});
  let expected = 0;
  for (const it of allItems(SH1)) if (C.isRequired(it)) expected += it.type === 'grid' ? it.rows.length : 1;
  eq(p0, { total: expected, done: 0 });
  const p1 = C.progressOf(SH1, { [grid5.title]: { rows: { [grid5.rows[0]]: grid5.cols[0] } }, [paraOpt.title]: 'x' });
  assert.strictEqual(p1.done, 1);
});

console.log('\npayload');

test('grid ได้ชื่อคอลัมน์ "<title> [<row>]" และค่าเป็นตัวเลข', () => {
  const rows = {};
  grid5.rows.forEach((r, i) => { rows[r] = grid5.cols[i % 5]; });
  const pl = C.buildPayload(SH1, { [grid5.title]: { rows } }, {});
  grid5.rows.forEach((r, i) => {
    const pair = pl.find((p) => p[0] === grid5.title + ' [' + r + ']');
    assert.ok(pair, 'missing column for row ' + r);
    assert.strictEqual(typeof pair[1], 'number');
    assert.strictEqual(pair[1], 5 - (i % 5));
  });
});

test('meta และลำดับ: _form, _hp, _started มาก่อน แล้วตามลำดับข้อ', () => {
  const pl = C.buildPayload(SH1, {}, { hp: '', started: '2026-11-26T10:00:00.000Z' });
  eq(pl.slice(0, 3), [['_form', 'SH1'], ['_hp', ''], ['_started', '2026-11-26T10:00:00.000Z']]);
  assert.strictEqual(pl[3][0], mcOther.title);
});

test('mc other ส่งเป็น "อื่น ๆ: <ข้อความ>"; cb รวมด้วย ", " ตามลำดับตัวเลือก', () => {
  const pl = C.buildPayload(SH1, {
    [mcOther.title]: { value: C.OTHER, other: '  ผลิตอาหาร ' },
    [cbMax.title]: { values: [C.OTHER, cbMax.choices[2], cbMax.choices[0]], other: 'ระบบราง' },
  }, {});
  const get = (k) => pl.find((p) => p[0] === k)[1];
  assert.strictEqual(get(mcOther.title), 'อื่น ๆ: ผลิตอาหาร');
  assert.strictEqual(get(cbMax.title), cbMax.choices[0] + ', ' + cbMax.choices[2] + ', อื่น ๆ: ระบบราง');
});

test('scale ส่งเป็นตัวเลข; text ถูกตัดที่ 500', () => {
  const pl = C.buildPayload(SH3, { [scale.title]: 4 }, {});
  assert.strictEqual(pl.find((p) => p[0] === scale.title)[1], 4);
  const t = C.buildPayload(SH1, { [textOpt.title]: 'ก'.repeat(800) }, {}).find((p) => p[0] === textOpt.title)[1];
  assert.strictEqual(t.length, 500);
});

test('isScriptUrlSet ตรวจ placeholder', () => {
  assert.strictEqual(C.isScriptUrlSet('PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE'), false);
  assert.strictEqual(C.isScriptUrlSet('https://script.google.com/macros/s/abc/exec'), true);
  assert.strictEqual(C.isScriptUrlSet('http://example.com/exec'), false);
  assert.strictEqual(C.isScriptUrlSet('http://127.0.0.1:8080/__submit'), true);
  const m = /const SCRIPT_URL = '([^']*)'/.exec(html);
  assert.ok(m, 'SCRIPT_URL constant not found');
});

/* ------------------------------------------------------------- Code.gs with mocks */
console.log('\nCode.gs (mock Apps Script)');

function makeGas() {
  class Sheet {
    constructor(name) { this.name = name; this.data = []; this.maxCols = 26; this.frozen = 0; this.bold = []; }
    getLastRow() { return this.data.length; }
    getLastColumn() { return this.data.reduce((m, r) => { let n = r.length; while (n && (r[n - 1] === '' || r[n - 1] === undefined)) n--; return Math.max(m, n); }, 0); }
    getMaxColumns() { return this.maxCols; }
    insertColumnsAfter(after, n) { this.maxCols += n; }
    getRange(r, c, nr = 1, nc = 1) {
      if (c + nc - 1 > this.maxCols) throw new Error('outside the dimensions of the sheet');
      return new Range(this, r, c, nr, nc);
    }
    getDataRange() { return new Range(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
    appendRow(row) {
      if (row.length > this.maxCols) throw new Error('appendRow outside dimensions');
      this.data.push(row.slice());
    }
    setFrozenRows(n) { this.frozen = n; }
    clear() { this.data = []; }
    setColumnWidth() {}
    autoResizeColumns() {}
  }
  class Range {
    constructor(s, r, c, nr, nc) { Object.assign(this, { s, r, c, nr, nc }); }
    getValues() {
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = this.s.data[this.r - 1 + i] || [];
        out.push(Array.from({ length: this.nc }, (_, j) => (row[this.c - 1 + j] === undefined ? '' : row[this.c - 1 + j])));
      }
      return out;
    }
    setValues(v) {
      assert.strictEqual(v.length, this.nr, 'row count mismatch');
      v.forEach((row, i) => {
        assert.strictEqual(row.length, this.nc, 'col count mismatch');
        const ri = this.r - 1 + i;
        while (this.s.data.length <= ri) this.s.data.push([]);
        const target = this.s.data[ri];
        row.forEach((val, j) => {
          const ci = this.c - 1 + j;
          while (target.length < ci) target.push('');
          target[ci] = val;
        });
      });
      return this;
    }
    setFontWeight(w) { if (this.r === 1 && w === 'bold') this.s.bold.push([this.c, this.nc]); return this; }
    setNumberFormat() { return this; }
  }
  const sheets = {};
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = new Sheet(n)),
  };
  let lockHeld = false;
  const gctx = vm.createContext({
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => ({}) },
    LockService: { getScriptLock: () => ({ tryLock: () => (lockHeld = true), releaseLock: () => { lockHeld = false; } }) },
    ContentService: {
      MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
      createTextOutput: (s) => ({ content: s, setMimeType() { return this; } }),
    },
  });
  vm.runInContext(read('Code.gs'), gctx, { filename: 'Code.gs' });
  return { g: gctx, sheets, isLocked: () => lockHeld };
}

function post(g, pairs) {
  const body = new URLSearchParams();
  pairs.forEach((p) => body.append(p[0], String(p[1])));
  const out = g.doPost({ postData: { type: 'application/x-www-form-urlencoded', contents: body.toString() }, parameter: {} });
  return JSON.parse(out.content);
}

test('doGet ตอบข้อความทดสอบ', () => {
  const { g } = makeGas();
  assert.strictEqual(g.doGet().content, 'Survey endpoint is running.');
});

test('_form ไม่ถูกต้อง → ok:false และไม่สร้างแท็บ', () => {
  const { g, sheets } = makeGas();
  assert.strictEqual(post(g, [['_form', 'SH5'], ['x', '1']]).ok, false);
  assert.strictEqual(post(g, [['x', '1']]).ok, false);
  eq(Object.keys(sheets), []);
});

test('honeypot มีค่า → ok:true แต่ไม่บันทึก', () => {
  const { g, sheets } = makeGas();
  assert.strictEqual(post(g, [['_form', 'SH1'], ['_hp', 'spam'], ['a', '1']]).ok, true);
  eq(Object.keys(sheets), []);
});

test('บันทึกเต็มชุด SH3 (31+ คอลัมน์ เกิน 26 คอลัมน์เริ่มต้น) เรียงตามลำดับที่ส่ง', () => {
  const { g, sheets, isLocked } = makeGas();
  const spec = C.findForm('SH3');
  const answers = {};
  for (const it of allItems(spec)) {
    if (it.type === 'mc') answers[it.title] = { value: it.choices[0] };
    if (it.type === 'cb') answers[it.title] = { values: [it.choices[0], it.choices[1]] };
    if (it.type === 'grid') answers[it.title] = { rows: Object.fromEntries(it.rows.map((r) => [r, it.cols[0]])) };
    if (it.type === 'scale') answers[it.title] = 5;
  }
  const pl = C.buildPayload(spec, answers, { started: '2026-11-26T03:00:00.000Z' });
  assert.strictEqual(post(g, pl).ok, true);
  assert.strictEqual(isLocked(), false, 'lock released');
  const sh = sheets['คำตอบ SH3'];
  assert.ok(sh);
  const headers = sh.data[0];
  eq(headers.slice(0, 2), ['เวลาที่ส่ง', 'เวลาเริ่มทำ']);
  eq(headers.slice(2), C.columnNames(spec));
  assert.strictEqual(sh.frozen, 1);
  assert.ok(sh.bold.length > 0);
  const row = sh.data[1];
  assert.ok(row[0] instanceof Date || Object.prototype.toString.call(row[0]) === '[object Date]');
  assert.strictEqual(new Date(row[1]).toISOString(), '2026-11-26T03:00:00.000Z');
  const gi = headers.findIndex((h) => / \[/.test(h));
  assert.strictEqual(row[gi], 5);
  assert.strictEqual(typeof row[gi], 'number');
});

test('คีย์ใหม่ → เพิ่มคอลัมน์ต่อท้าย, แถวเก่าไม่เลื่อน', () => {
  const { g, sheets } = makeGas();
  post(g, [['_form', 'SH4'], ['_started', ''], ['ก', 'a'], ['ข', 'b']]);
  post(g, [['_form', 'SH4'], ['_started', ''], ['ข', 'b2'], ['ค', 'c2']]);
  const v = sheets['คำตอบ SH4'].getDataRange().getValues();
  eq(v[0], ['เวลาที่ส่ง', 'เวลาเริ่มทำ', 'ก', 'ข', 'ค']);
  eq(v[1].slice(2), ['a', 'b', '']);
  eq(v[2].slice(2), ['', 'b2', 'c2']);
});

test('กัน formula injection และแปลงตัวเลขล้วนเป็น Number', () => {
  const { g, sheets } = makeGas();
  post(g, [['_form', 'SH2'], ['f1', '=IMPORTXML("x")'], ['f2', '+1+2'], ['f3', '-5'], ['f4', '@me'], ['f5', '3.5'], ['f6', 'ปกติ'], ['=bad', 'v']]);
  const sh = sheets['คำตอบ SH2'];
  const h = sh.data[0];
  const row = sh.data[1];
  const val = (k) => row[h.indexOf(k)];
  assert.strictEqual(val('f1'), '\'=IMPORTXML("x")');
  assert.strictEqual(val('f2'), "'+1+2");
  assert.strictEqual(val('f3'), -5);
  assert.strictEqual(val('f4'), "'@me");
  assert.strictEqual(val('f5'), 3.5);
  assert.strictEqual(val('f6'), 'ปกติ');
  assert.ok(h.includes("'=bad"), 'header escaped');
});

test('ค่ายาวเกิน 2000 ถูกตัด; เกิน 150 พารามิเตอร์ → ok:false', () => {
  const { g, sheets } = makeGas();
  post(g, [['_form', 'SH1'], ['long', 'ก'.repeat(3000)]]);
  const sh = sheets['คำตอบ SH1'];
  assert.strictEqual(sh.data[1][sh.data[0].indexOf('long')].length, 2000);
  const many = [['_form', 'SH1']];
  for (let i = 0; i < 150; i++) many.push(['k' + i, 'v']);
  assert.strictEqual(post(g, many).ok, false);
});

test('setupSheets สร้างแท็บคำตอบ 4 แท็บ + แท็บโยง PLO และเกณฑ์', () => {
  const { g, sheets } = makeGas();
  g.setupSheets();
  for (const k of ['SH1', 'SH2', 'SH3', 'SH4']) assert.ok(sheets['คำตอบ ' + k], k);
  const m = sheets['การโยงข้อคำถามกับ PLO'];
  eq(m.data[0].slice(0, 3), ['ข้อคำถามร่วม', 'PLO', 'EC-ES']);
  assert.strictEqual(m.data[1][0], C.CORE_ITEMS[0][0]);
  assert.strictEqual(m.data[3][2], "'-");
  eq(m.data.slice(1, 6).map((r) => [r[4], r[5]]), [
    ['4.51–5.00', 'มากที่สุด'], ['3.51–4.50', 'มาก'], ['2.51–3.50', 'ปานกลาง'], ['1.51–2.50', 'น้อย'], ['1.00–1.50', 'น้อยที่สุด'],
  ]);
});

test('CORE_ITEMS ใน Code.gs ตรงกับ forms-spec.js', () => {
  const { g } = makeGas();
  eq(JSON.parse(JSON.stringify(g.CORE_ITEMS)), JSON.parse(JSON.stringify(C.CORE_ITEMS)));
});

test('summarize คำนวณ n, x̄, S.D. (n−1) และแปลความหมาย', () => {
  const { g, sheets } = makeGas();
  const spec = C.findForm('SH3');
  const grid = find(spec, (i) => i.type === 'grid');
  const sc = find(spec, (i) => i.type === 'scale');
  const levels = [5, 4, 4];
  levels.forEach((lv) => {
    const col = grid.cols.find((c) => C.levelOf(c) === lv);
    const ans = {
      [grid.title]: { rows: Object.fromEntries(grid.rows.map((r) => [r, col])) },
      [sc.title]: lv,
      [find(spec, (i) => i.type === 'text').title]: 'มทร.ล้านนา วิศวกรรมไฟฟ้า',
    };
    post(g, C.buildPayload(spec, ans, {}));
  });
  g.summarize();
  const out = sheets['สรุปผล'];
  const header = out.data[2];
  eq(header, ['ชุด', 'ข้อคำถาม', 'ข้อย่อย', 'PLO', 'n', 'x̄', 'S.D.', 'แปลความหมาย']);
  const rows = out.data.slice(3);
  const first = rows.find((r) => r[0] === 'SH3' && r[2] === grid.rows[0]);
  assert.ok(first, 'grid row summarised');
  assert.strictEqual(first[1], grid.title);
  assert.strictEqual(first[3], 'PLO1');
  assert.strictEqual(first[4], 3);
  assert.strictEqual(first[5], 4.33);
  assert.strictEqual(first[6], 0.58);
  assert.strictEqual(first[7], 'มาก');
  assert.ok(rows.find((r) => r[1] === sc.title && r[4] === 3), 'scale summarised');
  // ตอบเฉพาะ grid ข้อ 5 (11 แถว) + scale 1 ข้อ; grid ข้อ 6 ว่างจึงไม่ถูกสรุป
  assert.strictEqual(rows.filter((r) => r[0] === 'SH3').length, grid.rows.length + 1);
  assert.ok(!rows.some((r) => String(r[1]).startsWith('4.')), 'text column excluded');
  assert.ok(rows.find((r) => r[0] === 'SH1' && r[1] === '(ยังไม่มีคำตอบ)'));
});

test('เกณฑ์แปลความหมายตรงขอบช่วง', () => {
  const { g } = makeGas();
  assert.strictEqual(g.interpret_(4.51), 'มากที่สุด');
  assert.strictEqual(g.interpret_(4.50), 'มาก');
  assert.strictEqual(g.interpret_(3.51), 'มาก');
  assert.strictEqual(g.interpret_(2.51), 'ปานกลาง');
  assert.strictEqual(g.interpret_(1.51), 'น้อย');
  assert.strictEqual(g.interpret_(1.50), 'น้อยที่สุด');
  assert.strictEqual(g.interpret_(1.00), 'น้อยที่สุด');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
