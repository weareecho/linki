// Real Chromium, synthetic pages only. Run with --network none.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {pathToFileURL}=require('node:url');
const {registerHooks}=require('node:module');
const path=require('node:path');
registerHooks({resolve(s,c,n){if(s==='./visit'&&c.parentURL?.endsWith('/message.ts'))return n(new URL('./visit.ts',c.parentURL).href,c);return n(s,c)}});
let browser,api,visit;
const profile='https://www.linkedin.com/in/exact-fixture/';
const name='Exact Fixture';
const text='Synthetic campaign verification message';
const urn='urn:li:fsd_profile:exact-fixture';
const messageHref='/messaging/compose/?profileUrn='+encodeURIComponent(urn)+'&recipient=exact-fixture';
before(async()=>{api=await import(pathToFileURL(path.resolve('lib/linkedin/message.ts')).href);visit=await import(pathToFileURL(path.resolve('lib/linkedin/visit.ts')).href);browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox']})});
after(async()=>{await browser?.close()});
async function fixture(options={},run){
 const context=await browser.newContext();const state={sent:0,body:'',fences:0,composeUrls:[]};
 const card=`<main><section><${options.heading||'h2'}>${name}</${options.heading||'h2'}><span>${options.secondDegree?'2nd':'1st'}</span><a href="${messageHref}">Message</a><a href="${messageHref}">Message</a></section><aside><h2>Other Person</h2><a href="/messaging/compose/?profileUrn=urn:li:fsd_profile:wrong-fixture">Message</a></aside></main>`;
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());let html='';
  if(u.pathname==='/fixture-send') {state.sent++;state.body=route.request().postData();await route.fulfill({body:'ok'});return}
  if(u.pathname.startsWith('/in/'))html=options.profileHTML||card;
  else if(u.pathname==='/messaging/compose/') {
   state.composeUrls.push(u.href);
   html=`<a class="profile-card-one-to-one__profile-link" href="/in/${options.wrongRecipient?'different-fixture':'exact-fixture'}/">${name}</a><button aria-label="Remove ${name}">${name}</button>${options.group?'<button aria-label="Remove Other Person">Other</button>':''}<div class="msg-form__contenteditable" contenteditable="true">${options.draft?'existing draft':''}</div><button class="msg-form__send-button" onclick="fetch('/fixture-send',{method:'POST',body:document.querySelector('[contenteditable]').innerText}).then(()=>location.href='/messaging/thread/fixture/')">Send</button>`;
  }else if(u.pathname==='/messaging/thread/fixture/')html=options.unconfirmed?'No server confirmation':`<div class="msg-s-event-listitem__body">${state.body}</div>`;
  await route.fulfill({contentType:'text/html',body:html});
 });
 const page=await context.newPage();page.setDefaultTimeout(1500);
 try {await run(page,state)}finally{await context.close()}
}
test('H2 profile resolves only own card and accepts duplicate links to the same identity',async()=>fixture({},async(page)=>{assert.deepEqual(await visit.visitProfile(page,profile,name),{isFirstDegree:true,messagingUrn:urn})}));
test('legacy H1 profile still works',async()=>fixture({heading:'h1'},async(page)=>{assert.equal((await visit.visitProfile(page,profile,name)).messagingUrn,urn)}));
test('non-first-degree Message link never implies a connection',async()=>fixture({secondDegree:true},async(page,state)=>{assert.equal((await visit.visitProfile(page,profile,name)).isFirstDegree,false);await assert.rejects(api.sendMessage(page,name,text,profile),api.NotConnectedError);assert.equal(state.sent,0)}));
test('message ignores stale cached identity and confirms persistence after reload',async()=>fixture({},async(page,state)=>{const result=await api.sendMessage(page,name,text,profile,'urn:li:fsd_profile:wrong-fixture',()=>{state.fences++});assert.equal(result.messagingUrn,urn);assert.equal(state.sent,1);assert.equal(state.fences,1);assert.equal(new URL(state.composeUrls[0]).searchParams.get('profileUrn'),urn)}));
for(const [label,options] of [['wrong recipient',{wrongRecipient:true}],['multiple recipients',{group:true}],['existing draft',{draft:true}]])test(label+' refuses before send',async()=>fixture(options,async(page,state)=>{await assert.rejects(api.sendMessage(page,name,text,profile,null,()=>{state.fences++}));assert.equal(state.sent,0);assert.equal(state.fences,0)}));
test('an unconfirmed send is not retried or reported as success',async()=>fixture({unconfirmed:true},async(page,state)=>{await assert.rejects(api.sendMessage(page,name,text,profile,null,()=>{state.fences++}),api.MessageOutcomeUnknownError);assert.equal(state.sent,1);assert.equal(state.fences,1)}));
test('conflicting own-card identities are rejected before compose',async()=>fixture({profileHTML:`<main><section><h2>${name}</h2><span>1st</span><a href="${messageHref}">Message</a><a href="/messaging/compose/?profileUrn=urn:li:fsd_profile:wrong-fixture">Message</a></section></main>`},async(page,state)=>{await assert.rejects(api.sendMessage(page,name,text,profile));assert.equal(state.sent,0);assert.equal(state.composeUrls.length,0)}));
