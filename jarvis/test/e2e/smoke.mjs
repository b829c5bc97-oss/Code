// Browser smoke test: signs up, loads demo data, visits every screen and exercises key flows.
// Usage: BASE=http://localhost:3123 node test/e2e/smoke.mjs [screenshotDir]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3000';
const shots = process.argv[2];
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', process.env.CHROME_PATH].find((p) => p && fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe });
const errors = [];
const run = async (viewport, label) => {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 409/.test(m.text())) errors.push(`[${label}] console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`[${label}] HTTP ${r.status()} ${r.url()}`); });
  await page.goto(BASE);
  await page.waitForSelector('form');
  await page.click('text=Create an account');
  await page.fill('input[name=name]', 'Test User');
  await page.fill('input[name=email]', `e2e-${Date.now()}-${label}@example.com`);
  await page.fill('input[name=password]', 'correct-horse-battery');
  await page.click('button[type=submit]');
  await page.waitForSelector('.sidebar');
  await page.waitForSelector('text=Load demo data');
  await page.click('button:has-text("Load demo data")');
  await page.waitForSelector('text=Daily briefing', { timeout: 10000 });
  if (shots) await page.screenshot({ path: `${shots}/${label}-overview.png`, fullPage: true });
  for (const route of ['assistant', 'calendar', 'tasks', 'schedule', 'finance', 'reminders', 'notes', 'integrations', 'settings']) {
    await page.goto(`${BASE}/#/${route}`);
    await page.waitForTimeout(700);
    const failed = await page.locator('text=This screen failed to load').count();
    if (failed) errors.push(`[${label}] ${route} failed to load: ${await page.locator('.empty').first().textContent()}`);
    if (shots) await page.screenshot({ path: `${shots}/${label}-${route}.png`, fullPage: route !== 'assistant' });
  }
  return page;
};

const page = await run({ width: 1440, height: 900 }, 'desktop');
// Assistant flow
await page.goto(`${BASE}/#/assistant`);
await page.fill('input[aria-label="Message JARVIS"]', 'Plan my day');
await page.keyboard.press('Enter');
await page.waitForSelector('.msg.assistant .bubble:not(.typing)', { timeout: 10000 });
await page.waitForTimeout(300);
const approve = page.locator('.confirm-card button:has-text("Approve")');
if (await approve.count()) { await approve.first().click(); await page.waitForSelector('text=Approved and saved'); }
if (shots) await page.screenshot({ path: `${shots}/desktop-assistant-flow.png` });
// Calendar views
await page.goto(`${BASE}/#/calendar`);
for (const v of ['Day', 'Week', 'Month']) { await page.click(`.btn-group button:has-text("${v}")`); await page.waitForTimeout(300); }
if (shots) await page.screenshot({ path: `${shots}/desktop-calendar-month.png`, fullPage: true });
await page.click('button:has-text("New event")');
await page.fill('dialog input[name=title]', 'E2E event');
await page.click('dialog button:has-text("Create event")');
await page.waitForTimeout(800);
const dlg = await page.locator('dialog[open]').count();
if (dlg) { // conflict dialog?
  const txt = await page.locator('dialog[open]').last().textContent();
  if (/conflict/i.test(txt)) await page.click('dialog[open] button:has-text("Save anyway")');
  await page.waitForTimeout(500);
}
const left = page.locator('dialog[open]');
if (await left.count()) errors.push(`dialog still open after creating event: ${(await left.last().textContent()).slice(0, 300)}`);
// Tasks board + projects
await page.goto(`${BASE}/#/tasks`);
for (const t of ['Board', 'Calendar', 'Projects']) { await page.click(`.tabs button:has-text("${t}")`); await page.waitForTimeout(400); }
await page.click('.project-card');
await page.waitForSelector('dialog[open]');
if (shots) await page.screenshot({ path: `${shots}/desktop-project.png` });
await page.keyboard.press('Escape');
// Finance tabs
await page.goto(`${BASE}/#/finance`);
for (const t of ['Transactions', 'Budgets', 'Bills & subscriptions', 'Savings goals', 'Reports', 'Import / export']) { await page.click(`.tabs button:has-text("${t}")`); await page.waitForTimeout(400); if (shots) await page.screenshot({ path: `${shots}/desktop-finance-${t.split(' ')[0].toLowerCase()}.png`, fullPage: true }); }
// Settings sections
await page.goto(`${BASE}/#/settings`);
for (const s of ['Schedule', 'Notifications', 'Assistant', 'Privacy & permissions', 'Data', 'Account']) { await page.click(`nav[aria-label="Settings sections"] button:has-text("${s}")`); await page.waitForTimeout(300); }
// Notes
await page.goto(`${BASE}/#/notes`);
await page.click('button:has-text("Find action items")');
await page.waitForTimeout(500);
// Light theme + mobile
await page.click('button[aria-label="Toggle light/dark theme"]');
await page.goto(`${BASE}/#/overview`);
await page.waitForTimeout(800);
if (shots) await page.screenshot({ path: `${shots}/desktop-overview-light.png`, fullPage: true });
await run({ width: 390, height: 844 }, 'mobile');
await browser.close();
if (errors.length) { console.log(errors.join('\n')); process.exit(1); }
console.log('E2E smoke passed');
