// Actual guard/CSV/runner code with in-memory SQLite; provider boundaries are
// isolated. Playwright action behavior is covered by linkedin-connect.test.cjs.
const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const ts=require('typescript');
const Database=require('better-sqlite3');
function load(file,stubs={},extra='') {
 const source=fs.readFileSync(path.join(process.cwd(),file),'utf8')+extra;
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const module={exports:{}};
 vm.runInNewContext(js,{module,exports:module.exports,require:id=>id in stubs?stubs[id]:require(id),process,URL,AbortSignal,fetch:(...args)=>global.fetch(...args),global,console,Date,setTimeout,clearTimeout},{filename:file});
 return module.exports;
}
const guard=load('lib/linkedin/echo-guard.ts');
const connect=load('lib/linkedin/connect.ts');
const csv=load('lib/csv-import.ts');
const fingerprint='a'.repeat(64),note='Hi Ada, I’m Kayvon, co-founder of Echo. Would love to connect.';
const notes=`Echo reservation ${fingerprint}; approved connection note: ${note}`;
const data={list_id:'fixture-list',account_id:'fixture-account',profile:'https://www.linkedin.com/in/ada',full_name:'Ada Lovelace',company:'Analytical Engines'};
let db,oldFetch,oldURL,oldSecret,modes,actions,pages,denyMode,runner;
beforeEach(()=>{
 oldFetch=global.fetch;oldURL=process.env.ECHO_GUARD_URL;oldSecret=process.env.INTERNAL_API_SECRET;
 process.env.ECHO_GUARD_URL='http://127.0.0.1:3457/echo/action';process.env.INTERNAL_API_SECRET='synthetic-existing-secret';
 modes=[];actions=0;pages=0;denyMode=null;
 global.fetch=async(url,opts)=>{
   const payload=JSON.parse(opts.body);modes.push(payload.mode);
   assert.equal(payload.account_id,data.account_id);assert.equal(payload.note,note);
   return {ok:true,json:async()=>({allowed:payload.mode!==denyMode})};
 };
 db=new Database(':memory:');
 db.exec(`CREATE TABLE targets(id TEXT PRIMARY KEY,linkedin_url TEXT UNIQUE,email TEXT,sales_nav_url TEXT,full_name TEXT,first_name TEXT,last_name TEXT,title TEXT,company TEXT,location TEXT,city TEXT,country TEXT,phone TEXT,headline TEXT,summary TEXT,notes TEXT,degree INTEGER,last_replied_at TEXT,email_replied_at TEXT,connection_requested_at TEXT,connected_at TEXT);
 CREATE TABLE list_targets(list_id TEXT,target_id TEXT,UNIQUE(list_id,target_id));
 CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE workflows(id TEXT PRIMARY KEY,name TEXT);
 CREATE TABLE runs(id TEXT PRIMARY KEY,list_id TEXT,status TEXT);
 CREATE TABLE run_profile_tracks(id TEXT PRIMARY KEY,run_profile_id TEXT,state TEXT,current_step INTEGER,last_step_at TEXT,next_step_at TEXT,error_message TEXT);
 CREATE TABLE logs(id TEXT,run_id TEXT,target_id TEXT,level TEXT,message TEXT);`);
 db.prepare('INSERT INTO targets(id,linkedin_url,full_name,company,notes,degree) VALUES (?,?,?,?,?,2)').run('fixture-target',data.profile,data.full_name,data.company,notes);
 db.prepare('INSERT INTO workflows VALUES (?,?)').run('fixture-workflow','Ordinary fixture');
 db.prepare('INSERT INTO runs VALUES (?,?,?)').run('fixture-run',data.list_id,'running');
 db.prepare('INSERT INTO run_profile_tracks(id,run_profile_id,state,current_step) VALUES (?,?,?,0)').run('fixture-track','fixture-profile','pending');
 const boundary=async()=>{throw new Error('Unexpected provider/enrichment boundary')};
 runner=load('lib/linkedin/runner.ts',{
  '@/lib/db':{getDb:()=>db},
  '@/lib/linkedin/echo-guard':guard,
  '@/lib/linkedin/connect':{...connect,sendConnectionRequest:async(page,url,before,approved)=>{assert.deepEqual(JSON.parse(JSON.stringify(approved)),{note,fullName:data.full_name});await before();actions++;}},
  '@/lib/linkedin/session':{getSessionPage:async()=>{pages++;return {close:async()=>{}}},saveSessionState:async()=>{},getSessionContext:boundary},
  '@/lib/linkedin/visit':{visitProfile:boundary},'@/lib/linkedin/message':{sendMessage:boundary},
  '@/lib/linkedin/sync-accepted':{},'@/lib/email/sender':{sendEmail:boundary},'@/lib/email/inbox':{},
  '@/lib/linkedin/enrich':{enrichProfile:boundary},'@/lib/apollo':{matchPerson:boundary},'@/lib/premium':{},'@/lib/crypto':{},
 },'\nexports.fixtureExecuteStep = executeStep;');
});
afterEach(()=>{db.close();global.fetch=oldFetch;for(const [key,value] of [['ECHO_GUARD_URL',oldURL],['INTERNAL_API_SECRET',oldSecret]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
const scope=()=>guard.parseEchoScope(notes,data);
const track={id:'fixture-track',run_profile_id:'fixture-profile',workflow_id:'fixture-workflow',current_step:0};
async function execute(type='connect') {
 const target=db.prepare('SELECT * FROM targets').get();
 await runner.fixtureExecuteStep(db,'fixture-run',track,target,[{step_type:type,delay_seconds:0}],data.account_id,{active_hours_start:0,active_hours_end:24,timezone:'UTC',working_days:'0,1,2,3,4,5,6'});
}
for(const bad of ['', 'Echo reservation bad',`Echo reservation ${fingerprint}; approved connection note: ${'x'.repeat(201)}`])test('invalid scope is held: '+bad.length,()=>assert.throws(()=>guard.parseEchoScope(bad,data),guard.EchoEligibilityError));
for(const url of ['https://public.example/echo/action','http://127.0.0.1/other','http://user:pass@localhost/echo/action','http://localhost/echo/action?q=1','http://localhost/echo/action#x'])test('secret never dispatched to unapproved guard URL '+url,async()=>{
 process.env.ECHO_GUARD_URL=url;let calls=0;
 await assert.rejects(guard.assertEchoEligible(scope(),'claim',async()=>{calls++}),guard.EchoEligibilityError);assert.equal(calls,0);
});
test('local guard uses one authenticated no-redirect request without retry',async()=>{
 let calls=0;await guard.assertEchoEligible(scope(),'claim',async(url,opts)=>{calls++;assert.equal(opts.headers['x-internal-secret'],'synthetic-existing-secret');assert.equal(opts.redirect,'error');assert.equal(opts.cache,'no-store');assert.equal(JSON.parse(opts.body).fingerprint,fingerprint);return {ok:true,json:async()=>({allowed:true})}});assert.equal(calls,1);
});
for(const failure of ['timeout','bad_json','denied','http_error'])test('uncertain guard is fail closed '+failure,async()=>{
 let calls=0;await assert.rejects(guard.assertEchoEligible(scope(),'claim',async()=>{calls++;if(failure==='timeout')throw new Error('Synthetic timeout');return {ok:failure!=='http_error',json:async()=>{if(failure==='bad_json')throw new Error('bad');return {allowed:false}}}}),guard.EchoEligibilityError);assert.equal(calls,1);
});
test('CSV preserves original managed scope despite notes clearing and changed reimport',()=>{
 const row=(value)=>require('papaparse').unparse([{linkedin_url:data.profile,first_name:'Ada',last_name:'Lovelace',company:data.company,notes:value}]);
 csv.importCsv(db,data.list_id,row(notes));
 db.prepare('UPDATE targets SET notes=NULL').run();
 csv.importCsv(db,data.list_id,row(notes.replace(fingerprint,'b'.repeat(64))));
 assert.equal(db.prepare('SELECT value FROM app_settings WHERE key=?').get('echo-scope:fixture-target').value,notes);
});
for(const type of ['message','inmail','email'])test('Echo runner blocks unauthorized '+type+' before enrichment/provider access',async()=>{
 await execute(type);assert.equal(actions,0);assert.equal(pages,0);assert.equal(db.prepare('SELECT status FROM runs').get().status,'paused');
});
test('runner rechecks claim immediately before action; revocation after initial check prevents Send',async()=>{
 denyMode='claim';await execute();assert.deepEqual(modes,['check','claim']);assert.equal(actions,0);assert.equal(db.prepare('SELECT status FROM runs').get().status,'paused');
});
test('successful guarded initial connection completes with no followup',async()=>{
 await execute();assert.deepEqual(modes,['check','claim','complete']);assert.equal(actions,1);assert.equal(db.prepare('SELECT state FROM run_profile_tracks').get().state,'completed');assert.equal(db.prepare("SELECT COUNT(*) AS c FROM app_settings WHERE key LIKE 'invitation-unknown:%'").get().c,0);
});
test('completion uncertainty keeps durable hold and cannot resend',async()=>{
 denyMode='complete';await execute();assert.equal(actions,1);assert.ok(connect.hasUnresolvedInvitationOutcome(db,'fixture-target',data.profile));await execute();assert.equal(actions,1);assert.equal(db.prepare('SELECT status FROM runs').get().status,'paused');
});
test('cleared editable notes do not bypass durable Echo origin',async()=>{
 db.prepare('INSERT INTO app_settings VALUES (?,?)').run('echo-scope:fixture-target',notes);db.prepare('UPDATE targets SET notes=NULL').run();await execute('email');assert.equal(actions,0);assert.equal(pages,0);assert.equal(db.prepare('SELECT status FROM runs').get().status,'paused');
});
test('unscoped Echo workflow is held before provider access',async()=>{
 db.prepare('UPDATE workflows SET name=?').run('Echo outreach');db.prepare('UPDATE targets SET notes=NULL').run();await execute();assert.equal(actions,0);assert.equal(pages,0);assert.equal(db.prepare('SELECT status FROM runs').get().status,'paused');
});
