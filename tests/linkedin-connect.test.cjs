// Actual Playwright DOM fixtures. Run with --network none in a disposable container.
const {test,before,after,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
let api,browser,context,page,state;
const target='https://www.linkedin.com/in/target-fixture';
const invite='/preload/custom-invite/?vanityName=target-fixture';
function dialog(){return `${state.weeklyLimit?'<div class="ip-fuse-limit-alert__warning">Synthetic weekly limit</div>':''}<div role="dialog"><p id="fixture-recipient">${state.recipientDelay?'':state.wrongDialog?'Other Fixture':'Target Fixture'}</p>${state.noteEditor?'<button onclick="window.activateNote(this)">Add a note</button><textarea id="fixture-note" hidden></textarea>':''}${state.missingSend?'':`<button data-fixture-send ${state.sendDelay?'hidden':''} onclick="window.fixtureSent().then(()=>this.closest('[role=dialog]').remove())">Send without a note</button>`}</div>`;}

function profile(){return `<aside><a aria-label="Invite Other Fixture to connect" href="/preload/custom-invite/?vanityName=other-fixture">Other first</a></aside><main><section><h1>Target Fixture</h1>${state.pending&&!state.pendingDelay?'<button aria-label="Pending">Pending</button>':state.connected?'<span>1st</span>':'<span>2nd</span>'}${state.more?`<button aria-label="More" aria-controls="own-menu" onclick="document.querySelector('#own-menu').hidden=false">More</button><div role="menu" id="own-menu" hidden><button role="menuitem" onclick="setTimeout(()=>{document.body.insertAdjacentHTML('beforeend',window.dialogHtml);window.finishDialog()},${state.dialogDelay||0})">Connect</button></div>`:`<a aria-label="Invite Target Fixture to connect" href="${state.wrongLink?'/preload/custom-invite/?vanityName=other-fixture':invite}">Connect</a>`}</section><aside><a aria-label="Invite Other Fixture to connect" href="/preload/custom-invite/?vanityName=other-fixture">Other Connect</a><button aria-label="Pending">Pending</button><button aria-label="More">More</button></aside></main>`;}
before(async()=>{
 api=await import(pathToFileURL(path.join(process.cwd(),'lib/linkedin/connect.ts')).href);
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage']});
});
after(async()=>{if(browser)await browser.close()});
beforeEach(async()=>{
 state={pending:false,sends:0,visits:[],missingSend:false,more:false};
 context=await browser.newContext();page=await context.newPage();
 await page.exposeFunction('fixtureSent',()=>{state.sends++;if(!state.unknown&&!state.blockAfterSend)state.pending=true});
 await context.route('**/*',async route=>{
  const url=route.request().url();state.visits.push(url);
  if(!route.request().isNavigationRequest())return route.abort();
  if(state.redirect&&url===target)return route.fulfill({status:200,contentType:'text/html',body:'<script>history.replaceState(null,"","/authwall")</script><main><h1>Join LinkedIn</h1></main>'});
  const markup=url.includes('custom-invite')?dialog():profile();
  return route.fulfill({status:state.blockAfterSend&&state.sends?999:200,contentType:'text/html',body:markup+`<script>
window.dialogHtml=${JSON.stringify(dialog())};
window.activateNote=(button)=>{button.hidden=true;document.querySelector("#fixture-note").hidden=false;document.querySelector("[data-fixture-send]").textContent="Send"};
window.finishDialog=()=>{
 setTimeout(()=>{const p=document.querySelector('#fixture-recipient');if(p)p.textContent=${JSON.stringify(state.wrongDialog?'Other Fixture':'Target Fixture')}},${state.recipientDelay||0});
 setTimeout(()=>{const b=document.querySelector('[data-fixture-send]');if(b)b.hidden=false},${state.sendDelay||0});
};window.finishDialog();
${state.headingDelay?`const main=document.querySelector('main');if(main){main.hidden=true;setTimeout(()=>main.hidden=false,${state.headingDelay})}`:''}
${state.pending&&state.pendingDelay?`setTimeout(()=>{const section=document.querySelector('main section');if(section)section.insertAdjacentHTML('beforeend','<button aria-label="Pending">Pending</button>')},${state.pendingDelay})`:''}
</script>`});
 });
});
afterEach(async()=>{if(context)await context.close()});
test('only the target-card invitation is used; sidebar Pending and Connect are ignored',async()=>{
 await page.goto(target);
 const oldGlobalFirst=page.locator('a[aria-label*="Invite"][aria-label*="to connect"]:visible').first();
 assert.ok((await oldGlobalFirst.getAttribute('href')).includes('other-fixture'));
 await api.sendConnectionRequest(page,target);
 assert.equal(state.sends,1);assert.equal(state.pending,true);
 assert.ok(!state.visits.some(u=>u.includes('other-fixture')));
});
test('another vanity in the own-card link is refused before any action',async()=>{
 state.wrongLink=true;await assert.rejects(api.sendConnectionRequest(page,target),api.TargetProfileMismatchError);
 assert.equal(state.sends,0);
});
test('redirect/authwall cannot pass exact target verification',async()=>{
 state.redirect=true;await assert.rejects(api.sendConnectionRequest(page,target),api.TargetProfileMismatchError);
 assert.equal(state.sends,0);
});
test('already pending target never sends another request',async()=>{
 state.pending=true;await assert.rejects(api.sendConnectionRequest(page,target),api.PendingInviteError);assert.equal(state.sends,0);
});
test('missing final send button cannot report success',async()=>{
 state.missingSend=true;await assert.rejects(api.sendConnectionRequest(page,target),e=>e instanceof api.InvitationOutcomeUnknownError&&!e.sendAttempted);assert.equal(state.sends,0);
});
test('send without positive target Pending remains unknown with no retry',async()=>{
 state.unknown=true;await assert.rejects(api.sendConnectionRequest(page,target),e=>e instanceof api.InvitationOutcomeUnknownError&&e.sendAttempted);
 assert.equal(state.sends,1);assert.equal(state.visits.filter(u=>u===target).length,2);
});
test('blocked post-send check remains unknown with no retry',async()=>{
 state.blockAfterSend=true;await assert.rejects(api.sendConnectionRequest(page,target),api.InvitationOutcomeUnknownError);assert.equal(state.sends,1);
});
test('More action uses the target-controlled menu rather than page button order',async()=>{
 state.more=true;await api.sendConnectionRequest(page,target);assert.equal(state.sends,1);
});
test('wrong dialog recipient is refused before final Send',async()=>{
 state.wrongDialog=true;await assert.rejects(api.sendConnectionRequest(page,target),api.TargetProfileMismatchError);assert.equal(state.sends,0);
});
test('unknown hold survives deleting run history and reenrollment with another ID',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE logs(target_id TEXT,message TEXT)');
 api.recordUnknownInvitationOutcome(db,'original-target',target);
 db.prepare('DELETE FROM logs').run();
 assert.equal(api.hasUnresolvedInvitationOutcome(db,'original-target'),true);
 assert.equal(api.hasUnresolvedInvitationOutcome(db,'reenrolled-target',target+'?tracking=fixture'),true);
 assert.equal(api.hasUnresolvedInvitationOutcome(db,'unrelated-target','https://www.linkedin.com/in/another-fixture'),false);
 db.close();
});
test('durable fence runs before the only send and refuses action if persistence fails',async()=>{
 let calls=0;
 await assert.rejects(api.sendConnectionRequest(page,target,()=>{calls++;throw new Error('fixture write failure')}));
 assert.equal(calls,1);assert.equal(state.sends,0);
});
test('durable fence runs exactly once before target Send',async()=>{
 let calls=0;
 await api.sendConnectionRequest(page,target,()=>{calls++;assert.equal(state.sends,0)});
 assert.equal(calls,1);assert.equal(state.sends,1);
});

