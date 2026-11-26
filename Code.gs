/**
 * ปลายทางรับคำตอบแบบสอบถาม SH1–SH4 (Google Apps Script Web App)
 * วางไฟล์นี้ใน Extensions > Apps Script ของ Google Sheet ปลายทาง
 *
 * ฟังก์ชันที่รันด้วยมือ:
 *   setupSheets()  สร้างแท็บคำตอบ 4 แท็บ และแท็บการโยงข้อคำถามกับ PLO (รันครั้งแรกครั้งเดียว)
 *   summarize()    สร้าง/อัปเดตแท็บ "สรุปผล" (n, x̄, S.D., การแปลความหมาย)
 */

var FORM_KEYS = ['SH1', 'SH2', 'SH3', 'SH4'];
var SHEET_PREFIX = 'คำตอบ ';
var MAP_SHEET = 'การโยงข้อคำถามกับ PLO';
var SUMMARY_SHEET = 'สรุปผล';
var BASE_HEADERS = ['เวลาที่ส่ง', 'เวลาเริ่มทำ'];
var MAX_PARAMS = 150;
var MAX_VALUE_LEN = 2000;
var MAX_KEY_LEN = 500;
var DATE_FORMAT = 'yyyy-mm-dd hh:mm:ss';

/* คัดลอกจาก forms-spec.js (Apps Script ไม่ได้อ่านไฟล์นั้น) ถ้าแก้ที่หนึ่งต้องแก้อีกที่ด้วย */
var CORE_ITEMS = [
  ['ความรู้พื้นฐานทางคณิตศาสตร์ วิทยาศาสตร์ และวิศวกรรม', 'PLO1', 'EC3, EC4'],
  ['การคิดวิเคราะห์ การคำนวณ และการแก้ปัญหาทางวิศวกรรมอย่างเป็นระบบ', 'PLO2', 'ES1'],
  ['การอ่านแบบ เขียนแบบ และใช้โปรแกรมคอมพิวเตอร์ช่วยออกแบบ', 'PLO3, PLO4', '-'],
  ['การใช้เครื่องมือ เครื่องมือวัด และปฏิบัติงานช่างได้ถูกต้องตามมาตรฐาน', 'PLO3', 'EC4'],
  ['การใช้เทคโนโลยีดิจิทัลและปัญญาประดิษฐ์ (AI) อย่างรู้เท่าทัน', 'PLO4', 'EC1'],
  ['การสื่อสาร การเขียนรายงาน การนำเสนอ และการใช้ภาษาอังกฤษ', 'PLO4', '-'],
  ['ความซื่อสัตย์ ความรับผิดชอบ วินัย และจรรยาบรรณวิชาชีพ', 'PLO5', '-'],
  ['การคำนึงถึงความปลอดภัย อาชีวอนามัย พลังงาน และสิ่งแวดล้อม', 'PLO5', '-'],
  ['การทำงานเป็นทีมและการทำงานร่วมกับผู้อื่น', 'PLO5', 'ES3'],
  ['ความคิดสร้างสรรค์และการพัฒนาโครงงานหรือนวัตกรรม', 'PLO6', 'EC2, ES2'],
  ['การเรียนรู้ด้วยตนเองและการปรับตัวต่อเทคโนโลยีใหม่', 'PLO6', 'ES4'],
];

/* เกณฑ์แปลความหมายค่าเฉลี่ย (ค่าต่ำสุดของช่วง, ป้าย, ข้อความช่วง) */
var CRITERIA = [
  [4.51, 'มากที่สุด', '4.51–5.00'],
  [3.51, 'มาก', '3.51–4.50'],
  [2.51, 'ปานกลาง', '2.51–3.50'],
  [1.51, 'น้อย', '1.51–2.50'],
  [1.00, 'น้อยที่สุด', '1.00–1.50'],
];

/* ===================================================================== Web App */

