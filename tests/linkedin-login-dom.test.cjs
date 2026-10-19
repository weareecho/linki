// Local Chromium fixtures only. Every request is intercepted; no provider access.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
let browser, guard;
before(async () => {
  guard = await import(pathToFileURL(path.resolve(__dirname, '../lib/linkedin/session-state.ts')).href);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); });
async function check(url, html, withCookie = true) {
  const context = await browser.newContext();
  try {
    if (withCookie) await context.addCookies([{ name: 'li_at', value: 'synthetic-only', domain: '.www.linkedin.com', path: '/', secure: true }]);
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    const page = await context.newPage();
    await page.goto(url);
    return await guard.hasSignedInLinkedInEvidence(page);
  } finally { await context.close(); }
}
test('hidden first navigation does not mask visible signed-in navigation', async () => {
  assert.equal(await check('https://www.linkedin.com/feed/', '<nav hidden><img class="global-nav__me-photo"></nav><nav><a href="/in/fixture-owner">Me</a></nav>'), true);
});
test('bare feed path is a valid landing with positive session evidence', async () => {
  assert.equal(await check('https://www.linkedin.com/feed', '<nav><a href="/in/fixture-owner">Me</a></nav>'), true);
});
test('hidden-only, cookie-less, guest and foreign pages fail closed', async () => {
  const nav = '<nav><a href="/in/fixture-owner">Me</a></nav>';
  assert.equal(await check('https://www.linkedin.com/feed/', '<nav hidden><a href="/in/fixture-owner">Me</a></nav>'), false);
  assert.equal(await check('https://www.linkedin.com/feed/', nav, false), false);
  assert.equal(await check('https://www.linkedin.com/feed/', '<a href="/in/someone-else">Guest profile link</a>'), false);
  for (const url of ['https://www.linkedin.com/login?next=/feed/', 'https://www.linkedin.com/authwall', 'https://www.linkedin.com/feed-other', 'https://evil.test/feed/']) {
    assert.equal(await check(url, nav), false);
  }
});

const modernNav = paths => '<header>' + paths.map(href => `<a href="${href}">${href}</a>`).join('') + '</header>';
const accountPaths = ['/feed/', '/mynetwork/', '/jobs/', '/messaging/', '/notifications/'];
test('complete modern account navigation works without legacy CSS or nav elements', async () => {
 assert.equal(await check('https://www.linkedin.com/feed/', modernNav(accountPaths)), true);
 assert.equal(await check('https://www.linkedin.com/feed/', modernNav(accountPaths.map(p=>'https://www.linkedin.com'+p))), true);
});
test('partial, foreign, hidden or cookie-less modern navigation never authenticates', async () => {
 assert.equal(await check('https://www.linkedin.com/feed/', modernNav(accountPaths.slice(0,4))), false);
 assert.equal(await check('https://www.linkedin.com/feed/', modernNav(accountPaths.map(p=>'https://evil.test'+p))), false);
 assert.equal(await check('https://www.linkedin.com/feed/', '<div hidden>'+modernNav(accountPaths)+'</div>'), false);
 assert.equal(await check('https://www.linkedin.com/feed/', modernNav(accountPaths), false), false);
});
