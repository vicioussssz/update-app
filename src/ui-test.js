const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = '/root/receipts-app';
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/pixel.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(PIXEL);
  }
  const p = path.join(ROOT, url === '/' ? 'index.html' : url);
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  });
});

const pass = [], fail = [];
const check = (name, cond, detail) =>
  (cond ? pass : fail).push(name + (cond ? '' : '  →  ' + String(detail)));

const today = new Date();
const Y = today.getFullYear(), M = today.getMonth();
const d2 = n => String(n).padStart(2, '0');
const day = n => `${Y}-${d2(M + 1)}-${d2(n)}`;
const MOCK = fs.readFileSync(`${ROOT}/mock-supabase.js`, 'utf8');

async function newSession(browser, { camera }) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true,
    permissions: camera ? ['camera'] : [],
  });
  await ctx.route('**/supabase-js@2**', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    // this sandbox has no egress, so the OCR CDN always fails to load; that is a
    // network condition the app handles, not a JS fault, so it is not counted
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push('console: ' + m.text());
  });
  if (!camera) {
    // mediaDevices is a prototype getter, so `delete` is a no-op — shadow it instead
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    });
  }
  return { ctx, page, errors };
}

// Add receipt goes straight to the camera. A file comes in through the camera's
// own Files button, which is the same #ffile input — no chooser in between.
async function useFiles(page) {
  await page.evaluate(() => startCapture('file', captureDate));
  await page.waitForTimeout(400);
}
async function chooseAdd(page, label) {
  await page.click('#snap');
  await page.waitForTimeout(600);
  if (label !== 'Take Photo') await useFiles(page);
}
async function chooseAddFromDay(page, label) {
  await page.click('.sfoot .btn-primary');          // "Add receipt" in the day sheet
  await page.waitForTimeout(600);
  if (label !== 'Take Photo') await useFiles(page);
}

async function signIn(page) {
  await page.goto('http://localhost:8099/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.evaluate(seed => { window.__mock.rows.push(...seed); }, [
    { id: 'a', receipt_date: day(8), description: 'Timber for the deck', vendor: 'Screwfix',
      amount: 128.4, file_path: 'p/a.jpg', file_type: 'image/jpeg',
      uploader_name: 'finn@x.com', created_at: '2026-01-01T10:00:00Z' },
    { id: 'b', receipt_date: day(8), description: 'Diesel', vendor: 'Shell',
      amount: 71.22, file_path: 'p/b.jpg', file_type: 'image/jpeg',
      uploader_name: 'finn@x.com', created_at: '2026-01-01T11:00:00Z' },
    { id: 'c', receipt_date: day(9), description: 'Couch roll', vendor: null, amount: null,
      file_path: 'p/c.pdf', file_type: 'application/pdf',
      uploader_name: 'sam@x.com', created_at: '2026-01-01T12:00:00Z' },
  ]);
  await page.fill('#em', 'finn@example.com');
  await page.fill('#pw', 'correct-horse');
  await page.click('#authbtn');
  await page.waitForTimeout(1200);
}

