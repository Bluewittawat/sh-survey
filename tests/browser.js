#!/usr/bin/env node
/*
 * ทดสอบในเบราว์เซอร์จริง (ไม่บังคับ) + ถ่ายภาพหน้าจอ 360px / 1280px ทั้ง light และ dark
 *
 *   npm i --no-save playwright        (หรือ playwright-core + ระบุ CHROME_PATH)
 *   node tests/browser.js
 *
 * ตัวแปรแวดล้อม:
 *   CHROME_PATH   path ของ chromium / chrome-headless-shell (ถ้าไม่ใช้ตัวที่ playwright ติดตั้ง)
 *   SHOT_DIR      โฟลเดอร์เก็บภาพ (ค่าเริ่มต้น tests/screenshots)
 *
 * เซิร์ฟเวอร์ทดสอบจะแทน SCRIPT_URL ด้วย endpoint จำลองที่ตอบ { ok: true }
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');

let pw;
try { pw = require('playwright'); } catch (e) {
  try { pw = require('playwright-core'); } catch (e2) {
    console.log('ไม่พบ playwright — ข้ามการทดสอบในเบราว์เซอร์ (npm i --no-save playwright)');
    process.exit(0);
  }
}

const ROOT = path.join(__dirname, '..');
const SHOT_DIR = process.env.SHOT_DIR || path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const submissions = [];
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/__submit' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          submissions.push({ type: req.headers['content-type'], body });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const full = path.join(ROOT, file);
      if (!full.startsWith(ROOT) || !fs.existsSync(full)) { res.writeHead(404); res.end(); return; }
      let data = fs.readFileSync(full);
      if (file === 'index.html') {
        data = data.toString('utf8').replace(/const SCRIPT_URL = '[^']*';/,
          `const SCRIPT_URL = 'http://127.0.0.1:${server.address().port}/__submit';`);
      }
      res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
      res.end(data);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n    ')); }
}

/* ตอบทุกข้อบังคับในหน้าปัจจุบัน ด้วยการคลิกจริง */
async function fillVisiblePage(page) {
  const qs = page.locator('section.page:not([hidden]) .q');
  const n = await qs.count();
  for (let i = 0; i < n; i++) {
    const q = qs.nth(i);
    const cls = await q.getAttribute('class');
    if (/q-grid/.test(cls)) {
      const rows = q.locator('tbody tr');
      const rc = await rows.count();
      for (let r = 0; r < rc; r++) await rows.nth(r).locator('label.cell').nth(r % 5).click();
    } else if (/q-mc|q-cb/.test(cls)) {
      await q.locator('label.opt').first().click();
    } else if (/q-scale/.test(cls)) {
      await q.locator('label.scale-opt').nth(3).click();
    }
  }
}

