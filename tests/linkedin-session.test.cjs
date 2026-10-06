// Offline actual-module tests: no real browser, network, account or credential.
const {test,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const {registerHooks}=require('node:module');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
registerHooks({resolve(s,c,n){
 const mocks={
  'playwright-extra':'export const chromium={use(){},async launch(){return globalThis.sessionFixture.browser}};',
  'puppeteer-extra-plugin-stealth':'export default function(){return {}};',
  '@/lib/db':'export function getDb(){return globalThis.sessionFixture.db};',
  '@/lib/crypto':'export function encryptSecret(v){return "fixture-encrypted:"+v};export function decryptSecret(v){if(v==="broken")throw Error("fixture decrypt failure");return v};',
 };
 if(mocks[s])return {url:'data:text/javascript,'+encodeURIComponent(mocks[s]),shortCircuit:true};
 if(s.startsWith('@/'))return n(pathToFileURL(path.join(root,s.slice(2)+'.ts')).href,c);
 return n(s,c);
}});
let api,guard,f;
const valid=()=>({cookies:[{name:'li_at',value:'synthetic-fixture-only',domain:'.linkedin.com',path:'/',expires:Date.now()/1000+3600}],origins:[]});
beforeEach(async()=>{
 f=globalThis.sessionFixture={state:valid(),stored:JSON.stringify(valid()),visibleNav:true,url:'https://www.linkedin.com/feed/',writes:[],navigations:[],contexts:0};
 const locator={first(){return this},async count(){return 0},async waitFor(){},async fill(){},async press(){},async isVisible(){return f.visibleNav}};
 f.page={url:()=>f.url,context:()=>f.ctx,locator:()=>locator,getByText:()=>({async count(){return 0}}),async goto(url){f.navigations.push(url)},async waitForLoadState(){},async waitForTimeout(){},async close(){}};
 f.ctx={storageState:async()=>f.state,newPage:async()=>f.page,on(){},async close(){}};
 f.browser={isConnected:()=>true,async newContext(){globalThis.sessionFixture.contexts++;return globalThis.sessionFixture.ctx},async close(){}};
 f.db={prepare(){return {get:()=>({email:'owner@example.test',cookies_json:f.stored}),run:(...values)=>f.writes.push(values)}}};
 api=await import(pathToFileURL(path.join(root,'lib/linkedin/session.ts')).href);
 guard=await import(pathToFileURL(path.join(root,'lib/linkedin/session-state.ts')).href);
 await api.closeSession('fixture');
});
test('state validator rejects missing/blank/expired/foreign credentials',()=>{
 for(const state of [undefined,{}, {cookies:[],origins:[]}, {...valid(),origins:null},
  {cookies:[{...valid().cookies[0],value:''}],origins:[]},
  {cookies:[{...valid().cookies[0],expires:1}],origins:[]},
  {cookies:[{...valid().cookies[0],domain:'.linkedin.com.evil.test'}],origins:[]}])assert.equal(guard.hasUsableLinkedInState(state),false);
 assert.equal(guard.hasUsableLinkedInState(valid()),true);
 assert.equal(guard.hasUsableLinkedInState({cookies:[{...valid().cookies[0],expires:-1}],origins:[]}),true);
});
test('decrypt failure and cookie-less saved state never create an empty context or rewrite DB',async()=>{
 for(const value of ['broken',null,JSON.stringify({cookies:[],origins:[]})]){
  f.stored=value;await assert.rejects(api.getSessionContext('fixture'),{name:'LinkedInSessionUnavailableError'});
 }
 assert.equal(f.contexts,0);assert.equal(f.navigations.length,0);assert.equal(f.writes.length,0);
});
test('URL-only guest success refuses authentication and does not persist',async()=>{
 f.state={cookies:[],origins:[]};const result=await api.startHeadlessLogin('fixture','owner@example.test','synthetic-password');
 assert.equal(result.status,'error');assert.equal(f.writes.length,0);
 assert.deepEqual(f.navigations,['https://www.linkedin.com/login']);
});
test('cookie without positive signed-in navigation does not authenticate',async()=>{
 f.visibleNav=false;assert.equal((await api.startHeadlessLogin('fixture','owner@example.test','synthetic-password')).status,'error');
 assert.equal(f.writes.length,0);
});
test('verified regular login persists before any optional Sales Nav navigation',async()=>{
 assert.equal((await api.startHeadlessLogin('fixture','owner@example.test','synthetic-password')).status,'authenticated');
 assert.equal(f.writes.length,1);assert.equal(f.writes[0][1],'fixture');
 assert.deepEqual(f.navigations,['https://www.linkedin.com/login']);
 assert.ok(f.writes[0][0].includes('synthetic-fixture-only'));
});
test('later guest state cannot overwrite previously saved credentials or set Auth',async()=>{
 await api.getSessionContext('fixture');f.state={cookies:[],origins:[]};
 await assert.rejects(api.saveSessionState('fixture'),{name:'LinkedInSessionUnavailableError'});
 assert.equal(f.writes.length,0);await api.closeSession('fixture');
});
test('login location guards host/path and redacts all challenge/redirect details',()=>{
 for(const url of ['https://evil.test/feed/','https://www.linkedin.com/login?next=/feed/','https://www.linkedin.com/salesforce/'])assert.equal(guard.isLinkedInLoginLanding(url),false);
 assert.equal(guard.isLinkedInLoginLanding('https://www.linkedin.com/feed/'),true);
 assert.equal(guard.loginLocation('https://www.linkedin.com/checkpoint/challengesV2/synthetic-secret?code=synthetic-secret'),'/checkpoint');
});