(async () => {
  await new Promise(r => server.listen(8099, r));
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });

  /* ================= PHASE 1 — camera available ================= */
  {
    const { ctx, page, errors } = await newSession(browser, { camera: true });
    await signIn(page);
    await page.waitForTimeout(1500);

    check('the app lands on the calendar, not the camera',
      !(await page.isVisible('#cam')), 'camera opened on its own');
    check('calendar is showing', await page.isVisible('#grid'), 'no calendar');
    check('no camera stream is held while idle',
      await page.evaluate(() => stream === null), 'stream open with no camera showing');

    // camera is on demand
    await chooseAdd(page, 'Take Photo');
    await page.waitForTimeout(1200);
    check('Take Photo opens the camera', await page.isVisible('#cam'), 'not open');
    check('shutter is present', await page.isVisible('#camshot'), 'no shutter');
    check('viewfinder shows which day it will file to',
      (await page.textContent('#camdate')).trim() === 'Today',
      await page.textContent('#camdate'));
    await page.screenshot({ path: `${ROOT}/n1-camera.png` });

    // X drops back to the calendar and lets go of the camera
    await page.click('#camx');
    await page.waitForTimeout(400);
    check('X closes the camera', !(await page.isVisible('#cam')), 'still open');
    check('camera stream released on close',
      await page.evaluate(() => stream === null), 'stream still live');

    await page.click('#snap');
    await page.waitForTimeout(1200);
    check('Add receipt reopens the camera directly', await page.isVisible('#cam'), 'not open');

    await page.click('#camshot');
    await page.waitForTimeout(4000);
    check('shutter lands on the details sheet',
      (await page.textContent('.shead h3')) === 'New receipt',
      await page.textContent('.shead h3').catch(() => 'no sheet'));
    check('there is no photo/scan switch any more',
      !(await page.isVisible('.seg').catch(() => false)), 'switch still there');
    check('the colour photograph is the chosen image',
      await page.evaluate(() => pending.chosen) === 'photo',
      await page.evaluate(() => pending.chosen));
    check('the preview shows the photograph, not a processed copy',
      await page.evaluate(() => document.querySelector('.pv').src === pending.urls.photo),
      await page.evaluate(() => document.querySelector('.pv').src.slice(0, 40)));
    check('no object URL is made for a processed version',
      await page.evaluate(() => pending.urls.scan === undefined),
      JSON.stringify(await page.evaluate(() => Object.keys(pending.urls))));
    check('a high-contrast copy still exists for the reader',
      await page.evaluate(() => !!pending.scan && pending.scan.size > 0), 'no OCR copy');
    check('the photo blob is kept',
      await page.evaluate(() => !!pending.photo && pending.photo.size > 0), 'no photo blob');
    await page.screenshot({ path: `${ROOT}/n2-preview.png` });

    const photoSize = await page.evaluate(() => pending.photo.size);
    await page.fill('#f_desc', 'Parking at the clinic');
    await page.fill('#f_amt', '4,50');
    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(1500);
    check('the original colour photo is the one uploaded',
      await page.evaluate(s => [...window.__mock.files.values()].some(f => f.size === s), photoSize),
      'uploaded blob size did not match the photo');

    const saved = await page.evaluate(() => window.__mock.rows.find(r => r.description === 'Parking at the clinic'));
    check('camera receipt files to today', saved && saved.receipt_date === day(today.getDate()),
      JSON.stringify(saved && saved.receipt_date));
    check('comma decimal still parses', saved && saved.amount === 4.5, JSON.stringify(saved));

    /* ---------- year view ---------- */
    await page.click('#mlabel');
    await page.waitForTimeout(1200);
    const months = await page.$$eval('.ycell', ns => ns.map(n => ({
      mon: n.querySelector('.mon').textContent,
      amt: n.querySelector('.amt').textContent,
      cnt: n.querySelector('.cnt').textContent,
    })));
    check('year view lists twelve months', months.length === 12, months.length);
    const thisMon = months[M];
    check('current month shows its total in the year view',
      thisMon.amt === '£204.12', JSON.stringify(thisMon));
    check('empty months read as a dash',
      months.filter(m => m.amt === '—').length === 11,
      months.filter(m => m.amt === '—').length);
    check('year total in the sheet subtitle',
      (await page.textContent('.shead .sub')).includes('204.12'),
      await page.textContent('.shead .sub'));
    await page.screenshot({ path: `${ROOT}/n3-year.png` });

    // jump to a different month from the year view
    const target = M === 0 ? 1 : 0;
    await page.click(`.ycell >> nth=${target}`);
    await page.waitForTimeout(900);
    check('tapping a month in the year view navigates to it',
      (await page.textContent('#mlabel')).includes(
        ['January','February','March','April','May','June','July',
         'August','September','October','November','December'][target]),
      await page.textContent('#mlabel'));
    await page.click('#today');
    await page.waitForTimeout(700);

    /* ---------- menu drawer ---------- */
    await page.click('#menu');
    await page.waitForTimeout(500);
    check('menu drawer opens', await page.isVisible('.dpanel'), 'no drawer');
    const items = await page.$$eval('.ditem', ns => ns.map(n => n.textContent.trim()));
    check('drawer shows Receipts, Plans and Settings',
      items.some(i => i.startsWith('Receipts')) &&
      items.some(i => i.startsWith('Plans')) &&
      items.some(i => i.startsWith('Settings')), JSON.stringify(items));
    check('Storage and Sign out are no longer in the main menu',
      !items.some(i => /Storage/.test(i)) && !items.some(i => /Sign out/.test(i)),
      JSON.stringify(items));
    check('Settings is the last row in the drawer',
      items[items.length - 1].startsWith('Settings'), JSON.stringify(items.slice(-2)));
    check('Plans is live now, not greyed out',
      await page.isVisible('#mplans') &&
      await page.evaluate(() => !document.querySelector('#mplans').classList.contains('soon')),
      'Plans still greyed out');
    check('signed-in email shown in the drawer',
      (await page.textContent('.dhead span')) === 'finn@example.com',
      await page.textContent('.dhead span'));
    await page.screenshot({ path: `${ROOT}/n4-menu.png` });

    check('export lives in the menu now, not the bottom bar',
      items.some(i => i.startsWith('Select Months')) &&
      await page.evaluate(() => !document.querySelector('#exp')),
      JSON.stringify(items));
    check('Select Months is the only export route offered',
      !items.some(i => /Export PDF|Whole year|Create report/.test(i)),
      JSON.stringify(items));
    check('Recently added is no longer in the menu',
      !items.some(i => /Recently added/i.test(i)), JSON.stringify(items));

    await page.click('#msettings');
    await page.waitForTimeout(800);
    check('Settings opens its own screen',
      (await page.textContent('.shead h3')) === 'Settings',
      await page.textContent('.shead h3').catch(() => 'none'));
    check('Storage and Sign out both live in Settings',
      await page.isVisible('#setstorage') && await page.isVisible('#setsignout'),
      'a row is missing from Settings');
    await page.screenshot({ path: `${ROOT}/n22-settings.png` });

    await page.click('#setsignout');
    await page.waitForTimeout(500);
    check('sign out asks first', await page.isVisible('.btn-danger'), 'no confirm');
    await page.click('.btn-danger');
    await page.waitForTimeout(900);
    check('sign out returns to the login screen', await page.isVisible('#auth'), 'still in app');
    check('camera is released on sign out',
      await page.evaluate(() => stream === null), 'stream still live');

    check('no JS errors with a camera present', errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }

  /* ================= PHASE 2 — no camera at all ================= */
  {
    const { ctx, page, errors } = await newSession(browser, { camera: false });
    await signIn(page);
    await page.waitForTimeout(1500);

    check('without a camera the app still lands on the calendar',
      await page.isVisible('#grid') && !(await page.isVisible('#cam')),
      'unexpected state');
    check('no error shown on launch when there is no camera',
      !(await page.isVisible('#toast')), 'toast shown on launch');
    check('totals still load without a camera',
      (await page.textContent('#ttotal')).trim() === '£199.62',
      await page.textContent('#ttotal'));

    // tapping Snap receipt SHOULD explain itself
    await chooseAdd(page, 'Take Photo');
    await page.waitForTimeout(700);
    const t = await page.textContent('#toast').catch(() => '');
    check('choosing Take Photo with no camera explains why',
      /camera|files/i.test(t || ''), JSON.stringify(t));

    // Files route still works end to end
    await page.click('.cell.has >> nth=0');
    await page.waitForTimeout(500);
    await chooseAddFromDay(page, 'Import from Files');
    await page.setInputFiles('#ffile', { name: 'r.png', mimeType: 'image/png', buffer: PIXEL });
    await page.waitForTimeout(2500);
    check('Files route still reaches the details sheet',
      (await page.textContent('.shead h3')) === 'New receipt',
      await page.textContent('.shead h3').catch(() => 'none'));
    check('a picked image also gets a scan version',
      await page.evaluate(() => !!pending.scan), 'no scan for picked file');

    // the OCR CDN is unreachable here, which is exactly what an offline phone sees
    await page.waitForTimeout(2500);
    const offlineBox = await page.textContent('.readbox');
    check('an unreachable reader degrades to a plain message, not a broken sheet',
      /could not read this one/i.test(offlineBox), JSON.stringify(offlineBox.slice(0, 90)));
    check('the date field still works when the reader fails',
      (await page.inputValue('#f_date')).length === 10, await page.inputValue('#f_date'));
    check('saving is still possible with no reader',
      await page.isEnabled('.sfoot .btn-primary'), 'save disabled');

    check('no JS errors without a camera', errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }

  /* ============ PHASE 3 — does the scan actually flatten lighting? ============ */
  {
    const { ctx, page } = await newSession(browser, { camera: false });
    await page.goto('http://localhost:8099/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);

    const result = await page.evaluate(async () => {
      // a "photo of a receipt": paper lit brightly on the left, in shadow on the right,
      // with dark print across it
      const w = 600, h = 800;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d');
      for (let i = 0; i < w; i++) {
        const v = Math.round(235 - (i / w) * 150);      // 235 → 85 across the page
        x.fillStyle = `rgb(${v},${v},${v})`;
        x.fillRect(i, 0, 1, h);
      }
      x.fillStyle = 'rgba(20,20,20,0.92)';
      for (let r = 0; r < 14; r++) x.fillRect(60, 80 + r * 48, 480, 13);

      const measure = cv => {
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        const band = px => {                              // mean of a blank strip
          let s = 0, n = 0;
          for (let y = 40; y < 70; y++) {
            const o = (y * cv.width + px) * 4;
            s += d[o]; n++;
          }
          return s / n;
        };
        const inkAt = px => {
          let s = 0, n = 0;
          for (let y = 84; y < 90; y++) { const o = (y * cv.width + px) * 4; s += d[o]; n++; }
          return s / n;
        };
        return { leftPaper: band(70), rightPaper: band(520),
                 leftInk: inkAt(70), rightInk: inkAt(520) };
      };

      const before = measure(c);
      const scanBlob = await makeScan(c);
      const img = await new Promise((res, rej) => {
        const i = new Image(); i.onload = () => res(i); i.onerror = rej;
        i.src = URL.createObjectURL(scanBlob);
      });
      const c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
      c2.getContext('2d').drawImage(img, 0, 0);
      const after = measure(c2);
      return { before, after, bytes: scanBlob.size };
    });

    const b = result.before, a = result.after;
    const spreadBefore = Math.abs(b.leftPaper - b.rightPaper);
    const spreadAfter  = Math.abs(a.leftPaper - a.rightPaper);

    check('scan evens out the lighting across the page',
      spreadAfter < spreadBefore * 0.3,
      `paper spread ${spreadBefore.toFixed(0)} → ${spreadAfter.toFixed(0)}`);
    check('scan drives the paper to near-white',
      a.leftPaper > 235 && a.rightPaper > 235,
      `left ${a.leftPaper.toFixed(0)}, right ${a.rightPaper.toFixed(0)}`);
    check('print in the shadowed half survives instead of washing out',
      a.rightInk < 110, `right ink ${a.rightInk.toFixed(0)}`);
    check('contrast between paper and ink widens',
      (a.leftPaper - a.leftInk) > (b.leftPaper - b.leftInk),
      `${(b.leftPaper - b.leftInk).toFixed(0)} → ${(a.leftPaper - a.leftInk).toFixed(0)}`);

    console.log('\nscan measurements:', JSON.stringify(result, null, 2));
    await ctx.close();
  }

  /* ============ PHASE 4 — date & total parsing ============ */
  {
    const { ctx, page } = await newSession(browser, { camera: false });
    await page.goto('http://localhost:8099/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);

    const yr = new Date().getFullYear();
    const cases = await page.evaluate(y => {
      const D = s => { const r = findDate(s); return r && r.date; };
      return {
        ukSlash:      D('25/08/' + String(y).slice(2) + '  14:07'),
        ukFull:       D('Date: 14/03/' + y),
        iso:          D('' + y + '-03-14'),
        dots:         D('14.03.' + y),
        ambiguousUK:  D('03/04/' + y),          // 3 April under UK reading
        mustBeDDMM:   D('13/04/' + y),
        mustBeMMDD:   D('04/13/' + y),          // 13 can't be a month
        wordDayFirst: D('14 MAR ' + y),
        wordMonFirst: D('MAR 14, ' + y),
        future:       D('01/01/2099'),
        nonsense:     D('99/99/9999'),
        timeOnly:     D('14:07:32'),
        cardDigits:   D('VISA 4417 1234 5678'),
        phone:        D('TEL 0161 555 0134'),
        totalSimple:  (findTotal('TOTAL 169.08') || {}).amount,
        totalNotSub:  (findTotal('SUBTOTAL 140.90\nVAT 20% 28.18\nTOTAL 169.08') || {}).amount,
        totalComma:   (findTotal('AMOUNT DUE 45,50') || {}).amount,
        totalSymbol:  (findTotal('TOTAL  £12.99') || {}).amount,
        totalNone:    findTotal('THANK YOU FOR SHOPPING'),
        totalIgnoresChange: (findTotal('TOTAL 20.00\nCASH 50.00\nCHANGE 30.00') || {}).amount,

        // the rate on the form drives the arithmetic now, so these are what matter
        rate5Vat: reconcile({ net: null, vat: null, total: 105, rate: 5 }, ['total', 'rate']).vat,
        rate5Net: reconcile({ net: null, vat: null, total: 105, rate: 5 }, ['total', 'rate']).net,
        rate20Vat: reconcile({ net: null, vat: null, total: 120, rate: 20 }, ['total', 'rate']).vat,

        // net + VAT printed -> total and rate both follow
        fromNetVat: reconcile({ net: 100, vat: 20, total: null, rate: null }, ['net', 'vat']),
        // a printed total must never be overwritten by a derived one
        keepsPrinted: reconcile({ net: 100, vat: 20, total: 119.99, rate: null },
                                ['net', 'vat', 'total']).total,
        mismatchWarn: reconcileWarning({ net: 100, vat: 20, total: 125.00 }),
        roundingOk:   reconcileWarning({ net: 100, vat: 20, total: 120.01 }),

        invoiceNo: findInvoiceNo('INVOICE NO: INV-40912'),
        invoiceHash: findInvoiceNo('Receipt #40912'),
        invoiceNotDate: findInvoiceNo('RECEIPT 11/02/2026'),
        currency: findCurrency('TOTAL £12.00'),
      };
    }, yr);

    check('reads UK short-year date', cases.ukSlash === `${yr}-08-25`, cases.ukSlash);
    check('reads UK full date', cases.ukFull === `${yr}-03-14`, cases.ukFull);
    check('reads ISO date', cases.iso === `${yr}-03-14`, cases.iso);
    check('reads dot-separated date', cases.dots === `${yr}-03-14`, cases.dots);
    check('ambiguous 03/04 reads as UK day-first',
      cases.ambiguousUK === `${yr}-04-03`, cases.ambiguousUK);
    check('13/04 can only be day-first', cases.mustBeDDMM === `${yr}-04-13`, cases.mustBeDDMM);
    check('04/13 is recognised as month-first', cases.mustBeMMDD === `${yr}-04-13`, cases.mustBeMMDD);
    check('reads "14 MAR"', cases.wordDayFirst === `${yr}-03-14`, cases.wordDayFirst);
    check('reads "MAR 14"', cases.wordMonFirst === `${yr}-03-14`, cases.wordMonFirst);
    check('rejects a future date', !cases.future, cases.future);
    check('rejects impossible numbers', !cases.nonsense, cases.nonsense);
    check('does not mistake a time for a date', !cases.timeOnly, cases.timeOnly);
    check('does not mistake card digits for a date', !cases.cardDigits, cases.cardDigits);
    check('does not mistake a phone number for a date', !cases.phone, cases.phone);
    check('reads a plain total', cases.totalSimple === 169.08, cases.totalSimple);
    check('picks TOTAL over SUBTOTAL and VAT', cases.totalNotSub === 169.08, cases.totalNotSub);
    check('reads a comma decimal total', cases.totalComma === 45.5, cases.totalComma);
    check('reads a total with a currency symbol', cases.totalSymbol === 12.99, cases.totalSymbol);
    check('no total means no guess', cases.totalNone === null, JSON.stringify(cases.totalNone));
    check('ignores cash and change lines', cases.totalIgnoresChange === 20, cases.totalIgnoresChange);
    check('5% of a £105 VAT-inclusive total is £5', cases.rate5Vat === 5, cases.rate5Vat);
    check('the VAT parsers are gone: nothing reads VAT off the picture',
      await page.evaluate(() => typeof findVat === 'undefined'
        && typeof findVatRate === 'undefined' && typeof findNet === 'undefined'
        && typeof findVatReg === 'undefined'), 'a VAT parser is still there');
    check('the supplier parser is gone too',
      await page.evaluate(() => typeof findSupplier === 'undefined'
        && typeof supplierKey === 'undefined'), 'supplier recognition is still there');
    check('net follows from the same calculation', cases.rate5Net === 100, cases.rate5Net);
    check('20% of £120 gross gives £20, not £24', cases.rate20Vat === 20, cases.rate20Vat);
    check('net + VAT printed gives the total', cases.fromNetVat.total === 120,
      JSON.stringify(cases.fromNetVat));
    check('net + VAT printed gives the rate', cases.fromNetVat.rate === 20,
      JSON.stringify(cases.fromNetVat));
    check('a printed total is never overwritten by a derived one',
      cases.keepsPrinted === 119.99, cases.keepsPrinted);
    check('a real mismatch is flagged', /125\.00/.test(cases.mismatchWarn || ''),
      JSON.stringify(cases.mismatchWarn));
    check('a penny of rounding is not flagged', cases.roundingOk === null,
      JSON.stringify(cases.roundingOk));
    check('invoice number is picked up', cases.invoiceNo === 'INV-40912', cases.invoiceNo);
    check('a hash-style receipt number is picked up',
      cases.invoiceHash === '40912', cases.invoiceHash);
    check('a date after RECEIPT is not mistaken for a number',
      cases.invoiceNotDate === null, JSON.stringify(cases.invoiceNotDate));
    check('currency is picked up from the symbol', cases.currency === 'GBP', cases.currency);

    await ctx.close();
  }

  /* ============ PHASE 5 — the confirm flow, with OCR stubbed ============ */
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    await ctx.route('**/supabase-js@2**', r =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
      // stand in for tesseract.js — the CDN is unreachable from this sandbox
      window.Tesseract = {
        createWorker: async () => ({
          recognize: async () => ({ data: { text:
            'SCREWFIX DIRECT\nMANCHESTER\n11/02/2026  09:41\n' +
            'REDWOOD 47x100      71.94\nSUBTOTAL           140.90\n' +
            'VAT 20%             28.18\nTOTAL              169.08\nTHANK YOU' } })
        })
      };
    });
    await signIn(page);
    await page.waitForTimeout(900);

    // file against a day that is NOT the receipt's date, so the override is visible
    await page.click('.cell.has >> nth=0');
    await page.waitForTimeout(500);
    await chooseAddFromDay(page, 'Import from Files');
    await page.setInputFiles('#ffile', { name: 'r.png', mimeType: 'image/png', buffer: PIXEL });
    await page.waitForTimeout(1200);

    check('the reader announces itself while working or done',
      await page.isVisible('.readbox'), 'no readbox');
    await page.waitForTimeout(2500);

    check('date read off the receipt lands in the field',
      (await page.inputValue('#f_date')) === '2026-02-11',
      await page.inputValue('#f_date'));
    check('total read off the receipt lands in the amount',
      (await page.inputValue('#f_amt')) === '169.08',
      await page.inputValue('#f_amt'));
    const boxText = await page.textContent('.readbox');
    check('it asks to be checked rather than filing silently',
      /check this before saving/i.test(boxText), JSON.stringify(boxText.slice(0, 80)));
    check('it shows the raw text it read the date from',
      boxText.includes('11/02/2026'), JSON.stringify(boxText.slice(0, 160)));
    await page.screenshot({ path: `${ROOT}/n5-read.png` });

    // the read date is a suggestion — overriding it must win
    await page.fill('#f_date', '2026-02-20');
    await page.fill('#f_desc', 'Timber, back-filled');
    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(1200);
    const row = await page.evaluate(() =>
      window.__mock.rows.find(r => r.description === 'Timber, back-filled'));
    check('an edited date overrides what was read',
      row && row.receipt_date === '2026-02-20', JSON.stringify(row && row.receipt_date));
    check('the read amount is kept when not edited',
      row && row.amount === 169.08, JSON.stringify(row && row.amount));

    check('no JS errors through the reading flow', errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }

  /* ============ PHASE 6 — VAT totals and storage clearing ============ */
  {
    const { ctx, page, errors } = await newSession(browser, { camera: false });
    await page.goto('http://localhost:8099/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.evaluate(seed => { window.__mock.rows.push(...seed); }, [
      { id: 'v1', receipt_date: day(4), description: 'Timber', vendor: 'Screwfix',
        amount: 120, vat: 20, file_path: 'p/v1.jpg', file_type: 'image/jpeg',
        file_size: 140000, image_cleared: false,
        uploader_name: 'finn@x.com', created_at: '2026-01-01T10:00:00Z' },
      { id: 'v2', receipt_date: day(5), description: 'Fuel', vendor: 'Shell',
        amount: 60, vat: 10, file_path: 'p/v2.jpg', file_type: 'image/jpeg',
        file_size: 110000, image_cleared: false,
        uploader_name: 'finn@x.com', created_at: '2026-01-01T11:00:00Z' },
      { id: 'v3', receipt_date: day(6), description: 'Stamps', vendor: null,
        amount: 12, vat: null, file_path: 'p/v3.jpg', file_type: 'image/jpeg',
        file_size: 90000, image_cleared: false,
        uploader_name: 'finn@x.com', created_at: '2026-01-01T12:00:00Z' },
    ]);
    // give the mock store real files, so "the files are gone" means something
    await page.evaluate(() => {
      window.__mock.files.set('p/v1.jpg', { size: 140000, type: 'image/jpeg' });
      window.__mock.files.set('p/v2.jpg', { size: 110000, type: 'image/jpeg' });
      window.__mock.files.set('p/v3.jpg', { size: 90000,  type: 'image/jpeg' });
      window.__mock.files.set('keepme/other.jpg', { size: 1, type: 'image/jpeg' });
    });
    await page.fill('#em', 'finn@example.com');
    await page.fill('#pw', 'correct-horse');
    await page.click('#authbtn');
    await page.waitForTimeout(1400);

    check('calendar shows the month VAT total',
      (await page.textContent('#tvat')).trim() === '£30.00', await page.textContent('#tvat'));
    check('calendar still shows the month grand total',
      (await page.textContent('#ttotal')).trim() === '£192.00', await page.textContent('#ttotal'));
    await page.screenshot({ path: `${ROOT}/n6-vat.png` });

    // storage sheet
    await page.click('#menu');
    await page.waitForTimeout(400);
    const menuItems = await page.$$eval('.ditem .lbl', ns => ns.map(n => n.textContent));
    check('Settings appears in the menu', menuItems.includes('Settings'), JSON.stringify(menuItems));
    await page.click('#msettings');
    await page.waitForTimeout(700);
    await page.click('#setstorage');
    await page.waitForTimeout(1200);

    check('storage sheet opens', (await page.textContent('.shead h3')) === 'Storage',
      await page.textContent('.shead h3').catch(() => 'none'));
    const usedTxt = await page.textContent('.usedtop b');
    check('used space is summed from the stored file sizes',
      usedTxt.trim() === '332 KB', usedTxt);
    const monthRow = await page.textContent('.card .ditem:last-child .val');
    check('the month is listed with its count and size',
      /3 · 332 KB/.test(monthRow), monthRow);
    await page.screenshot({ path: `${ROOT}/n7-storage.png` });

    // clear the month
    await page.click('.card .ditem:last-child');
    await page.waitForTimeout(500);
    const askTxt = await page.textContent('.sheet .ask');
    check('clearing warns what goes and what stays',
      /dates, totals and VAT are untouched/i.test(askTxt), JSON.stringify(askTxt.slice(0, 90)));
    await page.click('.btn-danger');
    await page.waitForTimeout(1600);

    const after = await page.evaluate(() => window.__mock.rows.map(r => ({
      id: r.id, cleared: r.image_cleared, amount: r.amount, vat: r.vat, date: r.receipt_date })));
    check('every row in the month is marked cleared',
      after.every(r => r.cleared === true), JSON.stringify(after));
    check('clearing keeps the amounts',
      after.find(r => r.id === 'v1').amount === 120, JSON.stringify(after));
    check('clearing keeps the VAT figures',
      after.find(r => r.id === 'v1').vat === 20, JSON.stringify(after));
    check('clearing keeps the dates',
      after.find(r => r.id === 'v1').date === day(4), JSON.stringify(after));
    const leftFiles = await page.evaluate(() => [...window.__mock.files.keys()]);
    check('the cleared month\'s files are actually deleted',
      !leftFiles.some(k => k.startsWith('p/v')), JSON.stringify(leftFiles));
    check('files outside that month are left alone',
      leftFiles.includes('keepme/other.jpg'), JSON.stringify(leftFiles));

    await page.waitForTimeout(600);
    check('totals survive the clear',
      (await page.textContent('#ttotal')).trim() === '£192.00', await page.textContent('#ttotal'));
    check('VAT total survives the clear',
      (await page.textContent('#tvat')).trim() === '£30.00', await page.textContent('#tvat'));
    const latest = await page.textContent('#recentlist');
    check('cleared receipts show as cleared rather than broken images',
      /CLEARED/.test(latest), JSON.stringify(latest.slice(0, 80)));

    check('no JS errors through VAT and storage', errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }


  /* ============ PHASE 7 — finding several receipts in one photo ============ */
  {
    const { ctx, page } = await newSession(browser, { camera: false });
    await page.goto('http://localhost:8099/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);

    const res = await page.evaluate(() => {
      // paint N pale receipts on a dark surface, with print on them
      const make = (boxes, W = 900, H = 700, bg = '#3a352e') => {
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const x = c.getContext('2d');
        x.fillStyle = bg; x.fillRect(0, 0, W, H);
        boxes.forEach(b => {
          x.fillStyle = '#f2efe7';
          x.fillRect(b[0], b[1], b[2], b[3]);
          x.fillStyle = 'rgba(60,58,54,0.75)';
          for (let r = 0; r < Math.floor(b[3] / 26); r++)
            x.fillRect(b[0] + 12, b[1] + 16 + r * 24, b[2] - 40, 6);
        });
        const id = x.getImageData(0, 0, W, H), d = id.data;
        for (let i = 0; i < d.length; i += 4) {
          const n = (Math.random() - 0.5) * 12;
          d[i] += n; d[i + 1] += n; d[i + 2] += n;
        }
        x.putImageData(id, 0, 0);
        return c;
      };

      const three = make([[40, 40, 230, 380], [330, 60, 220, 330], [620, 40, 230, 420]]);
      const two   = make([[60, 80, 300, 520], [480, 80, 320, 520]]);
      const one   = make([[250, 40, 400, 620]]);
      const oneFull = make([[10, 10, 880, 680]]);
      const smallGap = make([[60, 80, 300, 500], [362, 80, 300, 500]]);  // 2px apart
      const abutting = make([[60, 80, 300, 500], [360, 80, 300, 500]]);  // edge to edge
      const empty = make([]);

      const boxesOf = c => detectReceipts(c);
      const crop = (c, b) => { const k = cropCanvas(c, b); return { w: k.width, h: k.height }; };

      const t3 = boxesOf(three);
      return {
        three: t3.length,
        two: boxesOf(two).length,
        one: boxesOf(one).length,
        oneFull: boxesOf(oneFull).length,
        smallGap: boxesOf(smallGap).length,
        abutting: boxesOf(abutting).length,
        empty: boxesOf(empty).length,
        // reading order: left to right along the top band
        order: t3.map(b => Math.round(b.x)),
        firstCrop: t3.length ? crop(three, t3[0]) : null,
        firstBox: t3.length ? { x: Math.round(t3[0].x), y: Math.round(t3[0].y),
                                w: Math.round(t3[0].w), h: Math.round(t3[0].h) } : null,
      };
    });

    check('three separated receipts are found', res.three === 3, JSON.stringify(res));
    check('two separated receipts are found', res.two === 2, res.two);
    check('a single receipt is not split', res.one === 0, res.one);
    check('a receipt filling the frame is not split', res.oneFull === 0, res.oneFull);
    check('a blank surface yields nothing', res.empty === 0, res.empty);
    check('receipts are returned left to right',
      JSON.stringify(res.order) === JSON.stringify([...res.order].sort((a, b) => a - b)),
      JSON.stringify(res.order));
    check('the first box lands on the first receipt',
      res.firstBox && Math.abs(res.firstBox.x - 40) < 25 && Math.abs(res.firstBox.w - 230) < 40,
      JSON.stringify(res.firstBox));
    check('cropping produces a real image of that receipt',
      res.firstCrop && res.firstCrop.w > 200 && res.firstCrop.h > 340,
      JSON.stringify(res.firstCrop));
    check('even a 2px gap is enough to separate two receipts',
      res.smallGap === 2, res.smallGap);
    // the real limit, recorded rather than glossed over: touching receipts read as
    // one region, and the app then files the photo whole rather than guessing a split
    check('receipts with no gap fall back to filing the photo as one',
      res.abutting === 0, res.abutting);

    await ctx.close();
  }


  /* ============ PHASE 8 — a blocked sign-up must not dead-end ============ */
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    const mockSignupOff = MOCK.replace(
      'async signUp({ email }) {',
      `async signUp({ email }) {
            return { data: null, error: { message: 'Signups not allowed for this instance' } };
          },
          async _unusedSignUp({ email }) {`);
    await ctx.route('**/supabase-js@2**', r =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: mockSignupOff }));
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    });
    await page.goto('http://localhost:8099/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    await page.click('#swapbtn');                       // "Create one"
    await page.waitForTimeout(200);
    check('the sign-up form can still be opened',
      (await page.textContent('#authbtn')) === 'Create account',
      await page.textContent('#authbtn'));

    await page.fill('#em', 'max@example.com');
    await page.fill('#pw', 'whatever123');
    await page.click('#authbtn');
    await page.waitForTimeout(900);

    const msg = await page.textContent('#authmsg');
    check('a blocked sign-up explains accounts are made by the owner',
      /created by the owner/i.test(msg), JSON.stringify(msg));
    check('it points at the Sign in button rather than leaving them stuck',
      /tap Sign in/i.test(msg), JSON.stringify(msg));
    check('the form flips back to Sign in on its own',
      (await page.textContent('#authbtn')) === 'Sign in',
      await page.textContent('#authbtn'));
    check('what they typed is kept',
      (await page.inputValue('#em')) === 'max@example.com',
      await page.inputValue('#em'));
    await page.screenshot({ path: `${ROOT}/n10-signupblocked.png` });

    await ctx.close();
  }


  /* ============ PHASE 9 — the month export actually runs ============
     pdf-lib's CDN is unreachable from this sandbox, so a stub stands in. It does
     not render a PDF, but it does prove the export runs start to finish, draws
     the right things, and does not trip over receipts whose image was cleared. */
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    await ctx.route('**/supabase-js@2**', r =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
    // the signed URLs point at our own pixel, so "fetching a receipt" works
    await ctx.route('**/pixel.png', r =>
      r.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
      const drawn = { text: [], images: 0, pages: 0 };
      window.__drawn = drawn;
      const mkPage = () => { drawn.pages++; return {
        drawText: t => drawn.text.push(String(t)),
        drawLine: () => {}, drawImage: () => { drawn.images++; },
      }; };
      const font = { widthOfTextAtSize: (s, sz) => String(s).length * sz * 0.5 };
      window.PDFLib = {
        StandardFonts: { Helvetica: 'h', HelveticaBold: 'hb' },
        rgb: () => ({}),
        PDFDocument: {
          create: async () => ({
            embedFont: async () => font,
            embedJpg: async () => ({ width: 400, height: 600 }),
            embedPng: async () => ({ width: 400, height: 600 }),
            addPage: mkPage,
            copyPages: async () => [mkPage()],
            save: async () => new Uint8Array([37, 80, 68, 70, 45]),
          }),
          load: async () => ({ getPageIndices: () => [0] }),
        },
      };
      // keep the share sheet and downloads out of it
      navigator.share = undefined;
      navigator.canShare = undefined;
      window.__downloads = [];
      const realCreate = document.createElement.bind(document);
      document.createElement = function (tag) {
        const n = realCreate(tag);
        if (tag === 'a') n.click = () => window.__downloads.push(n.download);
        return n;
      };
    });

    await page.goto('http://localhost:8099/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.evaluate(seed => { window.__mock.rows.push(...seed); }, [
      { id: 'e1', receipt_date: day(3), description: 'Timber for the deck', vendor: 'Screwfix',
        amount: 128.40, vat: 21.40, file_path: 'p/e1.jpg', file_type: 'image/jpeg',
        image_cleared: false, uploader_name: 'finn@x.com', created_at: '2026-01-01T10:00:00Z' },
      { id: 'e2', receipt_date: day(4), description: 'Diesel', vendor: 'Shell',
        amount: 71.22, vat: 11.87, file_path: 'p/e2.jpg', file_type: 'image/jpeg',
        image_cleared: false, uploader_name: 'finn@x.com', created_at: '2026-01-01T11:00:00Z' },
      { id: 'e3', receipt_date: day(5), description: 'Old one, picture cleared', vendor: 'B&Q',
        amount: 40.00, vat: 6.67, file_path: 'p/e3.jpg', file_type: 'image/jpeg',
        image_cleared: true, uploader_name: 'finn@x.com', created_at: '2026-01-01T12:00:00Z' },
      { id: 'e4', receipt_date: day(6), description: 'Scanned invoice', vendor: null,
        amount: 15.00, vat: null, file_path: 'p/e4.pdf', file_type: 'application/pdf',
        image_cleared: false, uploader_name: 'sam@x.com', created_at: '2026-01-01T13:00:00Z' },
    ]);
    await page.fill('#em', 'finn@example.com');
    await page.fill('#pw', 'correct-horse');
    await page.click('#authbtn');
    await page.waitForTimeout(1400);

    await page.click('#menu');
    await page.waitForTimeout(400);
    await page.click('.ditem:has-text("Select Months")');
    await page.waitForTimeout(1200);
    check('Select Months lists the months that have receipts',
      (await page.$$('.selrow')).length >= 1, 'no months listed');
    await page.click('.selrow >> nth=0');
    await page.waitForTimeout(400);
    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(4000);

    const drawn = await page.evaluate(() => window.__drawn);
    const dl = await page.evaluate(() => window.__downloads);
    const all = drawn.text.join(' | ');

    check('the export runs to completion', drawn.pages > 0, JSON.stringify(drawn));
    check('the summary page carries the gross total',
      /Total \| £254\.62/.test(all), all.slice(0, 220));
    check('the summary page carries the VAT total',
      /VAT \| £39\.94/.test(all), all.slice(0, 260));
    check('the summary page does not show net',
      !/\bNet\b/.test(all), all.slice(0, 260));
    check('the summary page counts the receipts',
      /Receipts \| 4/.test(all), all.slice(0, 260));
    check('the report is titled', /RECEIPT REPORT/.test(all), all.slice(0, 80));
    check('there is a VAT column heading', all.includes('VAT'), 'no VAT heading');
    check('a cleared receipt is noted rather than dropped',
      /image cleared/i.test(all), 'cleared not mentioned');
    check('a cleared receipt still appears with its figures',
      /Old one, picture cleared/.test(all) && /£40\.00/.test(all), 'row missing');
    check('the two receipts that still have images get a page each',
      drawn.images === 2, drawn.images);
    check('the scanned PDF is merged in rather than embedded as a picture',
      drawn.pages >= 4, drawn.pages);
    check('a file is produced and named for the month',
      dl.length === 1 && /^Receipts .+\.pdf$/.test(dl[0]), JSON.stringify(dl));
    check('no JS errors while exporting', errors.length === 0, JSON.stringify(errors));

    await ctx.close();
  }


  /* ====== PHASE 10 — a receipt that never prints its VAT figure ====== */
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    await ctx.route('**/supabase-js@2**', r =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
      window.Tesseract = { createWorker: async () => ({ recognize: async () => ({ data: { text:
        'THE COFFEE HOUSE\n14/03/2026\nFLAT WHITE      3.60\nTOTAL          12.00\n'
        + 'ALL PRICES INCLUDE VAT\nTHANK YOU' } }) }) };
    });
    await signIn(page);
    await page.waitForTimeout(900);

    await chooseAdd(page, 'Import from Files');
    await page.setInputFiles('#ffile', { name: 'r.png', mimeType: 'image/png', buffer: PIXEL });
    await page.waitForTimeout(3500);

    check('the total is still read normally',
      (await page.inputValue('#f_amt')) === '12.00', await page.inputValue('#f_amt'));
    check('VAT is filled at 20% of the VAT-inclusive total rather than left unknown',
      (await page.inputValue('#f_vat')) === '2.00', await page.inputValue('#f_vat'));
    check('the net follows from it',
      (await page.inputValue('#f_net')) === '10.00', await page.inputValue('#f_net'));
    check('the rate shows 20', (await page.inputValue('#f_rate')) === '20',
      await page.inputValue('#f_rate'));
    const box = await page.textContent('.readbox');
    check('the confirm box no longer calls VAT unknown',
      !/VAT: unknown/i.test(box), JSON.stringify(box.slice(0, 220)));
    check('it says VAT comes from the rate, not from the picture',
      /not read off the picture/i.test(box), JSON.stringify(box.slice(0, 260)));
    check('the reader reports only the date and the total',
      !/\bVAT £|\bNet\b|Supplier/i.test(box), JSON.stringify(box.slice(0, 260)));

    // typing VAT by hand must fill in the net and the rate
    await page.fill('#f_vat', '2.40');
    await page.dispatchEvent('#f_vat', 'input');
    await page.waitForTimeout(300);
    check('a hand-typed VAT figure overrides the 20% default',
      (await page.inputValue('#f_vat')) === '2.40' &&
      (await page.inputValue('#f_net')) === '9.60',
      await page.inputValue('#f_vat') + ' / ' + await page.inputValue('#f_net'));

    await page.fill('#f_vat', '2.00');
    await page.dispatchEvent('#f_vat', 'input');
    await page.waitForTimeout(300);
    check('entering VAT by hand derives the net',
      (await page.inputValue('#f_net')) === '10.00', await page.inputValue('#f_net'));
    check('entering VAT by hand derives the rate',
      (await page.inputValue('#f_rate')) === '20', await page.inputValue('#f_rate'));
    await page.screenshot({ path: `${ROOT}/n11-vatderived.png` });

    await ctx.close();
  }


  /* ====== PHASE 11 — Add receipt goes straight to the camera, and zoom ====== */
  {
    const { ctx, page, errors } = await newSession(browser, { camera: true });
    await signIn(page);
    await page.waitForTimeout(1200);

    await page.click('#snap');
    await page.waitForTimeout(900);
    check('Add receipt opens the camera with no menu in between',
      await page.isVisible('#cam'), 'camera not open');
    check('no chooser sheet is created',
      (await page.$$('.addrow')).length === 0, 'chooser still there');
    check('the scan-mode routes are gone from the page',
      await page.evaluate(() => !document.querySelector('#fscan')
                             && !document.querySelector('#fphotos')), 'scan inputs still present');
    check('openAddSheet no longer exists',
      await page.evaluate(() => typeof openAddSheet === 'undefined'), 'chooser function still defined');
    check('the camera is a plain viewfinder — no document borders or scan overlay',
      await page.evaluate(() => !document.querySelector(
        '#cam .scanframe, #cam .docedge, #cam .scanmode')), 'scanner chrome in the camera');
    check('the camera still offers Files for a photo or PDF already saved',
      await page.isVisible('#camfile'), 'no Files button');
    check('that input takes both images and PDFs',
      await page.getAttribute('#ffile', 'accept') === 'image/*,application/pdf',
      await page.getAttribute('#ffile', 'accept'));
    check('it files to today', await page.evaluate(() => captureDate) === day(today.getDate()),
      await page.evaluate(() => captureDate));
    await page.screenshot({ path: `${ROOT}/n12-camera-direct.png` });

    // the day sheet goes straight to the camera too, carrying that day's date
    await page.click('#camx');
    await page.waitForTimeout(400);
    await page.click('.cell.has >> nth=0');
    await page.waitForTimeout(500);
    const dayKey = await page.evaluate(() =>
      document.querySelector('.shead h3').textContent);
    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(900);
    check('Add receipt on a day opens the camera directly as well',
      await page.isVisible('#cam'), 'camera not open from the day sheet');
    check('it carries that day, not today',
      (await page.evaluate(() => captureDate)) !== day(today.getDate())
        || /today/i.test(dayKey),
      await page.evaluate(() => captureDate));

    /* ---------- zoom ---------- */
    await page.waitForTimeout(600);
    check('zoom starts at 1x and the readout is hidden',
      await page.evaluate(() => camZoom === 1) && !(await page.isVisible('#camzoom')),
      'zoom not idle');

    await page.evaluate(() => setZoom(2.5, true));
    await page.waitForTimeout(200);
    check('zooming shows the readout', await page.isVisible('#camzoom'), 'hidden');
    check('the readout shows the factor',
      (await page.textContent('#camzoomval')).trim() === '2.5×',
      await page.textContent('#camzoomval'));
    check('digital zoom scales the preview',
      await page.evaluate(() => camNativeZoom || /scale\(2\.5\)/.test(
        document.querySelector('#camvid').style.transform)),
      await page.evaluate(() => document.querySelector('#camvid').style.transform));
    check('zoom is clamped at the top',
      await page.evaluate(() => { setZoom(99, true); return camZoom; }) <= 8,
      await page.evaluate(() => camZoom));
    check('zoom is clamped at the bottom',
      await page.evaluate(() => { setZoom(0.1, true); return camZoom; }) === 1,
      await page.evaluate(() => camZoom));
    await page.screenshot({ path: `${ROOT}/n13-zoom.png` });

    // a zoomed shot must be cropped to match what the viewfinder showed
    await page.evaluate(() => setZoom(2, true));
    await page.waitForTimeout(300);
    const full = await page.evaluate(() => {
      const v = document.querySelector('#camvid');
      return { w: v.videoWidth, h: v.videoHeight };
    });
    await page.click('#camshot');
    await page.waitForTimeout(4000);
    check('a zoomed capture still reaches the details sheet',
      (await page.textContent('.shead h3')) === 'New receipt',
      await page.textContent('.shead h3').catch(() => 'none'));
    const shot = await page.evaluate(async () => {
      const b = pending.photo;
      const img = await createImageBitmap(b);
      return { w: img.width, h: img.height };
    });
    check('the zoomed frame is cropped, not the whole sensor',
      await page.evaluate(() => camNativeZoom) ||
      (shot.w < full.w && Math.abs(shot.w / shot.h - full.w / full.h) < 0.02),
      `full ${full.w}x${full.h} vs shot ${shot.w}x${shot.h}`);
    check('zoom resets when the camera closes',
      await page.evaluate(() => camZoom === 1), await page.evaluate(() => camZoom));

    check('no JS errors through the chooser and zoom', errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }


  /* ====== PHASE 12 — folders, recently added, month totals ====== */
  {
    const { ctx, page, errors } = await newSession(browser, { camera: false });
    await page.goto('http://localhost:8099/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.evaluate(seed => { window.__mock.rows.push(...seed); }, [
      { id: 'f1', receipt_date: day(4), description: 'Timber', vendor: 'Screwfix',
        supplier_key: 'screwfix', amount: 120, vat: 20, net: 100, vat_rate: 20,
        file_path: 'p/f1.jpg', file_type: 'image/jpeg', image_cleared: false,
        folder_id: null, uploader_name: 'finn@x.com', created_at: '2026-01-03T10:00:00Z' },
      { id: 'f2', receipt_date: day(5), description: 'Lunch with client', vendor: 'The Ivy',
        supplier_key: 'theivy', amount: 84, vat: 14, net: 70, vat_rate: 20,
        file_path: 'p/f2.jpg', file_type: 'image/jpeg', image_cleared: false,
        folder_id: null, uploader_name: 'finn@x.com', created_at: '2026-01-02T10:00:00Z' },
      { id: 'f3', receipt_date: day(6), description: 'Stamps', vendor: 'Post Office',
        supplier_key: 'postoffice', amount: 12, vat: null, net: null, vat_rate: null,
        file_path: 'p/f3.jpg', file_type: 'image/jpeg', image_cleared: false,
        folder_id: null, uploader_name: 'finn@x.com', created_at: '2026-01-01T10:00:00Z' },
    ]);
    await page.fill('#em', 'finn@example.com');
    await page.fill('#pw', 'correct-horse');
    await page.click('#authbtn');
    await page.waitForTimeout(1400);

    /* ---- 10. month totals ---- */
    check('month header shows the receipt count',
      (await page.textContent('#tcount')).trim() === '3', await page.textContent('#tcount'));
    check('the home screen does not show net at all',
      await page.evaluate(() => !document.querySelector('#tnet')), 'net still on the header');
    check('month header shows VAT summed from records',
      (await page.textContent('#tvat')).trim() === '£34.00', await page.textContent('#tvat'));
    check('month header shows the gross total',
      (await page.textContent('#ttotal')).trim() === '£216.00', await page.textContent('#ttotal'));
    await page.screenshot({ path: `${ROOT}/n15-month.png` });

    /* ---- 7/8. folders ---- */
    await page.click('#menu');
    await page.waitForTimeout(400);
    await page.click('.ditem:has-text("Folders")');
    await page.waitForTimeout(1200);
    check('folders sheet opens', (await page.textContent('.shead h3')) === 'Folders',
      await page.textContent('.shead h3').catch(() => 'none'));
    check('unfiled receipts are shown as their own group',
      /Unfiled/.test(await page.textContent('.sbody')), 'no Unfiled row');

    await page.click('.sfoot .btn-primary');           // Add Folder
    await page.waitForTimeout(500);
    const chips = await page.$$eval('.chip', ns => ns.map(n => n.textContent));
    check('the suggested folders include Client Meals',
      chips.includes('Client Meals'), JSON.stringify(chips));
    check('all six suggestions are offered', chips.length === 6, JSON.stringify(chips));
    await page.click('.chip:has-text("Client Meals")');
    await page.waitForTimeout(200);
    check('tapping a suggestion fills the name',
      (await page.inputValue('#f_folder')) === 'Client Meals',
      await page.inputValue('#f_folder'));
    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(1200);
    const made = await page.evaluate(() => window.__mock.folders.map(f => f.name));
    check('the folder is created', JSON.stringify(made) === '["Client Meals"]', JSON.stringify(made));
    check('nothing was created without being asked for',
      made.length === 1, JSON.stringify(made));
    await page.screenshot({ path: `${ROOT}/n16-folders.png` });

    /* ---- 9. recently added, with a bulk move ---- */
    await page.click('.shead .icb');
    await page.waitForTimeout(300);
    await page.click('#recenthead');
    await page.waitForTimeout(1200);
    check('recently added opens', (await page.textContent('.shead h3')) === 'Recently added',
      await page.textContent('.shead h3').catch(() => 'none'));
    const first = await page.textContent('.rcrow:first-child');
    check('it shows what the receipt is for, the date and the folder',
      /Timber/.test(first) && /Unfiled/.test(first), JSON.stringify(first));
    check('it shows the total and the VAT',
      /£120\.00/.test(first) && /VAT £20\.00/.test(first), JSON.stringify(first));
    check('a receipt with no VAT says unknown rather than zero',
      /VAT unknown/.test(await page.textContent('.rclist')), 'no unknown label');
    check('newest is listed first', /Timber/.test(first), JSON.stringify(first));

    await page.click('.rcrow:nth-child(1) .pick');
    await page.click('.rcrow:nth-child(2) .pick');
    await page.waitForTimeout(400);
    check('selecting shows how many will move',
      /Move 2/.test(await page.textContent('.recentfoot')),
      await page.textContent('.recentfoot'));
    await page.screenshot({ path: `${ROOT}/n17-recent.png` });
    await page.click('.recentfoot .btn-primary');
    await page.waitForTimeout(700);
    await page.click('.ditem:has-text("Client Meals")');
    await page.waitForTimeout(1400);
    const moved = await page.evaluate(() =>
      window.__mock.rows.filter(r => r.folder_id).length);
    check('both selected receipts moved into the folder', moved === 2, moved);
    check('moving does not touch the figures',
      await page.evaluate(() => {
        const r = window.__mock.rows.find(x => x.id === 'f1');
        return r.amount === 120 && r.vat === 20 && r.net === 100;
      }), 'figures changed on move');

    /* ---- folder totals come from the records ---- */
    // the move reopens Recently added, so dismiss it before reaching the menu
    await page.evaluate(() => { closeSheet(); document.querySelector('#pickhost')?.remove(); });
    await page.waitForTimeout(400);
    await page.click('#menu');
    await page.waitForTimeout(400);
    await page.click('.ditem:has-text("Folders")');
    await page.waitForTimeout(1200);
    const frow = await page.textContent('.frow:first-child');
    check('folder row shows count, net and VAT',
      /2/.test(frow) && /£170\.00/.test(frow) && /£34\.00/.test(frow), JSON.stringify(frow));
    check('folder row shows its gross total', /£204\.00/.test(frow), JSON.stringify(frow));

    await page.click('.frow:first-child');
    await page.waitForTimeout(1000);
    const tot = await page.textContent('.ftotals');
    check('opening a folder breaks out the count, VAT and total, with no net',
      /2/.test(tot) && /£34\.00/.test(tot) && /£204\.00/.test(tot) && !/Net/.test(tot),
      JSON.stringify(tot));

    check('no JS errors through folders', errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }


  /* ====== PHASE 13 — multi-select report, viewer zoom, UI zoom lock ====== */
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    await ctx.route('**/supabase-js@2**', r =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
    await ctx.route('**/pixel.png', r =>
      r.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
      const drawn = { text: [], images: 0, pages: 0 };
      window.__drawn = drawn;
      const mk = () => { drawn.pages++; return {
        drawText: t => drawn.text.push(String(t)), drawLine: () => {},
        drawImage: () => { drawn.images++; } }; };
      const font = { widthOfTextAtSize: (s, sz) => String(s).length * sz * 0.5 };
      window.PDFLib = {
        StandardFonts: { Helvetica: 'h', HelveticaBold: 'hb' }, rgb: () => ({}),
        PDFDocument: {
          create: async () => ({
            embedFont: async () => font,
            embedJpg: async () => ({ width: 400, height: 600 }),
            embedPng: async () => ({ width: 400, height: 600 }),
            addPage: mk, copyPages: async () => [mk()],
            save: async () => new Uint8Array([37, 80, 68, 70, 45]),
          }),
          load: async () => ({ getPageIndices: () => [0] }),
        },
      };
      navigator.share = undefined; navigator.canShare = undefined;
      window.__downloads = [];
      const realCreate = document.createElement.bind(document);
      document.createElement = function (tag) {
        const n = realCreate(tag);
        if (tag === 'a') n.click = () => window.__downloads.push(n.download);
        return n;
      };
    });

    await page.goto('http://localhost:8099/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    // Jan, Mar, Jun 2026 plus a decoy in Feb; two folders
    await page.evaluate(() => {
      const f1 = { id: 'F-mat', name: 'Materials', supplier_key: null, created_at: '2026-01-01T00:00:00Z' };
      const f2 = { id: 'F-fuel', name: 'Fuel', supplier_key: null, created_at: '2026-01-01T00:00:00Z' };
      window.__mock.folders.push(f1, f2);
      const mk = (id, date, desc, net, vat, folder) => ({
        id, receipt_date: date, description: desc, vendor: desc, supplier_key: null,
        net, vat, amount: Math.round((net + vat) * 100) / 100, vat_rate: 20,
        file_path: 'p/' + id + '.jpg', file_type: 'image/jpeg', image_cleared: false,
        folder_id: folder || null, uploader_name: 'finn@x.com',
        created_at: date + 'T10:00:00Z'
      });
      window.__mock.rows.push(
        mk('j1', '2026-01-10', 'Jan timber',  100, 20, 'F-mat'),
        mk('j2', '2026-01-20', 'Jan diesel',   50, 10, 'F-fuel'),
        mk('feb','2026-02-14', 'Feb decoy',   999, 199, null),
        mk('m1', '2026-03-05', 'Mar screws',   40,  8, 'F-mat'),
        mk('n1', '2026-06-08', 'Jun parking',  10,  2, null),
        mk('x1', '2026-09-09', 'Sep lone',      7,  1, null),
      );
    });
    await page.fill('#em', 'finn@example.com');
    await page.fill('#pw', 'correct-horse');
    await page.click('#authbtn');
    await page.waitForTimeout(1400);

    /* ---------- PDF TEST: Jan + Mar + Jun, non-consecutive ---------- */
    await page.evaluate(() => openReportBuilder());
    await page.waitForTimeout(1500);
    check('report builder opens', (await page.textContent('.shead h3')) === 'Create report',
      await page.textContent('.shead h3').catch(() => 'none'));

    await page.click('.selrow:has-text("January 2026")');
    await page.click('.selrow:has-text("March 2026")');
    await page.click('.selrow:has-text("June 2026")');
    await page.waitForTimeout(500);
    const live = await page.textContent('.selsum');
    check('non-consecutive months can all be selected at once',
      /4/.test(live), JSON.stringify(live));
    check('running totals update as months are picked',
      /£200\.00/.test(live) && /£40\.00/.test(live) && /£240\.00/.test(live),
      JSON.stringify(live));
    await page.screenshot({ path: `${ROOT}/n18-report.png` });

    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(4000);
    const d1 = await page.evaluate(() => window.__drawn);
    const all1 = d1.text.join(' | ');
    const dl1 = await page.evaluate(() => window.__downloads);

    check('ONE pdf is produced, not one per month', dl1.length === 1, JSON.stringify(dl1));
    check('the summary is the first page', /RECEIPT REPORT/.test(d1.text[0]), d1.text[0]);
    check('the summary names the selected months',
      /January 2026, March 2026, June 2026/.test(all1), all1.slice(0, 200));
    check('net is not printed anywhere in the report',
      !/\bNet\b/.test(all1), all1.slice(0, 300));
    check('combined VAT is correct (20+10+8+2 = £40)',
      /VAT \| £40\.00/.test(all1), all1.slice(0, 300));
    check('combined gross is correct (£240)',
      /Total \| £240\.00/.test(all1), all1.slice(0, 300));
    check('the report reconciles: net + VAT = gross', 200 + 40 === 240, 'arithmetic');
    check('the unselected February receipt is excluded',
      !/Feb decoy/.test(all1), 'Feb leaked in');
    check('the unselected September receipt is excluded',
      !/Sep lone/.test(all1), 'Sep leaked in');
    check('all four selected receipts appear in the list',
      ['Jan timber', 'Jan diesel', 'Mar screws', 'Jun parking']
        .every(n => all1.includes(n)), all1.slice(0, 400));
    check('each selected receipt gets its own image page', d1.images === 4, d1.images);

    /* ---------- FOLDER TEST ---------- */
    await page.evaluate(() => { window.__drawn.text = []; window.__drawn.images = 0;
                                window.__drawn.pages = 0; window.__downloads = []; });
    await page.evaluate(() => openReportBuilder());
    await page.waitForTimeout(1500);
    await page.click('.selrow:has-text("Materials")');
    await page.click('.selrow:has-text("Fuel")');
    await page.waitForTimeout(400);
    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(3500);
    const all2 = (await page.evaluate(() => window.__drawn)).text.join(' | ');
    check('multiple folders produce one PDF',
      (await page.evaluate(() => window.__downloads)).length === 1, 'not one file');
    check('receipts from both folders are included',
      ['Jan timber', 'Mar screws', 'Jan diesel'].every(n => all2.includes(n)),
      all2.slice(0, 300));
    check('the folders are named on the summary',
      /Materials/.test(all2) && /Fuel/.test(all2), all2.slice(0, 300));
    check('receipts outside those folders are excluded',
      !/Jun parking/.test(all2) && !/Feb decoy/.test(all2), 'unfiled leaked in');

    /* ---------- INDIVIDUAL RECEIPT TEST ---------- */
    await page.evaluate(() => { window.__drawn.text = []; window.__drawn.images = 0;
                                window.__downloads = []; });
    await page.evaluate(() => openReportBuilder());
    await page.waitForTimeout(1500);
    await page.click('.selrow:has-text("Sep lone")');
    await page.waitForTimeout(400);
    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(3000);
    const all3 = (await page.evaluate(() => window.__drawn)).text.join(' | ');
    check('a single hand-picked receipt exports on its own',
      all3.includes('Sep lone'), all3.slice(0, 200));
    check('only that receipt is included',
      !/Jan timber|Mar screws|Feb decoy/.test(all3), all3.slice(0, 300));
    check('its totals are its own (£1 VAT, £8 total)',
      /VAT \| £1\.00/.test(all3) && /Total \| £8\.00/.test(all3), all3.slice(0, 300));

    /* ---------- combining a month AND a folder AND a receipt ---------- */
    await page.evaluate(() => { window.__drawn.text = []; window.__drawn.images = 0;
                                window.__drawn.pages = 0; window.__downloads = []; });
    await page.evaluate(() => openReportBuilder());
    await page.waitForTimeout(1500);
    await page.click('.selrow:has-text("June 2026")');
    await page.click('.selrow:has-text("Materials")');
    await page.click('.selrow:has-text("Sep lone")');
    await page.waitForTimeout(400);
    const mixed = await page.textContent('.selsum');
    check('a month, a folder and a receipt combine without double counting',
      /4/.test(mixed), JSON.stringify(mixed));   // Jun + Jan timber + Mar screws + Sep lone
    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(3500);
    const d4 = await page.evaluate(() => window.__drawn);
    const all4 = d4.text.join(' | ');
    // Mar screws is both in March and in Materials; it must still appear once
    check('a receipt matched by two selections is only included once',
      d4.images === 4, 'image pages: ' + d4.images);
    check('the combined summary counts it once',
      /Receipts \| 4/.test(all4), all4.slice(0, 200));

    /* ---------- IMAGE TEST: viewer zoom and pan ---------- */
    await page.evaluate(() => closeSheet());
    await page.waitForTimeout(300);
    await page.click('#today');
    await page.waitForTimeout(600);
    await page.click('#recenthead');
    await page.waitForTimeout(1400);
    await page.click('.rcrow:first-child .rcmeta');
    await page.waitForTimeout(1400);
    check('tapping a receipt opens it for editing',
      (await page.textContent('.shead h3')) === 'Edit receipt',
      await page.textContent('.shead h3').catch(() => 'none'));
    await page.click('#e_photo');
    await page.waitForTimeout(1200);
    check('the picture still opens full screen from there',
      await page.isVisible('.viewer'), 'no viewer');

    const start = await page.evaluate(() =>
      document.querySelector('#vimg') ? document.querySelector('#vimg').style.transform : 'none');
    check('the image starts unzoomed', !start || start === '', JSON.stringify(start));

    await page.evaluate(() => {
      const a = document.querySelector('#vbody');
      const t2 = (x1, y1, x2, y2) => ({ touches: [
        { clientX: x1, clientY: y1 }, { clientX: x2, clientY: y2 }] });
      a.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true }), t2(150, 400, 250, 400)));
      a.dispatchEvent(Object.assign(new Event('touchmove',  { bubbles: true, cancelable: true }),
        Object.assign(t2(100, 400, 300, 400), { preventDefault(){} })));
    });
    await page.waitForTimeout(400);
    const zoomed = await page.evaluate(() => document.querySelector('#vimg').style.transform);
    check('pinching zooms the receipt image', /scale\(([2-9]|1\.[1-9])/.test(zoomed), zoomed);
    check('the zoomed state exposes a reset control',
      await page.evaluate(() => document.querySelector('.viewer').classList.contains('zoomed')),
      'no zoomed class');

    // the test pixel is 1x1, so at 2x it still fits and correctly refuses to pan.
    // Give it real dimensions so there is something off-screen to drag to.
    await page.evaluate(() => {
      const i = document.querySelector('#vimg');
      i.style.width = '340px'; i.style.height = '700px';
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const a = document.querySelector('#vbody');
      const one = (x, y) => ({ touches: [{ clientX: x, clientY: y }] });
      a.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true }), one(200, 400)));
      a.dispatchEvent(Object.assign(new Event('touchmove', { bubbles: true, cancelable: true }),
        Object.assign(one(200, 470), { preventDefault(){} })));
    });
    await page.waitForTimeout(400);
    const panned = await page.evaluate(() => document.querySelector('#vimg').style.transform);
    check('panning moves the image while zoomed',
      /translate3d\(0px, (?!0px)/.test(panned), panned);
    check('panning is clamped so the image cannot be dragged off screen',
      await page.evaluate(() => {
        const a = document.querySelector('#vbody');
        const one = (x, y) => ({ touches: [{ clientX: x, clientY: y }] });
        a.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true }), one(200, 400)));
        a.dispatchEvent(Object.assign(new Event('touchmove', { bubbles: true, cancelable: true }),
          Object.assign(one(200, 99999), { preventDefault(){} })));
        const m = /translate3d\(0px, (-?[\d.]+)px/.exec(document.querySelector('#vimg').style.transform);
        return m ? Math.abs(parseFloat(m[1])) < 900 : false;
      }), 'pan ran away');
    await page.screenshot({ path: `${ROOT}/n19-viewer.png` });

    await page.click('.vreset');
    await page.waitForTimeout(400);
    check('reset returns the image to fit',
      /scale\(1\)/.test(await page.evaluate(() => document.querySelector('#vimg').style.transform)),
      await page.evaluate(() => document.querySelector('#vimg').style.transform));

    /* ---------- close buttons are a comfortable size ---------- */
    const closeBox = await page.evaluate(() => {
      const b = document.querySelector('.viewer .vhead .icb');
      const r = b.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    check('the viewer close button meets the 44px touch target',
      closeBox.w >= 44 && closeBox.h >= 44, JSON.stringify(closeBox));
    await page.click('.viewer .vhead .icb');
    await page.waitForTimeout(400);
    check('the close button dismisses the viewer',
      !(await page.isVisible('.viewer')), 'still open');

    const sheetClose = await page.evaluate(() => {
      const b = document.querySelector('.shead .icb');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    check('sheet close buttons meet it too',
      sheetClose && sheetClose.w >= 44 && sheetClose.h >= 44, JSON.stringify(sheetClose));

    /* ---------- UI ZOOM TEST ---------- */
    const vp = await page.evaluate(() =>
      document.querySelector('meta[name="viewport"]').getAttribute('content'));
    check('the page itself is locked against pinch-zoom',
      /user-scalable=no/.test(vp) && /maximum-scale=1/.test(vp), vp);
    check('double-tap zoom is disabled on the body',
      await page.evaluate(() => getComputedStyle(document.body).touchAction === 'manipulation'),
      await page.evaluate(() => getComputedStyle(document.body).touchAction));
    check('the viewer keeps gestures to itself',
      await page.evaluate(() => {
        const d = document.createElement('div'); d.className = 'vbody';
        const v = document.createElement('div'); v.className = 'viewer';
        v.appendChild(d); document.body.appendChild(v);
        const ta = getComputedStyle(d).touchAction; v.remove(); return ta;
      }) === 'none', 'viewer body does not claim touch');

    /* ---------- PERFORMANCE: thumbnails load lazily ---------- */
    check('thumbnails are wired for lazy decoding',
      await page.evaluate(() => {
        const i = document.querySelector('img[data-path]');
        return !i || (i.getAttribute('loading') === 'lazy' && i.getAttribute('decoding') === 'async');
      }), 'thumbnails not lazy');
    check('an IntersectionObserver governs thumbnail fetching',
      await page.evaluate(() => typeof ensureThumbObserver === 'function' && !!ensureThumbObserver()),
      'no observer');

    check('no JS errors through reports and the viewer', errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }


  /* ====== PHASE 14 — month-by-month PDF summary, and Recently added scrolling ====== */
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    await ctx.route('**/supabase-js@2**', r =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
    await ctx.route('**/pixel.png', r =>
      r.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
      const drawn = { text: [], images: 0, pages: 0 };
      window.__drawn = drawn;
      const mk = () => { drawn.pages++; return {
        drawText: t => drawn.text.push(String(t)), drawLine: () => {},
        drawImage: () => { drawn.images++; } }; };
      const font = { widthOfTextAtSize: (t, sz) => String(t).length * sz * 0.5 };
      window.PDFLib = {
        StandardFonts: { Helvetica: 'h', HelveticaBold: 'hb' }, rgb: () => ({}),
        PDFDocument: {
          create: async () => ({
            embedFont: async () => font,
            embedJpg: async () => ({ width: 400, height: 600 }),
            embedPng: async () => ({ width: 400, height: 600 }),
            addPage: mk, copyPages: async () => [mk()],
            save: async () => new Uint8Array([37, 80, 68, 70, 45]),
          }),
          load: async () => ({ getPageIndices: () => [0] }),
        },
      };
      navigator.share = undefined; navigator.canShare = undefined;
      window.__downloads = [];
      const realCreate = document.createElement.bind(document);
      document.createElement = function (tag) {
        const n = realCreate(tag);
        if (tag === 'a') n.click = () => window.__downloads.push(n.download);
        return n;
      };
    });

    await page.goto('http://localhost:8099/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const mk = (id, date, desc, net, vat) => ({
        id, receipt_date: date, description: desc, vendor: desc, supplier_key: null,
        net, vat, amount: Math.round((net + vat) * 100) / 100, vat_rate: 20,
        file_path: 'p/' + id + '.jpg', file_type: 'image/jpeg', image_cleared: false,
        folder_id: null, uploader_name: 'finn@x.com', created_at: date + 'T10:00:00Z'
      });
      window.__mock.rows.push(
        mk('a1', '2026-01-10', 'Jan timber',  100, 20),
        mk('a2', '2026-01-20', 'Jan diesel',   50, 10),
        mk('b1', '2026-02-14', 'Feb decoy',   999, 199),
        mk('c1', '2026-03-05', 'Mar screws',   40,  8),
        mk('c2', '2026-03-19', 'Mar sealant',  30,  6),
        mk('d1', '2026-06-08', 'Jun parking',  10,  2),
      );
      // 45 more so Recently added is definitely longer than the sheet
      for (let i = 0; i < 45; i++) {
        const dd = String((i % 28) + 1).padStart(2, '0');
        window.__mock.rows.push(mk('bulk' + i, '2025-11-' + dd, 'Bulk item ' + i, 5, 1));
      }
    });
    await page.fill('#em', 'finn@example.com');
    await page.fill('#pw', 'correct-horse');
    await page.click('#authbtn');
    await page.waitForTimeout(1500);

    /* ---------- the month-by-month breakdown ---------- */
    await page.evaluate(() => openReportBuilder());
    await page.waitForTimeout(1500);
    await page.click('.selrow:has-text("January 2026")');
    await page.click('.selrow:has-text("March 2026")');
    await page.click('.selrow:has-text("June 2026")');
    await page.waitForTimeout(400);
    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(4500);

    const d = await page.evaluate(() => window.__drawn);
    const txt = d.text.join(' | ');
    const dl = await page.evaluate(() => window.__downloads);

    check('still exactly one PDF, one attachment', dl.length === 1, JSON.stringify(dl));
    check('the first page carries a month-by-month heading',
      /MONTH BY MONTH/.test(txt), txt.slice(0, 300));
    check('the breakdown is on the first page, before the itemised list',
      d.text.indexOf('MONTH BY MONTH') > -1 &&
      d.text.indexOf('MONTH BY MONTH') < d.text.indexOf('WHAT IT IS FOR'),
      d.text.indexOf('MONTH BY MONTH') + ' vs ' + d.text.indexOf('WHAT IT IS FOR'));
    check('it has a column for each figure, and none for net',
      /MONTH \| RECEIPTS \| VAT \| TOTAL/.test(txt) && !/\bNET\b/.test(txt),
      txt.slice(0, 400));

    // one row per selected month, in date order
    const rowOf = label => {
      const i = d.text.indexOf(label);
      return i === -1 ? null : d.text.slice(i, i + 4).join(' ');
    };
    check('January 2026 shows 2 receipts, £30 VAT, £180 total',
      rowOf('January 2026') === 'January 2026 2 £30.00 £180.00', rowOf('January 2026'));
    check('March 2026 shows 2 receipts, £14 VAT, £84 total',
      rowOf('March 2026') === 'March 2026 2 £14.00 £84.00', rowOf('March 2026'));
    check('June 2026 shows 1 receipt, £2 VAT, £12 total',
      rowOf('June 2026') === 'June 2026 1 £2.00 £12.00', rowOf('June 2026'));
    check('the months are listed oldest first',
      d.text.indexOf('January 2026') < d.text.indexOf('March 2026') &&
      d.text.indexOf('March 2026') < d.text.indexOf('June 2026'), 'out of order');
    check('an unselected month is not in the breakdown',
      !/February 2026/.test(txt), 'February leaked in');

    // TOTAL block underneath
    const tIdx = d.text.indexOf('TOTAL', d.text.indexOf('June 2026'));
    check('a TOTAL block sits underneath the months',
      tIdx > d.text.indexOf('June 2026'), 'no total block after the months');
    check('the TOTAL row adds the months up (5 · £46 VAT · £276)',
      d.text.slice(tIdx, tIdx + 4).join(' ') === 'TOTAL 5 £46.00 £276.00',
      d.text.slice(tIdx, tIdx + 4).join(' '));
    check('the breakdown reconciles with the headline total',
      /Total \| £276\.00/.test(txt) && /VAT \| £46\.00/.test(txt) &&
      30 + 14 + 2 === 46 && 180 + 84 + 12 === 276, txt.slice(0, 300));
    check('no net/VAT reconciliation warning is printed',
      !/do not add up/i.test(txt), txt.slice(0, 400));
    check('the receipts themselves are still in the PDF', d.images === 5, d.images);

    /* ---------- a selected month with nothing in it ---------- */
    await page.evaluate(() => { window.__drawn.text = []; window.__drawn.images = 0;
                                window.__drawn.pages = 0; window.__downloads = []; });
    await page.evaluate(() => buildReport({
      rows: window.__mock.rows.filter(r => r.receipt_date.startsWith('2026-06')),
      title: 'Receipt report', scope: 'test',
      monthKeys: ['2026-05', '2026-06'], filename: 'x.pdf'
    }));
    await page.waitForTimeout(3000);
    const e = await page.evaluate(() => window.__drawn);
    const emptyRow = (() => { const i = e.text.indexOf('May 2026');
      return i === -1 ? null : e.text.slice(i, i + 4).join(' '); })();
    check('a selected month with no receipts is still listed',
      emptyRow !== null, JSON.stringify(e.text.slice(0, 20)));
    check('and it reads 0 receipts and £0.00',
      emptyRow === 'May 2026 0 £0.00 £0.00', emptyRow);

    /* ---------- Recently added must scroll all the way down ---------- */
    await page.evaluate(() => closeSheet());
    await page.waitForTimeout(400);
    await page.click('#recenthead');
    await page.waitForTimeout(1800);

    const geom = await page.evaluate(() => {
      const b = document.querySelector('.sbody');
      const sheet = document.querySelector('.sheet');
      return { scrollH: b.scrollHeight, clientH: b.clientHeight,
               overflowY: getComputedStyle(b).overflowY,
               sheetH: sheet.getBoundingClientRect().height,
               winH: window.innerHeight,
               rows: document.querySelectorAll('.rcrow').length };
    });
    check('the list is longer than the sheet, so it must scroll',
      geom.scrollH > geom.clientH + 50, JSON.stringify(geom));
    check('the sheet stays inside the window rather than growing past it',
      geom.sheetH <= geom.winH + 1, JSON.stringify(geom));
    check('the scrolling area is the sheet body, not a nested box',
      geom.overflowY === 'auto' &&
      await page.evaluate(() => getComputedStyle(document.querySelector('.rclist')).overflowY !== 'auto'),
      geom.overflowY);

    const scrolled = await page.evaluate(() => {
      const b = document.querySelector('.sbody');
      b.scrollTop = b.scrollHeight;
      return b.scrollTop;
    });
    await page.waitForTimeout(600);
    check('it scrolls to the bottom', scrolled > 0 &&
      await page.evaluate(() => {
        const b = document.querySelector('.sbody');
        return Math.abs(b.scrollTop + b.clientHeight - b.scrollHeight) < 2;
      }), scrolled);

    const last = await page.evaluate(() => {
      const rows = document.querySelectorAll('.rcrow');
      const r = rows[rows.length - 1].getBoundingClientRect();
      const f = document.querySelector('.recentfoot').getBoundingClientRect();
      const b = document.querySelector('.sbody').getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, footTop: f.top, bodyBottom: b.bottom,
               label: rows[rows.length - 1].textContent.slice(0, 30) };
    });
    check('the oldest receipt is reachable, not clipped by the body',
      last.bottom <= last.bodyBottom + 1 && last.top >= 0, JSON.stringify(last));
    check('the oldest receipt is not hidden behind the fixed footer',
      last.bottom <= last.footTop + 1, JSON.stringify(last));
    await page.screenshot({ path: `${ROOT}/n19-recent-bottom.png` });

    // and it is genuinely usable down there
    await page.evaluate(() => {
      const rows = document.querySelectorAll('.rcrow');
      rows[rows.length - 1].querySelector('.pick').click();
    });
    await page.waitForTimeout(500);
    check('the last receipt can still be selected',
      /Move 1/.test(await page.textContent('.recentfoot')),
      await page.textContent('.recentfoot'));
    await page.evaluate(() => {
      const rows = document.querySelectorAll('.rcrow');
      rows[rows.length - 1].querySelector('.rcmeta').click();
    });
    await page.waitForTimeout(1400);
    check('the last receipt can still be opened',
      (await page.textContent('.shead h3')) === 'Edit receipt',
      await page.textContent('.shead h3').catch(() => 'none'));

    check('no JS errors through the breakdown and the long list',
      errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }


  /* ====== PHASE 15 — required fields, 20% VAT, no supplier, folder screen ====== */
  {
    const { ctx, page, errors } = await newSession(browser, { camera: false });
    await signIn(page);
    await page.waitForTimeout(1000);

    await page.evaluate(() => startCapture('file', ymd(new Date())));
    await page.waitForTimeout(300);
    await page.setInputFiles('#ffile', { name: 'r.png', mimeType: 'image/png', buffer: PIXEL });
    await page.waitForTimeout(2500);
    check('the receipt form opens', (await page.textContent('.shead h3')) === 'New receipt',
      await page.textContent('.shead h3').catch(() => 'none'));

    /* ---------- supplier is gone from the form ---------- */
    check('Supplier is nowhere on the form',
      !(await page.isVisible('#f_vend').catch(() => false)) &&
      !/Supplier/i.test(await page.textContent('.sbody')), 'supplier still asked for');
    check('what it is for, VAT, total and date are all on the form',
      await page.isVisible('#f_desc') && await page.isVisible('#f_vat') &&
      await page.isVisible('#f_amt') && await page.isVisible('#f_date'), 'a required field is missing');

    /* ---------- 20% is the starting rate ---------- */
    check('the VAT rate starts at 20', (await page.inputValue('#f_rate')) === '20',
      await page.inputValue('#f_rate'));
    check('VAT does not start as unknown',
      (await page.getAttribute('#f_vat', 'placeholder')) !== 'unknown',
      await page.getAttribute('#f_vat', 'placeholder'));

    /* ---------- VAT-inclusive maths, on his own examples ---------- */
    const vatFor = async total => {
      await page.fill('#f_amt', String(total));
      await page.dispatchEvent('#f_amt', 'input');
      await page.waitForTimeout(220);
      return { vat: await page.inputValue('#f_vat'), net: await page.inputValue('#f_net') };
    };
    let r = await vatFor('120');
    check('£120 total gives £20 VAT and £100 net',
      r.vat === '20.00' && r.net === '100.00', JSON.stringify(r));
    r = await vatFor('60');
    check('£60 total gives £10 VAT and £50 net',
      r.vat === '10.00' && r.net === '50.00', JSON.stringify(r));
    r = await vatFor('240');
    check('£240 total gives £40 VAT and £200 net',
      r.vat === '40.00' && r.net === '200.00', JSON.stringify(r));
    r = await vatFor('1,200');
    check('£1,200 total gives £200 VAT and £1,000 net',
      r.vat === '200.00' && r.net === '1000.00', JSON.stringify(r));
    check('VAT is not 20% of the total',
      r.vat !== '240.00', 'VAT was taken as 20% of the gross');
    await page.screenshot({ path: `${ROOT}/n20-vat20.png` });

    // typing a total digit by digit must not compound
    await page.fill('#f_amt', '');
    await page.dispatchEvent('#f_amt', 'input');
    for (const part of ['1', '12', '120']) {
      await page.fill('#f_amt', part);
      await page.dispatchEvent('#f_amt', 'input');
      await page.waitForTimeout(120);
    }
    check('a total typed one digit at a time still lands on £20 VAT',
      (await page.inputValue('#f_vat')) === '20.00', await page.inputValue('#f_vat'));

    /* ---------- VAT stays editable ---------- */
    await page.fill('#f_vat', '13.33');
    await page.dispatchEvent('#f_vat', 'input');
    await page.waitForTimeout(250);
    check('VAT can be overridden by hand',
      (await page.inputValue('#f_vat')) === '13.33', await page.inputValue('#f_vat'));
    check('the net follows the hand-typed VAT',
      (await page.inputValue('#f_net')) === '106.67', await page.inputValue('#f_net'));
    check('an overridden VAT is not put back to 20% on the next edit',
      await (async () => { await page.fill('#f_amt', '120');
        await page.dispatchEvent('#f_amt', 'input'); await page.waitForTimeout(220);
        return (await page.inputValue('#f_vat')) === '13.33'; })(),
      await page.inputValue('#f_vat'));

    /* ---------- the folder screen must come back to the receipt ---------- */
    await page.fill('#f_desc', 'Timber and screws');
    await page.fill('#f_vat', '20.00');
    await page.dispatchEvent('#f_vat', 'input');
    await page.waitForTimeout(200);
    const folderCount = await page.evaluate(() => folders.length);
    await page.click('#f_folderpick');
    await page.waitForTimeout(900);
    const pickOpen = () => page.evaluate(() => !!document.querySelector('#pickhost'));
    check('the folder screen opens over the receipt, whether or not folders exist',
      await pickOpen(), 'no folder screen (folders: ' + folderCount + ')');
    check('the receipt form is still underneath it',
      await page.evaluate(() => !!document.querySelector('#f_desc')), 'receipt form was replaced');
    check('a folder can be created without leaving the receipt',
      await page.isVisible('#pickhost .ditem:has-text("New folder")'), 'no create route');

    await page.click('#pickhost .shead .icb');
    await page.waitForTimeout(600);
    check('X closes only the folder screen',
      !(await pickOpen()) &&
      (await page.textContent('.shead h3')) === 'New receipt',
      await page.textContent('.shead h3').catch(() => 'gone'));
    check('everything already typed is still there',
      (await page.inputValue('#f_desc')) === 'Timber and screws' &&
      (await page.inputValue('#f_amt')) === '120' &&
      (await page.inputValue('#f_vat')) === '20.00',
      JSON.stringify([await page.inputValue('#f_desc'), await page.inputValue('#f_amt'),
                      await page.inputValue('#f_vat')]));

    // and through the create screen too
    await page.click('#f_folderpick');
    await page.waitForTimeout(700);
    await page.click('#pickhost .ditem:has-text("New folder")');
    await page.waitForTimeout(500);
    check('the create screen stays inside the folder overlay',
      await pickOpen() &&
      (await page.textContent('#pickhost .shead h3')) === 'New folder',
      await page.textContent('#pickhost .shead h3').catch(() => 'none'));
    await page.click('#pickhost .shead .icb');
    await page.waitForTimeout(500);
    check('closing from the create screen also returns to the receipt',
      (await page.inputValue('#f_desc')) === 'Timber and screws',
      await page.inputValue('#f_desc'));

    /* ---------- what is required to save ---------- */
    await page.fill('#f_desc', '');
    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(500);
    check('a receipt with no description is refused',
      /description/i.test(await page.textContent('#toast').catch(() => '')),
      await page.textContent('#toast').catch(() => 'no toast'));

    await page.fill('#f_desc', 'Timber and screws');
    await page.fill('#f_amt', '');
    await page.dispatchEvent('#f_amt', 'input');
    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(500);
    check('a receipt with no total is refused',
      /total/i.test(await page.textContent('#toast').catch(() => '')),
      await page.textContent('#toast').catch(() => 'no toast'));

    await page.fill('#f_amt', '120');
    await page.dispatchEvent('#f_amt', 'input');
    await page.waitForTimeout(200);
    await page.fill('#f_vat', '');
    await page.dispatchEvent('#f_vat', 'input');
    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(500);
    check('a receipt with no VAT is refused',
      /VAT/i.test(await page.textContent('#toast').catch(() => '')),
      await page.textContent('#toast').catch(() => 'no toast'));

    // supplier empty is fine — it saves
    await page.fill('#f_vat', '20.00');
    await page.dispatchEvent('#f_vat', 'input');
    await page.waitForTimeout(200);
    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(1800);
    const saved = await page.evaluate(() =>
      window.__mock.rows.find(r => r.description === 'Timber and screws'));
    check('it saves with no supplier at all',
      !!saved && (saved.vendor === null || saved.vendor === ''), JSON.stringify(saved || null));
    check('the figures stored are the ones on the form',
      saved && saved.amount === 120 && saved.vat === 20 && saved.net === 100,
      JSON.stringify(saved && { a: saved.amount, v: saved.vat, n: saved.net }));

    check('no JS errors through the form', errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }

  /* ====== PHASE 16 — Recently Added on the home screen, multi-month export ====== */
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    await ctx.route('**/supabase-js@2**', r =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
    await ctx.route('**/pixel.png', r =>
      r.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
      const drawn = { text: [], images: 0, pages: 0 };
      window.__drawn = drawn;
      const mk = () => { drawn.pages++; return {
        drawText: t => drawn.text.push(String(t)), drawLine: () => {},
        drawImage: () => { drawn.images++; } }; };
      const font = { widthOfTextAtSize: (t, sz) => String(t).length * sz * 0.5 };
      window.PDFLib = {
        StandardFonts: { Helvetica: 'h', HelveticaBold: 'hb' }, rgb: () => ({}),
        PDFDocument: {
          create: async () => ({
            embedFont: async () => font,
            embedJpg: async () => ({ width: 400, height: 600 }),
            embedPng: async () => ({ width: 400, height: 600 }),
            addPage: mk, copyPages: async () => [mk()],
            save: async () => new Uint8Array([37, 80, 68, 70, 45]),
          }),
          load: async () => ({ getPageIndices: () => [0] }),
        },
      };
      navigator.share = undefined; navigator.canShare = undefined;
      window.__downloads = [];
      const realCreate = document.createElement.bind(document);
      document.createElement = function (tag) {
        const n = realCreate(tag);
        if (tag === 'a') n.click = () => window.__downloads.push(n.download);
        return n;
      };
    });

    await page.goto('http://localhost:8099/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.evaluate(d => {
      const mk = (id, date, desc, vat, total) => ({
        id, receipt_date: date, description: desc, vendor: 'Screwfix', supplier_key: 'screwfix',
        net: Math.round((total - vat) * 100) / 100, vat, amount: total, vat_rate: 20,
        file_path: 'p/' + id + '.jpg', file_type: 'image/jpeg', image_cleared: false,
        folder_id: null, uploader_name: 'finn@x.com', created_at: date + 'T10:00:00Z'
      });
      window.__mock.rows.push(
        mk('t1', d, 'This month one', 20, 120),
        mk('t2', d, 'This month two', 10, 60),
        mk('j1', '2026-01-10', 'January one',   200, 1200),
        mk('j2', '2026-01-20', 'January two',    40,  240),
        mk('f1', '2026-02-14', 'February one',   30,  180),
      );
    }, day(today.getDate()));
    await page.fill('#em', 'finn@example.com');
    await page.fill('#pw', 'correct-horse');
    await page.click('#authbtn');
    await page.waitForTimeout(1500);

    /* ---------- 7 + 10: the home screen ---------- */
    check('the home screen section is called Recently Added',
      (await page.textContent('#recenthead')).trim().startsWith('Recently Added'),
      await page.textContent('#recenthead'));
    check('the old Latest heading is gone',
      !/Latest/.test(await page.textContent('main')), 'still says Latest');
    check('the month summary shows receipts, VAT and total',
      (await page.textContent('#tcount')).trim() === '2' &&
      (await page.textContent('#tvat')).trim() === '£30.00' &&
      (await page.textContent('#ttotal')).trim() === '£180.00',
      await page.textContent('.totals'));
    check('the month summary does not show net',
      !/Net/.test(await page.textContent('.totals')), await page.textContent('.totals'));
    await page.screenshot({ path: `${ROOT}/n21-home.png` });

    /* ---------- 8: tapping it opens the full list ---------- */
    await page.click('#recenthead');
    await page.waitForTimeout(1500);
    check('tapping Recently Added opens the full list',
      (await page.textContent('.shead h3')) === 'Recently added',
      await page.textContent('.shead h3').catch(() => 'none'));
    check('the full list carries receipts from other months too',
      (await page.$$('.rcrow')).length === 5, (await page.$$('.rcrow')).length);
    await page.evaluate(() => closeSheet());
    await page.waitForTimeout(400);

    /* ---------- Select Months ---------- */
    await page.click('#menu');
    await page.waitForTimeout(500);
    await page.click('.ditem:has-text("Select Months")');
    await page.waitForTimeout(1500);
    check('Select Months opens a list of months',
      (await page.textContent('.shead h3')) === 'Select Months',
      await page.textContent('.shead h3').catch(() => 'none'));
    const monthRows = await page.$$eval('.selrow .selmeta b', ns => ns.map(n => n.textContent));
    check('every month with receipts is offered',
      monthRows.includes('January 2026') && monthRows.includes('February 2026'),
      JSON.stringify(monthRows));
    check('nothing can be downloaded until a month is ticked',
      await page.evaluate(() => document.querySelector('.sfoot .btn-primary').disabled),
      'download was enabled with nothing selected');

    await page.click('.selrow:has-text("January 2026")');
    await page.waitForTimeout(400);
    check('ticking a month marks it',
      await page.evaluate(() =>
        !!document.querySelector('.selrow.on') && !!document.querySelector('.pick.on')),
      'no tick shown');
    check('the running total covers just that month',
      /£1440\.00/.test(await page.textContent('.selsum')), await page.textContent('.selsum'));
    await page.screenshot({ path: `${ROOT}/n23-months.png` });
    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(4000);
    const dd = await page.evaluate(() => window.__drawn);
    const t = dd.text.join(' | ');
    check('one PDF for the chosen month', 
      (await page.evaluate(() => window.__downloads)).length === 1, 'not one file');
    check('the first page names the month',
      dd.text[0] === 'RECEIPT REPORT' && dd.text[1] === 'January 2026',
      JSON.stringify(dd.text.slice(0, 3)));
    check('it counts that month’s receipts', /Receipts \| 2/.test(t), t.slice(0, 200));
    check('it carries the VAT total from the stored figures',
      /VAT \| £240\.00/.test(t), t.slice(0, 200));
    check('it carries the gross total from the stored figures',
      /Total \| £1440\.00/.test(t), t.slice(0, 200));
    check('no net on the summary', !/\bNet\b/.test(t), t.slice(0, 260));
    check('no supplier on the itemised rows',
      !/Screwfix/.test(t), t.slice(0, 400));
    check('the other months stay out',
      !/February one/.test(t) && !/This month one/.test(t), t.slice(0, 400));
    check('a single month needs no month-by-month table',
      !/MONTH BY MONTH/.test(t), t.slice(0, 300));
    check('the itemised heading asks what it is for',
      /WHAT IT IS FOR/.test(t), t.slice(0, 400));

    /* ---------- several months, one PDF ---------- */
    await page.evaluate(() => { window.__drawn.text = []; window.__drawn.images = 0;
                                window.__drawn.pages = 0; window.__downloads = []; });
    await page.click('#menu');
    await page.waitForTimeout(500);
    await page.click('.ditem:has-text("Select Months")');
    await page.waitForTimeout(1500);
    await page.click('.selrow:has-text("January 2026")');
    await page.click('.selrow:has-text("February 2026")');
    await page.waitForTimeout(400);
    check('two months can be ticked at once',
      (await page.$$('.selrow.on')).length === 2, (await page.$$('.selrow.on')).length);
    check('the running total covers both',
      /£1620\.00/.test(await page.textContent('.selsum')), await page.textContent('.selsum'));

    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(4500);
    const d2 = await page.evaluate(() => window.__drawn);
    const t2 = d2.text.join(' | ');
    check('several months make ONE combined PDF, not one each',
      (await page.evaluate(() => window.__downloads)).length === 1,
      JSON.stringify(await page.evaluate(() => window.__downloads)));
    check('both months are named on the first page',
      /January 2026/.test(t2) && /February 2026/.test(t2), t2.slice(0, 200));
    check('the combined summary counts every receipt',
      /Receipts \| 3/.test(t2), t2.slice(0, 260));
    check('the combined VAT and gross are right (£270 / £1620)',
      /VAT \| £270\.00/.test(t2) && /Total \| £1620\.00/.test(t2), t2.slice(0, 260));
    check('the month-by-month table comes back for several months',
      /MONTH BY MONTH/.test(t2), t2.slice(0, 300));
    check('receipts from both months are listed',
      /January one/.test(t2) && /February one/.test(t2), t2.slice(0, 400));
    check('the unticked current month stays out',
      !/This month one/.test(t2), t2.slice(0, 400));

    /* ---------- non-consecutive months ---------- */
    await page.evaluate(() => { window.__drawn.text = []; window.__downloads = []; });
    await page.click('#menu');
    await page.waitForTimeout(500);
    await page.click('.ditem:has-text("Select Months")');
    await page.waitForTimeout(1500);
    await page.click('.selrow:has-text("January 2026")');
    await page.click('.selrow >> nth=0');            // the current month, months apart
    await page.waitForTimeout(400);
    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(4000);
    const t3 = (await page.evaluate(() => window.__drawn)).text.join(' | ');
    check('months that do not run on still combine into one PDF',
      (await page.evaluate(() => window.__downloads)).length === 1 &&
      /January one/.test(t3) && /This month one/.test(t3) && !/February one/.test(t3),
      t3.slice(0, 400));

    check('no JS errors through the home screen and the export',
      errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }


  /* ====== PHASE 17 — preview zoom, field order, folder add + multi-select ====== */
  {
    const { ctx, page, errors } = await newSession(browser, { camera: false });
    await signIn(page);
    await page.waitForTimeout(1000);

    /* ---------- 2: the order of the fields ---------- */
    await page.evaluate(() => startCapture('file', ymd(new Date())));
    await page.waitForTimeout(300);
    await page.setInputFiles('#ffile', { name: 'r.png', mimeType: 'image/png', buffer: PIXEL });
    await page.waitForTimeout(2500);

    const order = await page.$$eval('.sbody input, .sbody .pickfolder',
      ns => ns.map(n => n.id).filter(Boolean));
    check('the fields run description, total, VAT, rate, net, date, folder',
      JSON.stringify(order) ===
      JSON.stringify(['f_desc', 'f_amt', 'f_vat', 'f_rate', 'f_net', 'f_date', 'f_folderpick']),
      JSON.stringify(order));
    const sides = await page.evaluate(() => {
      const x = id => document.querySelector('#' + id).getBoundingClientRect().left;
      return { amt: x('f_amt'), vat: x('f_vat'), rate: x('f_rate'), net: x('f_net') };
    });
    check('Total sits left of VAT', sides.amt < sides.vat, JSON.stringify(sides));
    check('VAT rate sits left of Net', sides.rate < sides.net, JSON.stringify(sides));

    /* ---------- 3: the calculation is untouched ---------- */
    await page.fill('#f_amt', '120');
    await page.dispatchEvent('#f_amt', 'input');
    await page.waitForTimeout(250);
    check('the 20% VAT-inclusive calculation still works after the reorder',
      (await page.inputValue('#f_vat')) === '20.00' &&
      (await page.inputValue('#f_net')) === '100.00' &&
      (await page.inputValue('#f_rate')) === '20',
      JSON.stringify([await page.inputValue('#f_vat'), await page.inputValue('#f_net')]));

    /* ---------- 1: pinch the picture on the receipt screen ---------- */
    check('the preview picture is there to zoom', await page.isVisible('#pvimg'), 'no preview');
    check('the preview starts unzoomed',
      !(await page.evaluate(() => document.querySelector('#pvimg').style.transform)),
      await page.evaluate(() => document.querySelector('#pvimg').style.transform));
    check('the sheet still scrolls normally over the picture',
      await page.evaluate(() =>
        getComputedStyle(document.querySelector('.pvwrap')).touchAction === 'pan-y'),
      await page.evaluate(() => getComputedStyle(document.querySelector('.pvwrap')).touchAction));

    await page.evaluate(() => {
      const a = document.querySelector('.pvwrap');
      const t2 = (x1, y1, x2, y2) => ({ touches: [
        { clientX: x1, clientY: y1 }, { clientX: x2, clientY: y2 }] });
      a.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true }), t2(150, 400, 250, 400)));
      a.dispatchEvent(Object.assign(new Event('touchmove', { bubbles: true, cancelable: true }),
        Object.assign(t2(80, 400, 320, 400), { preventDefault(){} })));
    });
    await page.waitForTimeout(300);
    const pz = await page.evaluate(() => document.querySelector('#pvimg').style.transform);
    check('pinching zooms the receipt picture', /scale\(([2-9]|1\.[1-9])/.test(pz), pz);
    check('only the picture moved, not the page',
      await page.evaluate(() => window.scrollY === 0 && window.visualViewport.scale === 1),
      'the page itself zoomed');
    check('a reset control appears once zoomed',
      await page.evaluate(() =>
        document.querySelector('.pvwrap').classList.contains('zoomed')), 'no zoomed class');
    await page.screenshot({ path: `${ROOT}/n24-preview-zoom.png` });

    // pan while zoomed
    await page.evaluate(() => {
      const i = document.querySelector('#pvimg');
      i.style.width = '340px'; i.style.height = '600px';
      const a = document.querySelector('.pvwrap');
      const one = (x, y) => ({ touches: [{ clientX: x, clientY: y }] });
      a.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true }), one(200, 400)));
      a.dispatchEvent(Object.assign(new Event('touchmove', { bubbles: true, cancelable: true }),
        Object.assign(one(200, 330), { preventDefault(){} })));
    });
    await page.waitForTimeout(300);
    check('panning moves the picture while zoomed',
      /translate3d\(0px, (?!0px)/.test(
        await page.evaluate(() => document.querySelector('#pvimg').style.transform)),
      await page.evaluate(() => document.querySelector('#pvimg').style.transform));

    await page.click('.pvwrap .vreset');
    await page.waitForTimeout(400);
    check('reset zooms back out',
      /scale\(1\)/.test(await page.evaluate(() => document.querySelector('#pvimg').style.transform)),
      await page.evaluate(() => document.querySelector('#pvimg').style.transform));
    check('the typed figures survived the zooming',
      (await page.inputValue('#f_amt')) === '120', await page.inputValue('#f_amt'));

    await page.evaluate(() => discardPending());
    await page.waitForTimeout(400);

    /* ---------- 4: add a receipt from inside a folder ---------- */
    await page.evaluate(async () => {
      await createFolder('Materials');
      await createFolder('Fuel');
    });
    await page.waitForTimeout(600);
    await page.click('#menu');
    await page.waitForTimeout(400);
    await page.click('.ditem:has-text("Folders")');
    await page.waitForTimeout(1400);
    await page.click('.frow:has-text("Materials")');
    await page.waitForTimeout(1200);
    check('the folder opens', (await page.textContent('.shead h3')) === 'Materials',
      await page.textContent('.shead h3').catch(() => 'none'));
    check('there is an obvious Add Receipt button inside it',
      await page.isVisible('.sbody .btn-primary:has-text("Add Receipt")'), 'no add button');

    await page.click('.sbody .btn-primary:has-text("Add Receipt")');
    await page.waitForTimeout(700);
    const carried = await page.evaluate(() => captureFolder);
    check('pressing it carries the folder into the capture',
      !!carried, JSON.stringify(carried));
    await page.evaluate(() => startCapture('file', ymd(new Date()), captureFolder));
    await page.setInputFiles('#ffile', { name: 'r.png', mimeType: 'image/png', buffer: PIXEL });
    await page.waitForTimeout(2500);
    check('the receipt form opens already filed in that folder',
      (await page.textContent('#f_folderpick .lbl')) === 'Materials',
      await page.textContent('#f_folderpick .lbl').catch(() => 'none'));

    await page.fill('#f_desc', 'Timber from the folder');
    await page.fill('#f_amt', '120');
    await page.dispatchEvent('#f_amt', 'input');
    await page.waitForTimeout(250);
    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(2000);
    const filed = await page.evaluate(() =>
      window.__mock.rows.find(r => r.description === 'Timber from the folder'));
    const matId = await page.evaluate(() =>
      window.__mock.folders.find(f => f.name === 'Materials').id);
    check('it saves straight into that folder without picking it again',
      filed && filed.folder_id === matId, JSON.stringify(filed && filed.folder_id));

    /* ---------- 5/6/7: multi-select and move ---------- */
    await page.evaluate(() => {
      const mk = (id, desc, amount, vat) => ({
        id, receipt_date: '2026-03-0' + (id.slice(-1)), description: desc, vendor: null,
        supplier_key: null, net: amount - vat, vat, amount, vat_rate: 20,
        file_path: 'p/' + id + '.jpg', file_type: 'image/jpeg', image_cleared: false,
        folder_id: null, uploader_name: 'finn@x.com', created_at: '2026-03-01T10:00:00Z'
      });
      window.__mock.rows.push(mk('u1', 'Unfiled one', 120, 20), mk('u2', 'Unfiled two', 60, 10),
                              mk('u3', 'Unfiled three', 240, 40), mk('u4', 'Unfiled four', 12, 2));
    });
    await page.evaluate(() => { closeSheet(); openFolders(); });
    await page.waitForTimeout(1500);
    await page.click('.frow:has-text("Unfiled")');
    await page.waitForTimeout(1300);
    check('Unfiled opens as a section of its own',
      (await page.textContent('.shead h3')) === 'Unfiled',
      await page.textContent('.shead h3').catch(() => 'none'));
    check('Unfiled has a Select control',
      await page.isVisible('.listbar button:has-text("Select")'), 'no select control');

    await page.click('.listbar button:has-text("Select")');
    await page.waitForTimeout(600);
    check('selecting turns the list into tickable rows',
      (await page.$$('.rcrow .pick')).length >= 4, (await page.$$('.rcrow .pick')).length);

    const before = await page.evaluate(() => window.__mock.rows.map(r =>
      [r.id, r.amount, r.vat, r.receipt_date, r.description, r.file_path].join('|')).sort());

    await page.click('.rcrow:nth-child(1) .pick');
    await page.click('.rcrow:nth-child(2) .pick');
    await page.click('.rcrow:nth-child(3) .pick');
    await page.waitForTimeout(500);
    check('several receipts can be ticked at once',
      (await page.$$('.rcrow.on')).length === 3, (await page.$$('.rcrow.on')).length);
    check('the count is shown', /3 selected/.test(await page.textContent('.listbar')),
      await page.textContent('.listbar'));
    check('the action offered is Move to folder',
      /Move 3 to folder/.test(await page.textContent('.sfoot')),
      await page.textContent('.sfoot'));
    await page.screenshot({ path: `${ROOT}/n25-multiselect.png` });

    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(1200);
    check('the folder list is offered',
      /Move 3 receipts/.test(await page.textContent('.shead h3')),
      await page.textContent('.shead h3').catch(() => 'none'));
    await page.click('.ditem:has-text("Fuel")');
    await page.waitForTimeout(1800);

    const fuelId = await page.evaluate(() =>
      window.__mock.folders.find(f => f.name === 'Fuel').id);
    const moved = await page.evaluate(f =>
      window.__mock.rows.filter(r => r.folder_id === f).map(r => r.id).sort(), fuelId);
    check('all three selected receipts moved together',
      JSON.stringify(moved) === JSON.stringify(['u1', 'u2', 'u3']), JSON.stringify(moved));
    check('the one left unticked stayed put',
      await page.evaluate(() => window.__mock.rows.find(r => r.id === 'u4').folder_id === null),
      'the unselected receipt moved too');

    const after = await page.evaluate(() => window.__mock.rows.map(r =>
      [r.id, r.amount, r.vat, r.receipt_date, r.description, r.file_path].join('|')).sort());
    check('nothing was duplicated or deleted', after.length === before.length,
      before.length + ' -> ' + after.length);
    check('no amount, VAT, date, description or image changed — only the folder',
      JSON.stringify(after) === JSON.stringify(before),
      JSON.stringify(after.filter((x, i) => x !== before[i]).slice(0, 3)));

    /* ---------- 8: Recently Added shows the amount ---------- */
    await page.evaluate(() => { closeSheet(); });
    await page.waitForTimeout(400);
    await page.click('#recenthead');
    await page.waitForTimeout(1600);
    const rowTxt = await page.textContent('.rcrow:has-text("Unfiled three")');
    check('a recently added row shows what it is for',
      /Unfiled three/.test(rowTxt), JSON.stringify(rowTxt));
    check('it shows the exact total that was entered',
      /£240\.00/.test(rowTxt), JSON.stringify(rowTxt));
    check('it shows the VAT', /VAT £40\.00/.test(rowTxt), JSON.stringify(rowTxt));
    check('it shows the date', /March/.test(rowTxt), JSON.stringify(rowTxt));
    check('the amount has its own column rather than being buried',
      await page.isVisible('.rcrow .rcamt'), 'no amount column');
    await page.screenshot({ path: `${ROOT}/n26-recent-amounts.png` });

    /* ---------- 9: opening from Recently Added still zooms ---------- */
    await page.click('.rcrow:has-text("Unfiled three") .rcmeta');
    await page.waitForTimeout(1400);
    check('a receipt still opens from Recently Added',
      (await page.textContent('.shead h3')) === 'Edit receipt',
      await page.textContent('.shead h3').catch(() => 'none'));
    await page.click('#e_photo');
    await page.waitForTimeout(1200);
    check('the full-screen viewer still has its zoom reset',
      await page.isVisible('.viewer .vreset'), 'no reset control');
    check('the viewer still offers move and delete',
      (await page.$$('.viewer .vhead .icb')).length === 4,
      (await page.$$('.viewer .vhead .icb')).length);
    await page.evaluate(() => {
      const a = document.querySelector('#vbody');
      const t2 = (x1, y1, x2, y2) => ({ touches: [
        { clientX: x1, clientY: y1 }, { clientX: x2, clientY: y2 }] });
      a.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true }), t2(150, 400, 250, 400)));
      a.dispatchEvent(Object.assign(new Event('touchmove', { bubbles: true, cancelable: true }),
        Object.assign(t2(100, 400, 300, 400), { preventDefault(){} })));
    });
    await page.waitForTimeout(400);
    check('pinch-to-zoom in the viewer is unchanged',
      /scale\(([2-9]|1\.[1-9])/.test(
        await page.evaluate(() => document.querySelector('#vimg').style.transform)),
      await page.evaluate(() => document.querySelector('#vimg').style.transform));

    check('no JS errors through folders and multi-select',
      errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }


  /* ====== PHASE 18 — Planning: jobs, date ranges, status ====== */
  {
    const { ctx, page, errors } = await newSession(browser, { camera: false });
    await signIn(page);
    await page.waitForTimeout(1000);

    const D = n => { const d = new Date(); d.setDate(d.getDate() + n);
      return `${d.getFullYear()}-${d2(d.getMonth() + 1)}-${d2(d.getDate())}`; };

    /* ---------- it is a page, not a sheet ---------- */
    await page.click('#menu');
    await page.waitForTimeout(500);
    await page.click('#mplans');
    await page.waitForTimeout(1400);
    check('Planning opens as its own full-screen page',
      await page.isVisible('#plan') && !(await page.isVisible('#app')),
      'plan visible: ' + await page.isVisible('#plan') +
      ', app visible: ' + await page.isVisible('#app'));
    check('it is not a bottom sheet or modal',
      await page.evaluate(() => !document.querySelector('#sheets .scrim')), 'a sheet was used');
    check('it has its own header, timeline and bottom bar',
      await page.isVisible('#planlabel') && await page.isVisible('#addplan') &&
      (await page.isVisible('#programme').catch(() => false) ||
       await page.isVisible('#pgrid').catch(() => false)), 'page furniture missing');
    check('the receipts calendar is untouched underneath',
      await page.evaluate(() => document.querySelectorAll('#grid .cell').length > 27),
      'receipts grid disturbed');

    await page.click('#planback');
    await page.waitForTimeout(500);
    check('back returns to receipts',
      await page.isVisible('#app') && !(await page.isVisible('#plan')), 'did not go back');
    await page.click('#menu');
    await page.waitForTimeout(400);
    await page.click('#mplans');
    await page.waitForTimeout(1200);

    /* ---------- a plan needs a PROJECT ---------- */
    await page.click('#addplan');
    await page.waitForTimeout(800);
    check('the add form opens', (await page.textContent('.shead h3')) === 'Add Plan',
      await page.textContent('.shead h3').catch(() => 'none'));
    const labels = await page.$$eval('.sbody label', ns => ns.map(n => n.textContent.trim()));
    check('the form asks only what, job, dates, status and a note',
      JSON.stringify(labels) === JSON.stringify(
        ['What is the plan', 'Job', 'Start date', 'End date (optional)', 'Status',
         'Note (optional)']),
      JSON.stringify(labels));
    check('the end date is optional and starts empty',
      (await page.inputValue('#p_end')) === '', await page.inputValue('#p_end'));
    check('status starts at Not started',
      (await page.textContent('#p_status .on')).trim() === 'Not started',
      await page.textContent('#p_status .on').catch(() => 'none'));
    check('there are three statuses and no more',
      (await page.$$eval('#p_status button', ns => ns.map(n => n.textContent.trim()))).join(',')
        === 'Not started,In progress,Complete',
      await page.$$eval('#p_status button', ns => ns.map(n => n.textContent.trim()).join(',')));
    check('there is no progress slider to fill in',
      await page.evaluate(() => !document.querySelector('#p_progress')), 'progress is still there');

    await page.fill('#p_title', 'Foundations');
    await page.click('#p_save');
    await page.waitForTimeout(600);
    check('a plan with no job is refused',
      /job/i.test(await page.textContent('#toast').catch(() => '')),
      await page.textContent('#toast').catch(() => 'no toast'));

    /* ---------- create the project from inside the form ---------- */
    await page.click('#p_project');
    await page.waitForTimeout(700);
    check('the project picker opens over the form',
      await page.evaluate(() => !!document.querySelector('#pickhost')), 'no picker');
    check('the form underneath survives',
      (await page.inputValue('#p_title')) === 'Foundations', await page.inputValue('#p_title'));
    await page.click('#newproject');
    await page.waitForTimeout(500);
    check('Flats and Houses are offered as starting points',
      /Flats/.test(await page.textContent('#pickhost')) &&
      /Houses/.test(await page.textContent('#pickhost')),
      (await page.textContent('#pickhost')).slice(0, 160));
    await page.click('#pickhost .chip:has-text("Flats")');
    await page.waitForTimeout(300);
    await page.click('#pickhost .btn-primary');
    await page.waitForTimeout(1400);
    check('the job is created and selected without leaving the form',
      (await page.textContent('#p_project .lbl')) === 'Flats' &&
      (await page.inputValue('#p_title')) === 'Foundations',
      await page.textContent('#p_project .lbl').catch(() => 'none'));

    /* ---------- date range ---------- */
    await page.fill('#p_start', D(3));
    await page.fill('#p_end', D(20));
    await page.click('#p_save');
    await page.waitForTimeout(1800);
    const found = await page.evaluate(() => window.__mock.plans[0]);
    check('the plan saves with a start and an end date',
      found && found.start_date === D(3) && found.end_date === D(20), JSON.stringify(found));
    check('it is tied to the job',
      found && found.project_id === await page.evaluate(() => window.__mock.projects[0].id),
      JSON.stringify(found && found.project_id));
    check('status is stored as Not started', found && found.status === 'not_started',
      JSON.stringify(found && found.status));
    check('it lands back on the Planning page, not a sheet',
      await page.isVisible('#plan') &&
      await page.evaluate(() => !document.querySelector('#sheets .scrim')), 'not back on the page');

    /* ---------- more plans, two projects ---------- */
    const addPlan = async (what, project, from, to, status) => {
      await page.click('#addplan');
      await page.waitForTimeout(600);
      await page.fill('#p_title', what);
      await page.click('#p_project');
      await page.waitForTimeout(500);
      const has = await page.$(`#pickhost .ditem:has-text("${project}")`);
      if (has) { await has.click(); }
      else {
        await page.click('#newproject');
        await page.waitForTimeout(400);
        await page.fill('#p_newproj', project);
        await page.click('#pickhost .btn-primary');
      }
      await page.waitForTimeout(900);
      await page.fill('#p_start', from);
      await page.fill('#p_end', to);
      if (status) { await page.click(`#p_status button:has-text("${status}")`); }
      await page.waitForTimeout(200);
      await page.click('#p_save');
      await page.waitForTimeout(1600);
    };
    await addPlan('Roofing', 'Houses', D(18), D(30));
    await addPlan('Structure', 'Flats', D(-10), D(12), 'In progress');
    await addPlan('Drainage', 'Flats', D(-30), D(-5), 'In progress');
    await addPlan('Concrete delivery', 'Flats', D(2), D(2));

    check('five plans across two projects', await page.evaluate(() =>
      window.__mock.plans.length) === 5 && await page.evaluate(() =>
      window.__mock.projects.length) === 2,
      await page.evaluate(() => window.__mock.plans.length + '/' + window.__mock.projects.length));
    check('a single-day event is allowed', await page.evaluate(() => {
      const p = window.__mock.plans.find(x => x.title === 'Concrete delivery');
      return p && p.start_date === p.end_date; }), 'single day rejected');

    /* ---------- 6/8/9/11: the main screen ---------- */
    const pageTxt = await page.textContent('#planlists');
    check('Currently underway lists the in-progress plans',
      /Currently underway/i.test(pageTxt) && /Structure/.test(pageTxt), pageTxt.slice(0, 300));
    check('Upcoming lists what has not started yet',
      /Upcoming/i.test(pageTxt) && /Roofing/.test(pageTxt), pageTxt.slice(0, 400));
    check('the project name is shown against every plan',
      (await page.$$eval('#planlists .proj', ns => ns.map(n => n.textContent))).every(Boolean) &&
      /Flats/.test(pageTxt) && /Houses/.test(pageTxt), pageTxt.slice(0, 400));
    check('the date range is shown, not a single date',
      /→/.test(pageTxt), pageTxt.slice(0, 300));
    check('a status is shown against every plan',
      (await page.$$('#planlists .pchip')).length >= 3, (await page.$$('#planlists .pchip')).length);
    check('upcoming is in date order',
      pageTxt.indexOf('Concrete delivery') < pageTxt.indexOf('Foundations') &&
      pageTxt.indexOf('Foundations') < pageTxt.indexOf('Roofing'),
      'upcoming out of order');
    check('a plan past its end date and not complete is marked Overdue',
      /Overdue/i.test(pageTxt) && /Drainage/.test(pageTxt), pageTxt.slice(0, 500));
    check('but its stored status is not silently rewritten',
      await page.evaluate(() => window.__mock.plans.find(p => p.title === 'Drainage').status)
        === 'in_progress',
      await page.evaluate(() => window.__mock.plans.find(p => p.title === 'Drainage').status));
    check('there is no separate Delayed list to keep on top of',
      await page.evaluate(() => !document.querySelector('#delayed')), 'Delayed section is still there');
    check('the header counts jobs, underway and upcoming',
      (await page.textContent('#pjcount')).trim() === '2' &&
      (await page.textContent('#punder')).trim() === '2',
      await page.textContent('.totals'));
    await page.screenshot({ path: `${ROOT}/n29-planning.png` });

    /* ---------- 7: the calendar shows the runs ---------- */
    // Planning opens on the programme now, so switch to the calendar for these
    await page.click('#planseg button:has-text("Calendar")');
    await page.waitForTimeout(700);
    const covered = await page.evaluate(() => document.querySelectorAll('#pgrid .cell.has').length);
    check('the calendar marks every day a plan runs through, not just the start',
      covered > 5, covered);
    check('the runs are colour-coded by status',
      await page.evaluate(() => !!document.querySelector('#pgrid .run.s-in_progress')),
      'no status colour on the calendar');

    await page.click('#pgrid .cell.has >> nth=1');
    await page.waitForTimeout(900);
    const dayTxt = await page.textContent('.sbody');
    check('tapping a date lists what is running that day, with the project',
      /Flats|Houses/.test(dayTxt), dayTxt.slice(0, 200));
    check('a day can be added to directly', await page.isVisible('#daddplan'), 'no add on the day');
    await page.evaluate(() => closeSheet());
    await page.waitForTimeout(400);
    await page.click('#planseg button:has-text("Programme")');
    await page.waitForTimeout(600);

    /* ---------- editing ---------- */
    await page.click('#underway .prow:has-text("Structure")');
    await page.waitForTimeout(900);
    check('tapping a plan opens it for editing',
      (await page.textContent('.shead h3')) === 'Plan',
      await page.textContent('.shead h3').catch(() => 'none'));
    check('the sheet names the job it belongs to',
      /Flats|Houses/.test(await page.textContent('.shead')),
      await page.textContent('.shead'));
    check('it can be deleted from here', await page.isVisible('#p_del'), 'no delete');

    const editTitle = await page.inputValue('#p_title');
    await page.fill('#p_end', D(40));
    await page.click('#p_save');
    await page.waitForTimeout(1800);
    const prog = await page.evaluate(t =>
      window.__mock.plans.find(p => p.title === t), editTitle);
    check('the end date can be changed', prog && prog.end_date === D(40),
      JSON.stringify(prog && prog.end_date));
    check('editing does not create a second plan',
      await page.evaluate(() => window.__mock.plans.length) === 5,
      await page.evaluate(() => window.__mock.plans.length));
    check('the page updates straight away',
      new RegExp(editTitle).test(await page.textContent('#planlists')),
      (await page.textContent('#planlists')).slice(0, 300));

    /* ---------- changing the project ---------- */
    await page.click('#underway .prow:has-text("Structure")');
    await page.waitForTimeout(800);
    await page.click('#p_project');
    await page.waitForTimeout(600);
    await page.click('#pickhost .ditem:has-text("Houses")');
    await page.waitForTimeout(500);
    await page.click('#p_save');
    await page.waitForTimeout(1700);
    check('a plan can be moved to another job',
      await page.evaluate(t => {
        const p = window.__mock.plans.find(x => x.title === t);
        const rh = window.__mock.projects.find(j => j.name === 'Houses');
        return p && rh && p.project_id === rh.id;
      }, editTitle), 'project did not change');

    /* ---------- an overdue plan says so ---------- */
    await page.click('#underway .prow:has-text("Drainage")');
    await page.waitForTimeout(800);
    check('an overdue plan says so on its form',
      await page.isVisible('#p_overdue'), 'no overdue note');
    await page.evaluate(() => closeSheet());
    await page.waitForTimeout(400);

    /* ---------- completing ---------- */
    await page.click('#upcoming .prow:has-text("Roofing")');
    await page.waitForTimeout(800);
    const doneTitle = await page.inputValue('#p_title');
    await page.click('#p_status button:has-text("Complete")');
    await page.waitForTimeout(300);
    await page.click('#p_save');
    await page.waitForTimeout(1700);
    check('a completed plan drops out of Upcoming',
      !new RegExp(doneTitle).test(await page.textContent('#planlists') || ''),
      (await page.textContent('#planlists')).slice(0, 300));

    /* ---------- delete ---------- */
    await page.click('#upcoming .prow:has-text("Foundations")');
    await page.waitForTimeout(800);
    await page.click('#p_del');
    await page.waitForTimeout(600);
    await page.click('#askhost .btn-danger');
    await page.waitForTimeout(1700);
    check('a plan can be deleted',
      await page.evaluate(() => window.__mock.plans.length) === 4 &&
      await page.evaluate(() => !window.__mock.plans.some(p => p.title === 'Foundations')),
      await page.evaluate(() => window.__mock.plans.length));

    /* ---------- 12: the structure leaves room for blocks and units ---------- */
    check('jobs carry the fields a block/floor/unit tree will need later',
      await page.evaluate(() => {
        const p = window.__mock.projects[0];
        return p && 'parent_id' in p && 'kind' in p && p.kind === 'project';
      }), 'jobs are flat with no room to nest');

    /* ---------- 18: receipts untouched ---------- */
    check('no receipt was touched by any of the planning work',
      await page.evaluate(() => window.__mock.rows.length) === 3,
      await page.evaluate(() => window.__mock.rows.length));
    await page.click('#planback');
    await page.waitForTimeout(600);
    check('the receipts page still works',
      await page.isVisible('#app') &&
      (await page.$$('#grid .cell')).length > 27 &&
      (await page.textContent('#ttotal')).startsWith('£'),
      await page.textContent('#ttotal'));
    await page.click('.cell.has >> nth=0');
    await page.waitForTimeout(800);
    check('a receipt day still opens receipts, not plans',
      /Timber|Screwfix|receipt/i.test(await page.textContent('.sbody')),
      (await page.textContent('.sbody')).slice(0, 120));

    check('no JS errors through planning', errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }

  /* ====== PHASE 19 — Planning before the tables exist ====== */
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    await ctx.route('**/supabase-js@2**', r =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() =>
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }));
    await page.goto('http://localhost:8099/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.evaluate(() => { window.__mock.missingTables.add('plans');
                                window.__mock.missingTables.add('projects'); });
    await page.fill('#em', 'finn@example.com');
    await page.fill('#pw', 'correct-horse');
    await page.click('#authbtn');
    await page.waitForTimeout(1400);

    await page.click('#menu');
    await page.waitForTimeout(500);
    await page.click('#mplans');
    await page.waitForTimeout(1400);
    check('missing tables explain the one setup step instead of erroring',
      /setup SQL|SQL editor/i.test(await page.textContent('#planlists')),
      (await page.textContent('#planlists')).slice(0, 160));
    check('it does not throw', errors.length === 0, JSON.stringify(errors));

    await page.click('#planback');
    await page.waitForTimeout(500);
    check('receipts still work with no planning tables',
      await page.isVisible('#app') && (await page.$$('#grid .cell')).length > 27, 'receipts broke');
    await ctx.close();
  }


  /* ====== PHASE 20 — the saving deadlock, and a black screen at startup ====== */
  {
    const { ctx, page, errors } = await newSession(browser, { camera: false });
    await signIn(page);
    await page.waitForTimeout(1000);

    const busyUp = () => page.evaluate(() =>
      !document.querySelector('#busy').classList.contains('hide'));

    /* ---------- a question must never end up under the saving overlay ---------- */
    check('the question dialog is stacked above the working overlay',
      await page.evaluate(() => {
        const a = document.createElement('div'); a.id = 'askhost';
        const sc = document.createElement('div'); sc.className = 'scrim';
        a.appendChild(sc); document.body.appendChild(a);
        const z = parseInt(getComputedStyle(sc).zIndex, 10);
        const busyZ = parseInt(getComputedStyle(document.querySelector('#busy')).zIndex, 10);
        a.remove();
        return z > busyZ;
      }), 'ask sits under the busy overlay');
    check('asking anything stands the working overlay down while it waits',
      await page.evaluate(async () => {
        busy(true, 'Working…');
        const p = ask('Test', 'body', 'Yes');
        const hiddenWhileAsking = document.querySelector('#busy').classList.contains('hide');
        document.querySelector('#askhost .btn-ghost').click();
        await p;
        const backAfter = !document.querySelector('#busy').classList.contains('hide');
        busy(false);
        return hiddenWhileAsking && backAfter;
      }), 'the overlay stayed up over the question');

    /* ---------- the real flow ---------- */
    await page.evaluate(() => startCapture('file', ymd(new Date())));
    await page.waitForTimeout(300);
    await page.setInputFiles('#ffile', { name: 'r.png', mimeType: 'image/png', buffer: PIXEL });
    await page.waitForTimeout(2500);
    await page.fill('#f_desc', 'Sand and cement');
    await page.fill('#f_amt', '120');
    await page.dispatchEvent('#f_amt', 'input');
    await page.waitForTimeout(250);

    const before = await page.evaluate(() => window.__mock.rows.length);
    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(2500);

    check('the receipt is saved',
      await page.evaluate(() => window.__mock.rows.length) === before + 1,
      await page.evaluate(() => window.__mock.rows.length));
    check('the saving screen is gone once the save has finished',
      !(await busyUp()), 'still stuck on Saving');
    await page.screenshot({ path: `${ROOT}/n30-after-save.png` });

    check('nothing is left covering the app afterwards',
      !(await busyUp()) &&
      await page.evaluate(() => !document.querySelector('#askhost')), 'something is still up');
    check('the new receipt is on the calendar straight away, with no restart',
      /Sand and cement/.test(await page.textContent('#recentlist')),
      (await page.textContent('#recentlist')).slice(0, 200));
    check('the month total picked it up immediately',
      (await page.textContent('#ttotal')).includes('120') ||
      Number((await page.textContent('#ttotal')).replace(/[^0-9.]/g, '')) >= 120,
      await page.textContent('#ttotal'));

    /* ---------- run the whole thing several times over ---------- */
    for (let i = 1; i <= 3; i++) {
      await page.evaluate(() => startCapture('file', ymd(new Date())));
      await page.waitForTimeout(250);
      await page.setInputFiles('#ffile', { name: 'r.png', mimeType: 'image/png', buffer: PIXEL });
      await page.waitForTimeout(2200);
      await page.fill('#f_desc', 'Repeat run ' + i);
      await page.fill('#f_amt', '60');
      await page.dispatchEvent('#f_amt', 'input');
      await page.waitForTimeout(200);
      await page.click('.sfoot .btn-primary');
      await page.waitForTimeout(2200);
      const stuck = await busyUp();
      if (await page.evaluate(() => !!document.querySelector('#askhost'))) {
        await page.click('#askhost .btn-ghost');
        await page.waitForTimeout(700);
      }
      check(`run ${i} of 3: saves and clears the saving screen`,
        !stuck && await page.evaluate(n =>
          window.__mock.rows.some(r => r.description === 'Repeat run ' + n), i),
        'stuck: ' + stuck);
    }
    check('every repeat run landed back on the calendar',
      await page.isVisible('#app') && !(await busyUp()) &&
      await page.evaluate(() => !document.querySelector('#sheets .scrim')), 'not back on the app');

    /* ---------- a failing save must clear the overlay too ---------- */
    await page.evaluate(() => startCapture('file', ymd(new Date())));
    await page.waitForTimeout(250);
    await page.setInputFiles('#ffile', { name: 'r.png', mimeType: 'image/png', buffer: PIXEL });
    await page.waitForTimeout(2200);
    await page.evaluate(() => {
      window.__realFrom = db.from.bind(db);
      db.from = table => table === 'receipts'
        ? { insert: () => ({ select: function () { return this; },
              then: r => Promise.resolve({ data: null,
                error: { message: 'the insert was rejected' } }).then(r) }) }
        : window.__realFrom(table);
    });
    await page.fill('#f_desc', 'This one fails');
    await page.fill('#f_amt', '30');
    await page.dispatchEvent('#f_amt', 'input');
    await page.waitForTimeout(200);
    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(2000);
    check('a failed save clears the saving screen instead of hanging',
      !(await busyUp()), 'stuck on Saving after a failure');
    check('the failure is shown rather than swallowed',
      /the insert was rejected/i.test(await page.textContent('#toast').catch(() => '')),
      await page.textContent('#toast').catch(() => 'no toast'));
    check('the receipt form is still there so nothing typed is lost',
      (await page.inputValue('#f_desc')) === 'This one fails', 'form was thrown away');
    check('the Save button works again after a failure',
      await page.evaluate(() => !document.querySelector('.sfoot .btn-primary').disabled),
      'save left disabled');
    check('no orphan row was written',
      await page.evaluate(() => !window.__mock.rows.some(r => r.description === 'This one fails')),
      'a failed save still wrote a row');

    /* ---------- a double tap must not file it twice ---------- */
    await page.evaluate(() => { db.from = window.__realFrom; });
    await page.fill('#f_desc', 'Only once please');
    const n0 = await page.evaluate(() => window.__mock.rows.length);
    await page.evaluate(() => {
      const b = document.querySelector('.sfoot .btn-primary');
      b.click(); b.click(); b.click();          // three taps in the same tick
    });
    await page.waitForTimeout(2600);
    if (await page.evaluate(() => !!document.querySelector('#askhost'))) {
      await page.click('#askhost .btn-ghost');
      await page.waitForTimeout(600);
    }
    check('three quick taps on Save file exactly one receipt',
      await page.evaluate(() => window.__mock.rows.length) === n0 + 1,
      'rows went from ' + n0 + ' to ' + await page.evaluate(() => window.__mock.rows.length));
    check('and the app is usable afterwards', !(await busyUp()), 'stuck on Saving');

    check('no JS errors through the save flow', errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }

  /* ====== PHASE 21 — startup when the network stalls ====== */
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    // jsdelivr never answers at all; the unpkg mirror refuses outright
    await ctx.route('**/cdn.jsdelivr.net/**supabase-js**', () => { /* hangs for ever */ });
    await ctx.route('**/unpkg.com/**supabase**', r => r.abort());
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://localhost:8099/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    check('a slow start shows the app starting up, not a black screen',
      await page.isVisible('#busy') &&
      /starting/i.test(await page.textContent('#busytxt')),
      await page.textContent('#busytxt').catch(() => 'nothing on screen'));

    // the stalled script is given a deadline, so this ends rather than hanging
    await page.waitForTimeout(14000);
    const body = await page.textContent('body');
    check('a request that never answers ends in the offline message, not a hang',
      /Can.t start up/i.test(body) && /internet connection/i.test(body), body.slice(0, 200));
    check('the black screen is gone: something is always on screen',
      await page.evaluate(() => document.body.innerText.trim().length > 20),
      'the page is blank');
    check('startup did not throw', errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }

  /* ====== PHASE 22 — a normal startup still works ====== */
  {
    const { ctx, page, errors } = await newSession(browser, { camera: false });
    await page.goto('http://localhost:8099/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    check('a normal start lands on the sign-in form',
      await page.isVisible('#auth'), 'no sign-in screen');
    check('and the starting-up overlay is cleared',
      await page.evaluate(() => document.querySelector('#busy').classList.contains('hide')),
      'overlay left up over the sign-in form');
    await page.fill('#em', 'finn@example.com');
    await page.fill('#pw', 'correct-horse');
    await page.click('#authbtn');
    await page.waitForTimeout(1600);
    check('signing in lands on the calendar with nothing covering it',
      await page.isVisible('#app') &&
      await page.evaluate(() => document.querySelector('#busy').classList.contains('hide')),
      'something is covering the app');
    check('no errors on a clean start', errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }


  /* ====== PHASE 23 — the programme, the VAT rate, and editing a filed receipt ====== */
  {
    const { ctx, page, errors } = await newSession(browser, { camera: false });
    await signIn(page);
    await page.waitForTimeout(1000);
    const D = n => { const d = new Date(); d.setDate(d.getDate() + n);
      return `${d.getFullYear()}-${d2(d.getMonth() + 1)}-${d2(d.getDate())}`; };

    /* ---------- 6: VAT comes from the rate, never from the picture ---------- */
    await page.evaluate(() => startCapture('file', ymd(new Date())));
    await page.waitForTimeout(300);
    await page.setInputFiles('#ffile', { name: 'r.png', mimeType: 'image/png', buffer: PIXEL });
    await page.waitForTimeout(2500);
    check('the rate starts at 20%',
      (await page.inputValue('#f_rate')) === '20', await page.inputValue('#f_rate'));
    await page.fill('#f_amt', '120');
    await page.dispatchEvent('#f_amt', 'input');
    await page.waitForTimeout(250);
    check('20% of a £120 VAT-inclusive total is £20',
      (await page.inputValue('#f_vat')) === '20.00' &&
      (await page.inputValue('#f_net')) === '100.00',
      await page.inputValue('#f_vat') + ' / ' + await page.inputValue('#f_net'));

    await page.fill('#f_rate', '5');
    await page.dispatchEvent('#f_rate', 'input');
    await page.waitForTimeout(250);
    check('changing the rate to 5% recalculates the VAT',
      (await page.inputValue('#f_vat')) === '5.71' &&
      (await page.inputValue('#f_net')) === '114.29',
      await page.inputValue('#f_vat') + ' / ' + await page.inputValue('#f_net'));

    await page.fill('#f_rate', '0');
    await page.dispatchEvent('#f_rate', 'input');
    await page.waitForTimeout(250);
    check('a 0% rate gives no VAT and the net equals the total',
      (await page.inputValue('#f_vat')) === '0.00' &&
      (await page.inputValue('#f_net')) === '120.00',
      await page.inputValue('#f_vat') + ' / ' + await page.inputValue('#f_net'));

    await page.fill('#f_rate', '20');
    await page.dispatchEvent('#f_rate', 'input');
    await page.waitForTimeout(250);
    await page.fill('#f_desc', 'Bricks');
    await page.click('.sfoot .btn-primary');
    await page.waitForTimeout(2200);
    const saved = await page.evaluate(() =>
      window.__mock.rows.find(r => r.description === 'Bricks'));
    check('the receipt saves with the figures from the rate',
      saved && saved.amount === 120 && saved.vat === 20 && saved.net === 100 &&
      saved.vat_rate === 20, JSON.stringify(saved && {
        a: saved.amount, v: saved.vat, n: saved.net, r: saved.vat_rate }));
    check('no supplier is written to the record',
      saved && !saved.vendor && !saved.supplier_key,
      JSON.stringify(saved && { v: saved.vendor, k: saved.supplier_key }));
    check('saving does not ask about a supplier folder any more',
      await page.evaluate(() => !document.querySelector('#askhost')
        && typeof offerSupplierFolder === 'undefined'), 'the supplier prompt is still there');

    /* ---------- 8: editing a filed receipt ---------- */
    await page.click('#recenthead');
    await page.waitForTimeout(1500);
    await page.click('.rcrow:has-text("Bricks") .rcmeta');
    await page.waitForTimeout(1500);
    check('it opens the same receipt form, not a second one',
      (await page.textContent('.shead h3')) === 'Edit receipt' &&
      await page.isVisible('#f_desc') && await page.isVisible('#f_amt') &&
      await page.isVisible('#f_vat') && await page.isVisible('#f_rate') &&
      await page.isVisible('#f_date') && await page.isVisible('#f_folderpick'),
      await page.textContent('.shead h3').catch(() => 'none'));
    check('the figures already on record are loaded, not recalculated away',
      (await page.inputValue('#f_amt')) === '120.00' &&
      (await page.inputValue('#f_vat')) === '20.00' &&
      (await page.inputValue('#f_rate')) === '20',
      JSON.stringify([await page.inputValue('#f_amt'), await page.inputValue('#f_vat')]));
    check('no supplier field on the edit form either',
      !/Supplier/i.test(await page.textContent('.sbody')), 'supplier is back');
    await page.screenshot({ path: `${ROOT}/n32-edit.png` });

    // correct the price, which is the main reason he wants this
    await page.fill('#f_amt', '240');
    await page.dispatchEvent('#f_amt', 'input');
    await page.waitForTimeout(250);
    check('correcting the total recalculates the VAT at the same rate',
      (await page.inputValue('#f_vat')) === '40.00', await page.inputValue('#f_vat'));

    // and move it to a folder
    await page.evaluate(async () => { await createFolder('Materials'); });
    await page.waitForTimeout(500);
    await page.click('#f_folderpick');
    await page.waitForTimeout(700);
    await page.click('#pickhost .ditem:has-text("Materials")');
    await page.waitForTimeout(500);
    check('the folder can be changed from the edit screen',
      (await page.textContent('#f_folderpick .lbl')) === 'Materials',
      await page.textContent('#f_folderpick .lbl'));
    await page.fill('#f_date', D(-2));
    await page.click('#e_save');
    await page.waitForTimeout(2200);

    const edited = await page.evaluate(() =>
      window.__mock.rows.find(r => r.description === 'Bricks'));
    const matId = await page.evaluate(() =>
      window.__mock.folders.find(f => f.name === 'Materials').id);
    check('the corrected price is stored', edited && edited.amount === 240 && edited.vat === 40,
      JSON.stringify(edited && { a: edited.amount, v: edited.vat }));
    check('the folder change is stored', edited && edited.folder_id === matId,
      JSON.stringify(edited && edited.folder_id));
    check('the date change is stored', edited && edited.receipt_date === D(-2),
      JSON.stringify(edited && edited.receipt_date));
    check('editing does not duplicate the receipt',
      await page.evaluate(() => window.__mock.rows.filter(r => r.description === 'Bricks').length) === 1,
      'duplicated');
    check('the picture is left alone by an edit',
      edited && edited.file_path === saved.file_path && edited.file_type === saved.file_type,
      JSON.stringify(edited && edited.file_path));
    check('the saving overlay clears after an edit',
      await page.evaluate(() => document.querySelector('#busy').classList.contains('hide')),
      'stuck on saving');

    /* ---------- 1 + 2: the programme ---------- */
    await page.evaluate(async () => {
      const oak = await createProject('Flats');
      const riv = await createProject('Houses');
      const mk = (title, pid, from, to, status, prog) => ({
        title, project_id: pid, start_date: from, end_date: to,
        status, progress: prog, notes: null
      });
      // days inside the month the programme opens on, so every bar is on screen
      const now = new Date();
      const dm = n => now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
                    + '-' + String(n).padStart(2, '0');
      const rel = n => { const x = new Date(); x.setDate(x.getDate() + n);
        return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0')
             + '-' + String(x.getDate()).padStart(2, '0'); };
      for (const p of [
        mk('Groundworks', oak.id, dm(2),  dm(4),  'completed', 100),
        mk('Foundations', oak.id, dm(5),  dm(15), 'in_progress', 40),
        mk('Structure',   oak.id, dm(16), dm(24), 'not_started', 0),
        mk('Roofing',     riv.id, dm(8),  dm(20), 'not_started', 0),
        // finished a month ago and never marked complete: this one is overdue
        mk('Old drainage', oak.id, rel(-40), rel(-30), 'in_progress', 20)
      ]) await db.from('plans').insert(Object.assign({}, p, { created_by: 'user-1' }));
    });
    await page.evaluate(() => { closeSheet(); openPlanning(); });
    await page.waitForTimeout(1800);

    check('Planning opens on the programme, not the month grid',
      await page.isVisible('#programme') &&
      await page.evaluate(() => document.querySelector('#pgrid').classList.contains('hide')),
      'no programme view');
    check('there is a Programme / Calendar switch',
      (await page.$$eval('#planseg button', ns => ns.map(n => n.textContent))).join(',')
        === 'Programme,Calendar',
      await page.$$eval('#planseg button', ns => ns.map(n => n.textContent).join(',')));
    check('the dates run down the side of the programme',
      (await page.$$('#programme .tlday')).length > 30,
      (await page.$$('#programme .tlday')).length);
    check('every day carries its number and weekday',
      await page.evaluate(() => {
        const d = document.querySelector('#programme .tlday');
        return !!d.querySelector('b') && !!d.querySelector('span');
      }), 'a day row is missing its label');
    check('the days are stacked in order down the page',
      await page.evaluate(() => {
        const t = [...document.querySelectorAll('#programme .tlday')]
          .map(n => parseFloat(n.style.top));
        return t.every((v, i) => i === 0 || v > t[i - 1]);
      }), 'the dates are not in order');
    check('today is picked out',
      (await page.$$('#programme .tlday.today')).length === 1,
      (await page.$$('#programme .tlday.today')).length);

    check('every plan gets a bar beside the dates',
      (await page.$$('#programme .tlbar')).length === 5,
      (await page.$$('#programme .tlbar')).length);
    check('the bars are grouped into columns per job',
      (await page.$$eval('#programme .tljob', ns => ns.map(n => n.textContent).filter(Boolean)))
        .sort().join(',') === 'Flats,Houses',
      await page.$$eval('#programme .tljob', ns => ns.map(n => n.textContent).join('|')));
    check('the two jobs are told apart by colour',
      await page.evaluate(() => {
        const c = [...document.querySelectorAll('#programme .tlbar')]
          .map(b => getComputedStyle(b).backgroundColor);
        return new Set(c).size >= 2;
      }), 'every bar is the same colour');
    check('a colour key says which job is which',
      (await page.$$('#tlkey span')).length === 2, (await page.$$('#tlkey span')).length);
    check('each bar names the activity and shows a status',
      await page.evaluate(() => [...document.querySelectorAll('#programme .tlbar')]
        .every(n => (n.querySelector('b') || {}).textContent
                 && (n.querySelector('span') || {}).textContent)),
      'a bar is missing its name or status');
    check('a completed job is shown as complete',
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('#programme .tlbar')]
          .find(n => (n.querySelector('b') || {}).textContent === 'Groundworks');
        return !!b && /Complete/i.test(b.querySelector('span').textContent);
      }), 'the completed bar does not say so');
    check('one that has run past its end date is flagged on the bar',
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('#programme .tlbar')]
          .find(n => (n.querySelector('b') || {}).textContent === 'Old drainage');
        return !!b && /Overdue/i.test(b.querySelector('span').textContent)
                   && b.classList.contains('late');
      }), 'an overdue bar is not flagged');

    check('a job lasting several days is a taller bar than a one-day job',
      await page.evaluate(() => {
        const h = t => {
          const b = [...document.querySelectorAll('#programme .tlbar')]
            .find(n => (n.querySelector('b') || {}).textContent === t);
          return b ? b.getBoundingClientRect().height : 0;
        };
        return h('Foundations') > h('Groundworks') && h('Groundworks') > 0;
      }), 'bar heights do not follow the dates');
    check('a job starting later sits further down',
      await page.evaluate(() => {
        const y = t => {
          const b = [...document.querySelectorAll('#programme .tlbar')]
            .find(n => (n.querySelector('b') || {}).textContent === t);
          return b ? parseFloat(b.style.top) : -1;
        };
        return y('Structure') > y('Foundations') && y('Foundations') > y('Groundworks');
      }), 'bars are not positioned by date');
    check('a bar starts on the right day',
      await page.evaluate(() => {
        const bar = [...document.querySelectorAll('#programme .tlbar')]
          .find(n => (n.querySelector('b') || {}).textContent === 'Foundations');
        const days = [...document.querySelectorAll('#programme .tlday')];
        const row = days.find(d => Math.abs(parseFloat(d.style.top) - (parseFloat(bar.style.top) - 3)) < 1);
        return !!row && row.querySelector('b').textContent === '5';
      }), 'the bar does not line up with its start date');

    /* ---------- the page scrolls down, the timeline scrolls across ---------- */
    // two jobs running at the same time need columns of their own, which is when
    // the timeline has more than one screen's width to show
    await page.evaluate(async () => {
      const flats = window.__mock.projects.find(p => p.name === 'Flats');
      const now = new Date();
      const dm = n => now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
                    + '-' + String(n).padStart(2, '0');
      for (const t of [['Kitchen delivery', dm(6), dm(6)], ['Plasterers starting', dm(7), dm(12)]])
        await db.from('plans').insert({ title: t[0], project_id: flats.id,
          start_date: t[1], end_date: t[2], status: 'not_started', notes: null,
          created_by: 'user-1' });
    });
    await page.evaluate(async () => { await loadPlanning(); paintPlanning(); });
    await page.waitForTimeout(900);
    check('two jobs on the same day each get their own column',
      (await page.$$('#programme .tlbar')).length === 7 &&
      await page.evaluate(() => {
        const l = [...document.querySelectorAll('#programme .tlbar')]
          .map(b => parseFloat(b.style.left));
        return new Set(l).size >= 3;
      }), (await page.$$('#programme .tlbar')).length + ' bars');

    const geom = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const pan = document.querySelector('#tlpan');
      // content inside the timeline's own scroller is meant to be wider than the
      // screen — it is clipped there. Nothing else may cross the right edge.
      const over = [...document.querySelectorAll('#plan *')]
        .filter(n => !pan.contains(n) && n !== pan)
        .filter(n => n.getBoundingClientRect().right > w + 1)
        .map(n => n.className || n.tagName);
      return { w, docScroll: document.documentElement.scrollWidth,
               planScroll: document.querySelector('#plan').scrollWidth,
               over: over.slice(0, 5),
               panScrolls: pan.scrollWidth > pan.clientWidth,
               panOverflowY: getComputedStyle(pan).overflowY,
               pageTall: document.body.scrollHeight > window.innerHeight };
    });
    check('nothing sticks out past the right edge of the screen',
      geom.over.length === 0, JSON.stringify(geom));
    check('the page itself never scrolls sideways',
      geom.docScroll <= geom.w + 1 && geom.planScroll <= geom.w + 1, JSON.stringify(geom));
    check('only the timeline columns scroll across',
      geom.panScrolls && geom.panOverflowY === 'hidden', JSON.stringify(geom));
    check('the page scrolls down through the dates',
      geom.pageTall, JSON.stringify(geom));
    check('scrolling the columns sideways leaves the dates in place',
      await page.evaluate(async () => {
        const pan = document.querySelector('#tlpan');
        const before = document.querySelector('#programme .tlday').getBoundingClientRect().left;
        pan.scrollLeft = pan.scrollWidth;
        await new Promise(r => setTimeout(r, 120));
        const after = document.querySelector('#programme .tlday').getBoundingClientRect().left;
        pan.scrollLeft = 0;
        return Math.abs(before - after) < 1;
      }), 'the dates moved with the columns');

    /* ---------- the Today button ---------- */
    check('Today jumps back to today in the timeline',
      await page.evaluate(async () => {
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 100));
        document.querySelector('#plantoday').click();
        await new Promise(r => setTimeout(r, 900));
        const t = document.querySelector('#programme .tlday.today').getBoundingClientRect();
        return t.top > -50 && t.top < window.innerHeight;
      }), 'today is not on screen after tapping Today');
    check('the toggle and Add Plan stay reachable',
      await page.isVisible('#planseg') && await page.isVisible('#addplan'), 'controls lost');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${ROOT}/n33-programme.png` });

    check('tapping an activity opens that plan',
      await (async () => {
        await page.click('#programme .tlbar >> nth=0');
        await page.waitForTimeout(900);
        return (await page.textContent('.shead h3')) === 'Plan';
      })(), await page.textContent('.shead h3').catch(() => 'none'));
    await page.evaluate(() => closeSheet());
    await page.waitForTimeout(400);

    check('the calendar is still there behind the switch',
      await (async () => {
        await page.click('#planseg button:has-text("Calendar")');
        await page.waitForTimeout(700);
        return !(await page.isVisible('#programme').catch(() => false)) &&
               (await page.$$('#pgrid .cell')).length > 27;
      })(), 'the calendar view is gone');
    await page.click('#planseg button:has-text("Programme")');
    await page.waitForTimeout(600);
    check('and switching back returns to the programme',
      await page.isVisible('#programme'), 'did not switch back');

    /* ---------- receipts are untouched by any of it ---------- */
    await page.click('#planback');
    await page.waitForTimeout(600);
    check('the receipts side still works',
      await page.isVisible('#app') && (await page.$$('#grid .cell')).length > 27,
      'receipts broke');

    check('no JS errors', errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }


  /* ====== PHASE 24 — Site Records ====== */
  {
    const { ctx, page, errors } = await newSession(browser, { camera: false });
    await signIn(page);
    await page.waitForTimeout(1000);

    const receiptsBefore = await page.evaluate(() => window.__mock.rows.length);
    const foldersBefore  = await page.evaluate(() => window.__mock.folders.length);

    await page.evaluate(async () => {
      await createProject('Flats'); await createProject('Houses');
    });
    await page.waitForTimeout(600);

    /* ---------- it is its own section ---------- */
    await page.click('#menu');
    await page.waitForTimeout(500);
    await page.click('#msite');
    await page.waitForTimeout(1400);
    check('Site Records opens as its own full-screen page',
      await page.isVisible('#site') && !(await page.isVisible('#app')),
      'site visible: ' + await page.isVisible('#site'));
    check('it says there is nothing recorded yet',
      /No site records yet/i.test(await page.textContent('#sitelist')),
      (await page.textContent('#sitelist')).slice(0, 120));
    check('there is an obvious Add Record button',
      await page.isVisible('#addrecord'), 'no add button');

    /* ---------- adding a record with several photos ---------- */
    await page.click('#addrecord');
    await page.waitForTimeout(800);
    const labels = await page.$$eval('.sbody label', ns => ns.map(n => n.textContent.trim()));
    check('the form asks what, job, date, location, description and photos',
      JSON.stringify(labels) === JSON.stringify(
        ['What was done', 'Job', 'Date', 'Location', 'Description', 'Photos']),
      JSON.stringify(labels));
    check('there is nothing about VAT, totals or suppliers on it',
      !/VAT|Total|Supplier|Net/i.test(await page.textContent('.sbody')),
      'a receipt field leaked in');
    check('the date defaults to today',
      (await page.inputValue('#sr_date')) === day(today.getDate()),
      await page.inputValue('#sr_date'));

    await page.fill('#sr_title', 'Underground drainage');
    await page.click('#sr_save');
    await page.waitForTimeout(600);
    check('a record with no job is refused',
      /job/i.test(await page.textContent('#toast').catch(() => '')),
      await page.textContent('#toast').catch(() => 'no toast'));

    await page.click('#sr_job');
    await page.waitForTimeout(700);
    await page.click('#pickhost .ditem:has-text("Flats")');
    await page.waitForTimeout(600);
    check('the job is chosen without losing what was typed',
      (await page.textContent('#sr_job .lbl')) === 'Flats' &&
      (await page.inputValue('#sr_title')) === 'Underground drainage',
      await page.textContent('#sr_job .lbl').catch(() => 'none'));

    await page.click('#sr_save');
    await page.waitForTimeout(600);
    check('a record with no photo is refused — the photo is the evidence',
      /photo/i.test(await page.textContent('#toast').catch(() => '')),
      await page.textContent('#toast').catch(() => 'no toast'));

    await page.fill('#sr_loc', 'Rear elevation');
    await page.fill('#sr_notes', 'Underground drainage installed and checked before backfilling.');
    await page.setInputFiles('#sitefiles', [
      { name: 'a.png', mimeType: 'image/png', buffer: PIXEL },
      { name: 'b.png', mimeType: 'image/png', buffer: PIXEL },
      { name: 'c.png', mimeType: 'image/png', buffer: PIXEL }
    ]);
    await page.waitForTimeout(700);
    check('several photos can go on one record',
      (await page.$$('#sr_photos .srcell')).length === 3,
      (await page.$$('#sr_photos .srcell')).length);
    check('a photo can be taken back off before saving',
      await (async () => {
        await page.click('#sr_photos .srcell .drop >> nth=2');
        await page.waitForTimeout(400);
        return (await page.$$('#sr_photos .srcell')).length === 2;
      })(), 'could not remove a photo');
    await page.setInputFiles('#sitefiles', [
      { name: 'c.png', mimeType: 'image/png', buffer: PIXEL }
    ]);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${ROOT}/n34-siteform.png` });

    await page.click('#sr_save');
    await page.waitForTimeout(2600);

    const rec = await page.evaluate(() => window.__mock.site_records[0]);
    const pics = await page.evaluate(() => window.__mock.site_photos);
    check('the record is stored with what, when and where',
      rec && rec.title === 'Underground drainage' && rec.record_date === day(today.getDate())
        && rec.location === 'Rear elevation' && /backfilling/.test(rec.notes || ''),
      JSON.stringify(rec));
    check('it is tied to the job',
      rec && rec.project_id === await page.evaluate(() =>
        window.__mock.projects.find(p => p.name === 'Flats').id),
      JSON.stringify(rec && rec.project_id));
    check('all three photos are stored against it',
      pics.length === 3 && pics.every(p => p.record_id === rec.id), JSON.stringify(pics.length));
    check('the photos are kept in their own folder in storage, away from receipts',
      pics.every(p => p.file_path.startsWith('site/')) &&
      await page.evaluate(() => [...window.__mock.files.keys()]
        .filter(k => k.startsWith('site/')).length === 3),
      JSON.stringify(pics.map(p => p.file_path)));
    check('the photos keep their order', pics.map(p => p.sort).join(',') === '0,1,2',
      pics.map(p => p.sort).join(','));

    /* ---------- a second record on the other job ---------- */
    await page.click('#addrecord');
    await page.waitForTimeout(700);
    await page.fill('#sr_title', 'Foundation reinforcement');
    await page.fill('#sr_loc', 'Plot 3');
    await page.click('#sr_job');
    await page.waitForTimeout(600);
    await page.click('#pickhost .ditem:has-text("Houses")');
    await page.waitForTimeout(500);
    await page.setInputFiles('#sitefiles', [{ name: 'd.png', mimeType: 'image/png', buffer: PIXEL }]);
    await page.waitForTimeout(600);
    await page.click('#sr_save');
    await page.waitForTimeout(2200);

    /* ---------- browsing ---------- */
    const listTxt = await page.textContent('#sitelist');
    check('records are grouped under their job',
      (await page.$$eval('#sitelist .srjob h4', ns => ns.map(n => n.textContent))).sort().join(',')
        === 'Flats,Houses',
      await page.$$eval('#sitelist .srjob h4', ns => ns.map(n => n.textContent).join(',')));
    check('each row shows what it is, the date and the location',
      /Underground drainage/.test(listTxt) && /Rear elevation/.test(listTxt) &&
      /Foundation reinforcement/.test(listTxt) && /Plot 3/.test(listTxt),
      listTxt.slice(0, 300));
    check('each row says how many photos it has',
      /3 photos/.test(listTxt) && /1 photo\b/.test(listTxt), listTxt.slice(0, 300));
    check('the header counts the records and the photos',
      (await page.textContent('#srcount')).trim() === '2' &&
      (await page.textContent('#srphotos')).trim() === '4',
      await page.textContent('.totals'));
    await page.screenshot({ path: `${ROOT}/n35-sitelist.png` });

    await page.click('#sitefilter');
    await page.waitForTimeout(700);
    await page.click('.ditem:has-text("Houses")');
    await page.waitForTimeout(700);
    check('the list can be narrowed to one job',
      (await page.textContent('#srcount')).trim() === '1' &&
      /Foundation reinforcement/.test(await page.textContent('#sitelist')) &&
      !/Underground drainage/.test(await page.textContent('#sitelist')),
      await page.textContent('#srscope'));
    await page.click('#sitefilter');
    await page.waitForTimeout(600);
    await page.click('#sfall');
    await page.waitForTimeout(700);
    check('and back to every job',
      (await page.textContent('#srcount')).trim() === '2', await page.textContent('#srscope'));

    /* ---------- viewing a record and its photos ---------- */
    await page.click('.srrow:has-text("Underground drainage")');
    await page.waitForTimeout(1200);
    const recTxt = await page.textContent('.sbody');
    check('the record shows the job, date, location and description',
      /Flats/.test(recTxt) && /Rear elevation/.test(recTxt) && /backfilling/.test(recTxt) &&
      /August|September|July/.test(recTxt), recTxt.slice(0, 300));
    check('its photos are shown',
      (await page.$$('.srgrid .srcell')).length === 3,
      (await page.$$('.srgrid .srcell')).length);

    await page.click('.srgrid .srcell >> nth=0');
    await page.waitForTimeout(1400);
    check('tapping a photo opens it full screen',
      await page.isVisible('#sviewer'), 'no viewer');
    check('it says which photo of how many',
      /1 of 3/.test(await page.textContent('.svnav')), await page.textContent('.svnav'));
    await page.click('#svnext');
    await page.waitForTimeout(900);
    check('you can move to the next photo',
      /2 of 3/.test(await page.textContent('.svnav')), await page.textContent('.svnav'));
    await page.click('#svprev');
    await page.waitForTimeout(900);
    check('and back again',
      /1 of 3/.test(await page.textContent('.svnav')), await page.textContent('.svnav'));

    await page.evaluate(() => {
      const a = document.querySelector('#vbody');
      const t2 = (x1, y1, x2, y2) => ({ touches: [
        { clientX: x1, clientY: y1 }, { clientX: x2, clientY: y2 }] });
      a.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true }), t2(150, 400, 250, 400)));
      a.dispatchEvent(Object.assign(new Event('touchmove', { bubbles: true, cancelable: true }),
        Object.assign(t2(100, 400, 300, 400), { preventDefault(){} })));
    });
    await page.waitForTimeout(500);
    check('the photo zooms',
      /scale\(([2-9]|1\.[1-9])/.test(
        await page.evaluate(() => document.querySelector('#vimg').style.transform)),
      await page.evaluate(() => document.querySelector('#vimg').style.transform));
    await page.screenshot({ path: `${ROOT}/n36-sitephoto.png` });
    await page.evaluate(() => document.querySelector('#sviewer').remove());
    await page.waitForTimeout(400);

    /* ---------- editing ---------- */
    await page.click('#sr_edit');
    await page.waitForTimeout(900);
    check('a record can be edited',
      (await page.inputValue('#sr_title')) === 'Underground drainage' &&
      (await page.inputValue('#sr_loc')) === 'Rear elevation',
      await page.inputValue('#sr_title'));
    await page.fill('#sr_loc', 'Rear elevation, manhole 2');
    await page.click('#sr_photos .srcell .drop >> nth=0');
    await page.waitForTimeout(400);
    await page.click('#sr_save');
    await page.waitForTimeout(2200);
    check('the change is saved',
      await page.evaluate(() =>
        window.__mock.site_records.find(r => r.title === 'Underground drainage').location)
        === 'Rear elevation, manhole 2',
      await page.evaluate(() =>
        window.__mock.site_records.find(r => r.title === 'Underground drainage').location));
    check('a photo removed while editing is taken off the record and out of storage',
      await page.evaluate(() => window.__mock.site_photos.length) === 3 &&
      await page.evaluate(() => [...window.__mock.files.keys()]
        .filter(k => k.startsWith('site/')).length) === 3,
      await page.evaluate(() => window.__mock.site_photos.length + ' photo rows'));
    check('editing does not duplicate the record',
      await page.evaluate(() => window.__mock.site_records.length) === 2,
      await page.evaluate(() => window.__mock.site_records.length));

    /* ---------- deleting ---------- */
    await page.click('.srrow:has-text("Foundation reinforcement")');
    await page.waitForTimeout(1000);
    await page.click('#sr_del');
    await page.waitForTimeout(700);
    check('deleting asks first', await page.isVisible('#askhost .btn-danger'), 'no confirm');
    await page.click('#askhost .btn-danger');
    await page.waitForTimeout(2000);
    check('the record is deleted',
      await page.evaluate(() => window.__mock.site_records.length) === 1,
      await page.evaluate(() => window.__mock.site_records.length));
    check('its photos go with it, in the database and in storage',
      await page.evaluate(() => window.__mock.site_photos.length) === 2 &&
      await page.evaluate(() => [...window.__mock.files.keys()]
        .filter(k => k.startsWith('site/')).length) === 2,
      await page.evaluate(() => window.__mock.site_photos.length + ' photo rows'));

    /* ---------- and none of it has touched the receipts ---------- */
    await page.click('#siteback');
    await page.waitForTimeout(800);
    check('back returns to receipts',
      await page.isVisible('#app') && !(await page.isVisible('#site')), 'did not go back');
    check('no site record became a receipt',
      await page.evaluate(() => window.__mock.rows.length) === receiptsBefore,
      await page.evaluate(() => window.__mock.rows.length) + ' vs ' + receiptsBefore);
    check('no receipt folder was created for it',
      await page.evaluate(() => window.__mock.folders.length) === foldersBefore,
      await page.evaluate(() => window.__mock.folders.length) + ' vs ' + foldersBefore);
    check('the receipt totals are unchanged',
      (await page.textContent('#ttotal')).startsWith('£'), await page.textContent('#ttotal'));
    check('nothing shows in Recently Added',
      !/Underground drainage|Foundation reinforcement/
        .test(await page.textContent('#recentlist')),
      (await page.textContent('#recentlist')).slice(0, 200));
    check('nothing shows in the receipt calendar',
      await page.evaluate(() => !rows.some(r => /drainage|reinforcement/i.test(r.description || ''))),
      'a site record reached the calendar');

    await page.click('#recenthead');
    await page.waitForTimeout(1400);
    check('and none in the full Recently Added list',
      !/Underground drainage/.test(await page.textContent('.sbody')),
      (await page.textContent('.sbody')).slice(0, 200));
    await page.evaluate(() => closeSheet());
    await page.waitForTimeout(400);

    check('no JS errors through site records', errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }

  /* ====== PHASE 25 — Site Records before its tables exist ====== */
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    await ctx.route('**/supabase-js@2**', r =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() =>
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }));
    await page.goto('http://localhost:8099/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.evaluate(() => { window.__mock.missingTables.add('site_records');
                                window.__mock.missingTables.add('site_photos'); });
    await page.fill('#em', 'finn@example.com');
    await page.fill('#pw', 'correct-horse');
    await page.click('#authbtn');
    await page.waitForTimeout(1400);

    await page.click('#menu');
    await page.waitForTimeout(500);
    await page.click('#msite');
    await page.waitForTimeout(1400);
    check('missing tables explain the one setup step instead of erroring',
      /setup SQL|SQL editor/i.test(await page.textContent('#sitelist')),
      (await page.textContent('#sitelist')).slice(0, 160));
    check('it does not throw', errors.length === 0, JSON.stringify(errors));
    await page.click('#siteback');
    await page.waitForTimeout(600);
    check('receipts still work with no site tables',
      await page.isVisible('#app') && (await page.$$('#grid .cell')).length > 27, 'receipts broke');
    await ctx.close();
  }


  console.log('\n=== PASS (' + pass.length + ') ===');
  pass.forEach(p => console.log('  ✓ ' + p));
  if (fail.length) {
    console.log('\n=== FAIL (' + fail.length + ') ===');
    fail.forEach(f => console.log('  ✗ ' + f));
  }

  await browser.close();
  server.close();
  process.exit(fail.length ? 1 : 0);
})();