function doGet() {
  return ContentService.createTextOutput('Survey endpoint is running.').setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  var lock = null;
  var locked = false;
  try {
    var pairs = parsePairs_(e);
    if (pairs === null) return json_({ ok: false, error: 'too many parameters' });

    var meta = {};
    var answers = [];
    pairs.forEach(function (p) {
      if (p[0].charAt(0) === '_') { if (!(p[0] in meta)) meta[p[0]] = p[1]; }
      else answers.push(p);
    });

    var form = String(meta._form || '');
    if (FORM_KEYS.indexOf(form) < 0) return json_({ ok: false, error: 'invalid form' });
    if (String(meta._hp || '').trim() !== '') return json_({ ok: true }); // honeypot: ทำเหมือนสำเร็จแต่ไม่บันทึก

    lock = LockService.getScriptLock();
    locked = lock.tryLock(15000);
    if (!locked) return json_({ ok: false, error: 'busy, please retry' });

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ensureResponseSheet_(ss, SHEET_PREFIX + form);
    var headers = readHeaders_(sheet);
    var originalCount = headers.length;

    var row = [];
    row[0] = new Date();
    row[1] = parseStarted_(meta._started);
    answers.forEach(function (p) {
      var key = String(p[0]).trim().slice(0, MAX_KEY_LEN);
      if (!key || BASE_HEADERS.indexOf(key) >= 0) return;
      var idx = headers.indexOf(key);
      if (idx < 0) { headers.push(key); idx = headers.length - 1; }
      row[idx] = cleanValue_(p[1]);
    });
    for (var i = 0; i < headers.length; i++) if (row[i] === undefined) row[i] = '';

    if (headers.length > originalCount) writeHeaders_(sheet, headers);
    sheet.appendRow(row);
    sheet.getRange(sheet.getLastRow(), 1, 1, 2).setNumberFormat(DATE_FORMAT);

    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    if (locked && lock) lock.releaseLock();
  }
}

/* อ่านพารามิเตอร์ตามลำดับที่ส่งมา (e.parameter ไม่รับประกันลำดับ) คืน null ถ้าเกิน MAX_PARAMS */
function parsePairs_(e) {
  var pairs = [];
  var pd = e && e.postData;
  if (pd && typeof pd.contents === 'string' && /x-www-form-urlencoded/i.test(String(pd.type || ''))) {
    var parts = pd.contents.split('&').filter(function (s) { return s !== ''; });
    if (parts.length > MAX_PARAMS) return null;
    parts.forEach(function (part) {
      var i = part.indexOf('=');
      var k = i < 0 ? part : part.slice(0, i);
      var v = i < 0 ? '' : part.slice(i + 1);
      pairs.push([decode_(k), decode_(v)]);
    });
    return pairs;
  }
  var params = (e && e.parameters) || {};
  Object.keys(params).forEach(function (k) {
    [].concat(params[k]).forEach(function (v) { pairs.push([k, String(v)]); });
  });
  return pairs.length > MAX_PARAMS ? null : pairs;
}

function decode_(s) {
  return decodeURIComponent(String(s).replace(/\+/g, ' '));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ===================================================================== ค่าในเซลล์ */

function isNumeric_(s) {
  return /^-?\d+(\.\d+)?$/.test(s);
}

/* กัน formula injection: ขึ้นต้นด้วย = + - @ และไม่ใช่ตัวเลข → เติม ' */
function escapeText_(s) {
  s = String(s);
  return (/^[=+\-@]/.test(s) && !isNumeric_(s)) ? "'" + s : s;
}

function cleanValue_(v) {
  var s = String(v == null ? '' : v).slice(0, MAX_VALUE_LEN);
  var t = s.trim();
  if (t !== '' && isNumeric_(t)) return Number(t);
  return escapeText_(s);
}

function parseStarted_(v) {
  var s = String(v == null ? '' : v).trim().slice(0, 40);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    var d = new Date(s);
    if (!isNaN(d.getTime())) return d;
  }
  return escapeText_(s);
}

/* ===================================================================== ชีต */

function ensureResponseSheet_(ss, name) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastColumn() === 0) writeHeaders_(sheet, BASE_HEADERS.slice());
  return sheet;
}

function readHeaders_(sheet) {
  var n = sheet.getLastColumn();
  if (n === 0) return BASE_HEADERS.slice();
  return sheet.getRange(1, 1, 1, n).getValues()[0].map(function (h) { return String(h); });
}

function ensureColumns_(sheet, n) {
  var max = sheet.getMaxColumns();
  if (max < n) sheet.insertColumnsAfter(max, n - max);
}

function writeHeaders_(sheet, headers) {
  ensureColumns_(sheet, headers.length);
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers.map(escapeText_)])
    .setFontWeight('bold');
  sheet.setFrozenRows(1);
}

function writeTable_(sheet, startRow, startCol, rows) {
  if (!rows.length) return;
  var width = rows[0].length;
  ensureColumns_(sheet, startCol + width - 1);
  var values = rows.map(function (r) {
    return r.map(function (v) { return typeof v === 'string' ? escapeText_(v) : v; });
  });
  sheet.getRange(startRow, startCol, values.length, width).setValues(values);
}

/* ===================================================================== ตั้งค่าครั้งแรก */