(async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await pw.chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const FORMS = await (async () => {
    const p = await browser.newPage();
    await p.goto(base + 'index.html');
    const f = await p.evaluate(() => FORMS.map((s) => ({
      key: s.key,
      questions: s.pages.flatMap((pg) => pg.items).filter((i) => i.type !== 'section').length,
      gridRows: s.pages.flatMap((pg) => pg.items).filter((i) => i.type === 'grid').map((i) => i.rows.length),
    })));
    await p.close();
    return f;
  })();

  console.log('\nbrowser');

  await test('หน้ารวมลิงก์: ไม่มีพารามิเตอร์ / ค่าผิด แสดง 4 ชุดพร้อมปุ่มคัดลอก', async () => {
    const page = await browser.newPage();
    for (const q of ['', '?f=XYZ']) {
      await page.goto(base + 'index.html' + q);
      assert.strictEqual(await page.locator('.form-list li').count(), 4);
      assert.strictEqual(await page.getByRole('button', { name: 'คัดลอกลิงก์' }).count(), 4);
      const v = await page.locator('.link-row input').first().inputValue();
      assert.ok(v.endsWith('?f=SH1'), v);
    }
    await page.close();
  });

  for (const f of FORMS) {
    await test(`${f.key}: render ครบทุกข้อ ไม่มี error`, async () => {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text())) errors.push(m.text()); });
      await page.goto(base + 'index.html?f=' + f.key);
      assert.strictEqual(await page.locator('.q').count(), f.questions);
      const rows = await page.locator('.q-grid').evaluateAll((els) => els.map((e) => e.querySelectorAll('tbody tr').length));
      assert.deepStrictEqual(rows, f.gridRows);
      assert.ok(await page.locator('.intro h2').isVisible());
      assert.deepStrictEqual(errors.filter((e) => !/ERR_(NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION)/.test(e)), []);
      await page.close();
    });
  }

  await test('SH1: validate, เลือกเกิน max, other, ส่งข้อมูล, ล้าง localStorage', async () => {
    submissions.length = 0;
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(base + 'index.html?f=SH1');
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    // กดถัดไปทั้งที่ยังว่าง → focus ข้อแรกที่ผิด
    await page.getByRole('button', { name: 'ถัดไป' }).click();
    assert.ok(await page.locator('.q.has-error').count() >= 5);
    const focusedName = await page.evaluate(() => document.activeElement && document.activeElement.closest('.q') && document.activeElement.closest('.q').querySelector('.q-title').textContent);
    assert.ok(focusedName.startsWith('1.'), 'focus on first error: ' + focusedName);

    // ตอบหน้า 1 แต่ข้าม grid 2 แถว
    await fillVisiblePage(page);
    await page.evaluate(() => {
      const rows = document.querySelectorAll('section.page:not([hidden]) .q-grid tbody tr');
      [2, 6].forEach((i) => rows[i].querySelectorAll('input').forEach((inp) => { inp.checked = false; }));
      rows[0].closest('table').dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.getByRole('button', { name: 'ถัดไป' }).click();
    const gridErr = await page.locator('.q-grid .err').first().textContent();
    assert.ok(/ยังขาด 2 แถว/.test(gridErr) && gridErr.includes('(3)') && gridErr.includes('(7)'), gridErr);
    assert.strictEqual(await page.locator('.q-grid tbody tr.missing').count(), 2);
    assert.strictEqual(await page.locator('.q-grid tbody tr.answered').count(), 9);
    const rowsMissing = page.locator('.q-grid tbody tr.missing');
    await rowsMissing.nth(1).locator('label.cell').nth(0).click();
    await rowsMissing.nth(0).locator('label.cell').nth(0).click();
    assert.strictEqual(await page.locator('.q-grid .err:not([hidden])').count(), 0, 'grid error clears live');
    await page.screenshot({ path: path.join(SHOT_DIR, 'sh1-page1-answered-1280-light.png'), fullPage: true });
    await page.getByRole('button', { name: 'ถัดไป' }).click();
    assert.ok(await page.getByRole('heading', { name: 'หน้า 2 จาก 2' }).isVisible());
    await page.waitForFunction(() => window.scrollY === 0, null, { timeout: 3000 });

    // cb max 3 → ปิดตัวเลือกที่เหลือ; other นับเป็น 1
    const cb = page.locator('.q-cb').first();
    await cb.locator('label.opt').nth(0).click();
    await cb.locator('label.opt').nth(1).click();
    await cb.locator('label.opt').last().click(); // อื่น ๆ
    assert.strictEqual(await cb.locator('input[type=checkbox]:disabled').count(), 7);
    assert.ok((await cb.locator('.hint').textContent()).includes('เลือกได้ไม่เกิน 3 ข้อ'));
    assert.ok(await cb.locator('.hint.at-limit').count() === 1);

    await fillVisiblePage(page); // คลิกตัวแรกของ cb ซ้ำ = ยกเลิก → เหลือ 2 ข้อ
    await page.getByRole('button', { name: 'ส่งคำตอบ' }).click();
    const errs = await page.locator('.q.has-error .err').allTextContents();
    assert.ok(errs.some((t) => t.includes('อื่น ๆ')), 'other text required: ' + errs.join(' | '));
    assert.strictEqual(await page.evaluate(() => document.activeElement.className), 'other-text');
    await page.keyboard.type('ระบบราง');
    await page.getByRole('button', { name: 'ส่งคำตอบ' }).click();
    await page.getByText('ได้รับคำตอบของท่านเรียบร้อยแล้ว ขอขอบพระคุณที่ให้ข้อมูลเพื่อการพัฒนาหลักสูตร').waitFor();

    assert.strictEqual(submissions.length, 1);
    assert.ok(/application\/x-www-form-urlencoded/.test(submissions[0].type), submissions[0].type);
    const p = new URLSearchParams(submissions[0].body);
    assert.strictEqual(p.get('_form'), 'SH1');
    assert.strictEqual(p.get('_hp'), '');
    assert.ok(!isNaN(Date.parse(p.get('_started'))));
    const keys = [...p.keys()];
    const gridKey = keys.find((k) => k.startsWith('5. ') && k.endsWith(']'));
    assert.ok(/^\d$/.test(p.get(gridKey)), gridKey + '=' + p.get(gridKey));
    assert.ok(p.get(keys.find((k) => k.startsWith('6. '))).endsWith('อื่น ๆ: ระบบราง'));
    assert.strictEqual(await page.evaluate(() => Object.keys(localStorage).length), 0);
    await page.close();
  });

  await test('บันทึกชั่วคราว: ปิดแล้วเปิดใหม่ตอบต่อได้', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(base + 'index.html?f=SH4');
    await page.locator('.q-mc').first().locator('label.opt').nth(1).click();
    await page.locator('.q-grid tbody tr').nth(0).locator('label.cell').nth(0).click();
    await page.reload();
    assert.ok(await page.locator('.notice').isVisible());
    assert.ok(await page.locator('.q-mc').first().locator('input').nth(1).isChecked());
    assert.ok(await page.locator('.q-grid tbody tr').nth(0).locator('input').nth(0).isChecked());
    assert.ok((await page.locator('.progress-text').textContent()).includes('ตอบแล้ว 2 /'));
    await ctx.close();
  });

  await test('ส่งไม่สำเร็จ → คงคำตอบไว้และบอกให้ส่งใหม่', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.route('**/__submit', (r) => r.abort());
    await page.goto(base + 'index.html?f=SH3');
    await fillVisiblePage(page);
    await page.getByRole('button', { name: 'ถัดไป' }).click();
    await fillVisiblePage(page);
    await page.getByRole('button', { name: 'ส่งคำตอบ' }).click();
    await page.locator('.status.is-error').waitFor();
    const st = await page.locator('.status').textContent();
    assert.ok(st.includes('ส่งคำตอบไม่สำเร็จ'), st + ' | ' + (await page.locator('.q.has-error .err').allTextContents()).join(' | '));
    assert.ok(await page.getByRole('button', { name: 'ส่งคำตอบ' }).isEnabled());
    assert.ok(await page.evaluate(() => Object.keys(localStorage).length === 1));
    await ctx.close();
  });

  await test('ไม่มี horizontal scroll ที่ 360px', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 780 } });
    for (const k of ['', '?f=SH1', '?f=SH2', '?f=SH3', '?f=SH4']) {
      await page.goto(base + 'index.html' + k);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(over <= 0, `${k || 'index'} overflows by ${over}px`);
    }
    await page.close();
  });

  /* ---------------- screenshots ---------------- */
  await test('ถ่ายภาพหน้าจอ 360/1280 × light/dark', async () => {
    for (const scheme of ['light', 'dark']) {
      for (const width of [360, 1280]) {
        const ctx = await browser.newContext({ viewport: { width, height: width === 360 ? 780 : 900 }, colorScheme: scheme, deviceScaleFactor: width === 360 ? 2 : 1 });
        const page = await ctx.newPage();
        const tag = `${width}-${scheme}`;
        await page.goto(base + 'index.html');
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(SHOT_DIR, `index-${tag}.png`), fullPage: true });
        await page.goto(base + 'index.html?f=SH1');
        await page.waitForTimeout(300);
        // ตอบบางแถวเพื่อให้เห็นสถานะ answered และกดถัดไปเพื่อให้เห็น error
        await page.locator('.q-mc').first().locator('label.opt').nth(2).click();
        const rows = page.locator('.q-grid tbody tr');
        for (let r = 0; r < 4; r++) await rows.nth(r).locator('label.cell').nth(r % 3).click();
        await page.getByRole('button', { name: 'ถัดไป' }).click();
        await page.waitForTimeout(200);
        await page.screenshot({ path: path.join(SHOT_DIR, `sh1-p1-errors-${tag}.png`), fullPage: true });
        await page.locator('.q-grid').first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(SHOT_DIR, `sh1-grid-viewport-${tag}.png`) });
        await page.goto(base + 'index.html?f=SH3');
        await page.evaluate(() => localStorage.clear());
        await page.reload();
        await fillVisiblePage(page);
        await page.getByRole('button', { name: 'ถัดไป' }).click();
        await page.locator('.q-cb').first().locator('label.opt').nth(0).click();
        await page.locator('.q-cb').first().locator('label.opt').nth(2).click();
        await page.locator('.q-cb').first().locator('label.opt').nth(4).click();
        await page.locator('.q-scale label.scale-opt').nth(3).click();
        await page.screenshot({ path: path.join(SHOT_DIR, `sh3-p2-${tag}.png`), fullPage: true });
        await ctx.close();
      }
    }
  });

  await browser.close();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed  (ภาพหน้าจออยู่ที่ ${SHOT_DIR})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