test('already connected target never receives another invitation',async()=>{
 state.connected=true;await assert.rejects(api.sendConnectionRequest(page,target),api.AlreadyConnectedError);assert.equal(state.sends,0);
});
test('weekly-limit rejection stops before final Send',async()=>{
 state.weeklyLimit=true;await assert.rejects(api.sendConnectionRequest(page,target),api.WeeklyLimitError);assert.equal(state.sends,0);
});
test('delayed target-controlled More dialog waits and sends exactly once',async()=>{
 state.more=true;state.dialogDelay=150;let fences=0;
 await api.sendConnectionRequest(page,target,()=>{fences++});
 assert.equal(fences,1);assert.equal(state.sends,1);
 assert.equal(state.visits.filter(u=>u===target).length,2);
});
test('delayed recipient and final no-note control wait before the only Send',async()=>{
 state.recipientDelay=150;state.sendDelay=300;
 await api.sendConnectionRequest(page,target);
 assert.equal(state.sends,1);assert.equal(state.pending,true);
});
test('delayed profile heading and post-send Pending render without repeat navigation or action',async()=>{
 state.headingDelay=150;state.pendingDelay=300;
 await api.sendConnectionRequest(page,target);
 assert.equal(state.sends,1);assert.equal(state.visits.filter(u=>u===target).length,2);
});

const approved={note:'Hi Target, I’m Kayvon, co-founder of Echo. Would love to connect.',fullName:'Target Fixture'};
test('Echo exact approved note and recipient precede one confirmed send',async()=>{
 state.noteEditor=true;let calls=0;
 await api.sendConnectionRequest(page,target,()=>{calls++;assert.equal(state.sends,0)},approved);
 assert.equal(calls,1);assert.equal(state.sends,1);assert.equal(state.pending,true);
});
test('Echo cannot fall back to an immediate no-note More action',async()=>{
 state.more=true;let calls=0;
 await assert.rejects(api.sendConnectionRequest(page,target,()=>calls++,approved),api.TargetProfileMismatchError);
 assert.equal(calls,0);assert.equal(state.sends,0);
});
test('Echo mismatching approved full recipient cannot invite',async()=>{
 state.noteEditor=true;
 await assert.rejects(api.sendConnectionRequest(page,target,undefined,{...approved,fullName:'Other Fixture'}),api.TargetProfileMismatchError);
 assert.equal(state.sends,0);
});
test('Echo without Add a note never sends without a note',async()=>{
 await assert.rejects(api.sendConnectionRequest(page,target,undefined,approved),api.TargetProfileMismatchError);
 assert.equal(state.sends,0);
});
test('Echo revoked or unavailable action-time claim prevents Send',async()=>{
 state.noteEditor=true;let calls=0;
 await assert.rejects(api.sendConnectionRequest(page,target,()=>{calls++;throw new Error('Synthetic revoked approval')},approved));
 assert.equal(calls,1);assert.equal(state.sends,0);
});
test('Echo recipient changed during awaited eligibility check cannot send',async()=>{
 state.noteEditor=true;
 await assert.rejects(api.sendConnectionRequest(page,target,async()=>{
   await page.locator('#fixture-recipient').evaluate(p=>p.textContent='Other Fixture');
 },approved),api.TargetProfileMismatchError);
 assert.equal(state.sends,0);
});
test('Echo note changed during awaited eligibility check cannot send',async()=>{
 state.noteEditor=true;
 await assert.rejects(api.sendConnectionRequest(page,target,async()=>{
   await page.locator('#fixture-note').fill('Different unapproved note');
 },approved),api.TargetProfileMismatchError);
 assert.equal(state.sends,0);
});