function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  FORM_KEYS.forEach(function (k) { ensureResponseSheet_(ss, SHEET_PREFIX + k); });

  var m = ss.getSheetByName(MAP_SHEET) || ss.insertSheet(MAP_SHEET);
  m.clear();
  var mapRows = [['ข้อคำถามร่วม', 'PLO', 'EC-ES']].concat(CORE_ITEMS.map(function (r) { return r.slice(); }));
  writeTable_(m, 1, 1, mapRows);
  m.getRange(1, 1, 1, 3).setFontWeight('bold');

  var critRows = [['เกณฑ์ค่าเฉลี่ย', 'การแปลความหมาย']].concat(CRITERIA.map(function (c) { return [c[2], c[1]]; }));
  writeTable_(m, 1, 5, critRows);
  m.getRange(1, 5, 1, 2).setFontWeight('bold');

  m.setFrozenRows(1);
  m.setColumnWidth(1, 460);
  m.autoResizeColumns(2, 2);
  m.autoResizeColumns(5, 2);
}

/* ===================================================================== สรุปผล */

function interpret_(mean) {
  for (var i = 0; i < CRITERIA.length; i++) if (mean >= CRITERIA[i][0]) return CRITERIA[i][1];
  return '';
}

function round2_(x) {
  return Math.round(x * 100) / 100;
}

/* คอลัมน์ที่นับเป็นมาตรวัด: ทุกค่าที่ไม่ว่างเป็นจำนวนเต็ม 1–5 (ได้แก่ทุกแถวของ grid และข้อ scale) */
function scaleValues_(data, c) {
  var vals = [];
  for (var r = 1; r < data.length; r++) {
    var v = data[r][c];
    if (v === '' || v === null) continue;
    var n = typeof v === 'number' ? v : (isNumeric_(String(v).trim()) ? Number(String(v).trim()) : NaN);
    if (!(n >= 1 && n <= 5 && n % 1 === 0)) return null;
    vals.push(n);
  }
  return vals.length ? vals : null;
}

function stats_(vals) {
  var n = vals.length;
  var mean = vals.reduce(function (a, b) { return a + b; }, 0) / n;
  var sd = '';
  if (n > 1) {
    var ss = vals.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0);
    sd = round2_(Math.sqrt(ss / (n - 1)));
  }
  var m2 = round2_(mean);
  return { n: n, mean: m2, sd: sd, label: interpret_(m2) };
}

function summarize() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var plo = {};
  CORE_ITEMS.forEach(function (r) { plo[r[0]] = r[1]; });

  var rows = [['ชุด', 'ข้อคำถาม', 'ข้อย่อย', 'PLO', 'n', 'x̄', 'S.D.', 'แปลความหมาย']];
  FORM_KEYS.forEach(function (k) {
    var sh = ss.getSheetByName(SHEET_PREFIX + k);
    if (!sh || sh.getLastRow() < 2) { rows.push([k, '(ยังไม่มีคำตอบ)', '', '', '', '', '', '']); return; }
    var data = sh.getDataRange().getValues();
    var headers = data[0];
    var found = 0;
    for (var c = BASE_HEADERS.length; c < headers.length; c++) {
      var vals = scaleValues_(data, c);
      if (!vals) continue;
      var h = String(headers[c]);
      var m = /^(.*) \[(.*)\]$/.exec(h);
      var title = m ? m[1] : h;
      var sub = m ? m[2] : '';
      var s = stats_(vals);
      rows.push([k, title, sub, plo[sub] || '', s.n, s.mean, s.sd, s.label]);
      found++;
    }
    if (!found) rows.push([k, '(ยังไม่มีข้อมูลมาตรวัด)', '', '', '', '', '', '']);
  });

  var out = ss.getSheetByName(SUMMARY_SHEET) || ss.insertSheet(SUMMARY_SHEET);
  out.clear();
  writeTable_(out, 1, 1, [['สรุปผล ณ', new Date(), 'S.D. คำนวณแบบกลุ่มตัวอย่าง (n − 1)', '', '', '', '', '']]);
  out.getRange(1, 2).setNumberFormat(DATE_FORMAT);
  writeTable_(out, 3, 1, rows);
  out.getRange(3, 1, 1, rows[0].length).setFontWeight('bold');
  if (rows.length > 1) out.getRange(4, 6, rows.length - 1, 2).setNumberFormat('0.00');
  out.setFrozenRows(3);
  out.setColumnWidth(2, 380);
  out.setColumnWidth(3, 380);
}

/* เมนูลัดในชีต */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('แบบสอบถาม')
    .addItem('สรุปผล (summarize)', 'summarize')
    .addItem('ตั้งค่าแท็บ (setupSheets)', 'setupSheets')
    .addToUi();
}
