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
const schedule=load('lib/linkedin/schedule.ts');
const guard=load('lib/linkedin/echo-guard.ts',{'./readiness-artifact':{BUILT_GUARD_REVISION:''}});
const connect=load('lib/linkedin/connect.ts');
const csv=load('lib/csv-import.ts');
const fingerprint='a'.repeat(64),note='Hi Ada, I’m Kayvon, co-founder of Echo. Would love to connect.';
const notes=`Echo reservation ${fingerprint}; approved connection note: ${note}`;
const data={list_id:'fixture-list',account_id:'fixture-account',profile:'https://www.linkedin.com/in/ada',full_name:'Ada Lovelace',company:'Analytical Engines'};
let db,oldFetch,oldURL,oldSecret,modes,actions,pages,denyMode,runner,connectFailure,guardReply,visits;
beforeEach(()=>{
 oldFetch=global.fetch;oldURL=process.env.ECHO_GUARD_URL;oldSecret=process.env.INTERNAL_API_SECRET;
 process.env.ECHO_GUARD_URL='http://127.0.0.1:3457/echo/action';process.env.INTERNAL_API_SECRET='synthetic-existing-secret';
 modes=[];actions=0;pages=0;denyMode=null;connectFailure=null;guardReply=null;visits=0;
 global.fetch=async(url,opts)=>{
   const payload=JSON.parse(opts.body);modes.push(payload.mode);
   assert.equal(payload.account_id,data.account_id);assert.equal(payload.note,note);
   if(guardReply)return guardReply(payload);
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
  '@/lib/linkedin/schedule':schedule,
  '@/lib/db':{getDb:()=>db},
  '@/lib/linkedin/echo-guard':guard,
  '@/lib/linkedin/readiness-artifact':{recordExecutorStarted:()=>{},recordExecutorStopped:()=>{}},
  '@/lib/linkedin/connect':{...connect,sendConnectionRequest:async(page,url,before,approved)=>{assert.deepEqual(JSON.parse(JSON.stringify(approved)),{note,fullName:data.full_name});if(connectFailure)throw connectFailure;await before();actions++;}},
  '@/lib/linkedin/session':{getSessionPage:async()=>{pages++;return {close:async()=>{}}},saveSessionState:async()=>{},getSessionContext:boundary,markNeedsReauth:boundary},
  '@/lib/linkedin/session-state':load('lib/linkedin/session-state.ts'),
  '@/lib/linkedin/visit':{visitProfile:async()=>{visits++;return {isFirstDegree:false,messagingUrn:null}}},'@/lib/linkedin/message':{sendMessage:boundary},
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
test('note invitation unavailable pauses the whole run before the next person; no claim, hold or failed track',async()=>{
 connectFailure=new connect.NoteInvitationUnavailableError('Unique Add a note control absent; stop.');
 await execute();
 assert.deepEqual(modes,['check']);assert.equal(actions,0);
 assert.equal(db.prepare('SELECT status FROM runs').get().status,'paused');
 assert.notEqual(db.prepare('SELECT state FROM run_profile_tracks').get().state,'failed');
 assert.equal(connect.hasUnresolvedInvitationOutcome(db,'fixture-target',data.profile),false);
});
test('cleared editable notes do not bypass durable Echo origin',async()=>{
 db.prepare('INSERT INTO app_settings VALUES (?,?)').run('echo-scope:fixture-target',notes);db.prepare('UPDATE targets SET notes=NULL').run();await execute('email');assert.equal(actions,0);assert.equal(pages,0);assert.equal(db.prepare('SELECT status FROM runs').get().status,'paused');
});
test('unscoped Echo workflow is held before provider access',async()=>{
 db.prepare('UPDATE workflows SET name=?').run('Echo outreach');db.prepare('UPDATE targets SET notes=NULL').run();await execute();assert.equal(actions,0);assert.equal(pages,0);assert.equal(db.prepare('SELECT status FROM runs').get().status,'paused');
});

test('guard waits long enough for the bridge production DB checks, still one request',async()=>{
 assert.equal(guard.ECHO_GUARD_TIMEOUT_MS,30000);
 let calls=0,signal=null;
 await assert.rejects(guard.assertEchoEligible(scope(),'check',async(url,options)=>{calls++;signal=options.signal;throw new Error('Synthetic abort')}),guard.EchoEligibilityError);
 assert.equal(calls,1);assert.ok(signal&&typeof signal.aborted==='boolean');
});

// Classification: an unanswered check is retryable; a refusal or a denial is not.
for(const [label,reply,unavailable,reason] of [
 ['transport failure',async()=>{throw new Error('Synthetic ECONNREFUSED')},true,'guard_unreachable'],
 ['bridge 503',async()=>({ok:false,status:503,json:async()=>({})}),true,'guard_http_unavailable'],
 ['bridge 502',async()=>({ok:false,status:502,json:async()=>({})}),true,'guard_http_unavailable'],
 ['bridge 500',async()=>({ok:false,status:500,json:async()=>({})}),false,'guard_http_refused'],
 ['bridge 501',async()=>({ok:false,status:501,json:async()=>({})}),false,'guard_http_refused'],
 ['timeout',async()=>{throw Object.assign(new Error('Synthetic'),{name:'TimeoutError'})},true,'guard_unreachable'],
 ['denial without a reason',async()=>({ok:true,json:async()=>({allowed:false})}),false,'denied'],
 ['fetcher returned nothing',async()=>undefined,false,'uncertain'],
 ['unreadable body',async()=>({ok:true,json:async()=>{throw new Error('bad')}}),true,'guard_unreadable'],
 ['bridge DB check failed',async()=>({ok:true,json:async()=>({allowed:false,reason:'guard_unavailable_or_uncertain'})}),true,'guard_unavailable_or_uncertain'],
 ['secret refused',async()=>({ok:false,status:403,json:async()=>({})}),false,'guard_http_refused'],
 ['person denial',async()=>({ok:true,json:async()=>({allowed:false,reason:'reply_recorded'})}),false,'reply_recorded'],
 ['scope denial',async()=>({ok:true,json:async()=>({allowed:false,reason:'approval_missing'})}),false,'approval_missing'],
 ['odd reason text',async()=>({ok:true,json:async()=>({allowed:false,reason:'Ada <ada@x>'})}),false,'denied'],
 ['allowed not exactly true',async()=>({ok:true,json:async()=>({allowed:'yes'})}),false,'denied'],
])test('guard answer classified: '+label,async()=>{
 const error=await guard.assertEchoEligible(scope(),'check',reply).then(()=>null,e=>e);
 assert.ok(error instanceof guard.EchoEligibilityError);
 assert.equal(error instanceof guard.EchoGuardUnavailableError,unavailable);
 assert.equal(error.reason,reason);
});
const trackRow=()=>db.prepare('SELECT state,next_step_at,error_message FROM run_profile_tracks').get();
const runStatus=()=>db.prepare('SELECT status FROM runs').get().status;
const retryCount=()=>db.prepare("SELECT value FROM app_settings WHERE key='echo-guard-retry:fixture-track'").get()?.value;
const unanswered=async()=>({ok:true,json:async()=>({allowed:false,reason:'guard_unavailable_or_uncertain'})});
test('unanswered pre-action check waits and asks again; the run keeps going',async()=>{
 guardReply=unanswered;const before=Date.now();
 await execute();
 assert.deepEqual(modes,['check']);assert.equal(actions,0);assert.equal(pages,0);
 assert.equal(runStatus(),'running');
 const row=trackRow();assert.notEqual(row.state,'failed');
 const wait=Date.parse(row.next_step_at)-before;assert.ok(wait>=3590_000&&wait<=3610_000,String(wait));
 assert.equal(retryCount(),'1');
 assert.match(db.prepare("SELECT message FROM logs WHERE level='warn'").get().message,/no answer \(guard_unavailable_or_uncertain\); nothing done/);
});
test('a check that answers after a retry proceeds normally and clears the count',async()=>{
 guardReply=unanswered;await execute();guardReply=null;await execute();
 assert.deepEqual(modes,['check','check','claim','complete']);assert.equal(actions,1);
 assert.equal(trackRow().state,'completed');assert.equal(retryCount(),undefined);
});
test('still unanswered after every retry: held for the owner like before',async()=>{
 guardReply=unanswered;
 for(let i=0;i<3;i++){await execute();assert.equal(runStatus(),'running');}
 await execute();
 assert.equal(runStatus(),'paused');assert.equal(trackRow().state,'failed');assert.equal(actions,0);assert.equal(pages,0);
 assert.equal(retryCount(),undefined);
 assert.match(db.prepare("SELECT message FROM logs WHERE level='error'").get().message,/guard_unavailable_or_uncertain\) — pausing run/);
});
test("a denial about this person's own outreach stops only them",async()=>{
 guardReply=async()=>({ok:true,json:async()=>({allowed:false,reason:'reply_recorded'})});
 await execute();
 assert.equal(runStatus(),'running');assert.equal(trackRow().state,'failed');assert.match(trackRow().error_message,/reply_recorded/);
 assert.equal(actions,0);assert.equal(pages,0);assert.deepEqual(modes,['check']);
});
for(const reason of ['approval_missing','identity_or_copy_changed','enrollment_not_eligible','request_already_claimed_or_done'])test('any other denial still holds the whole run: '+reason,async()=>{
 guardReply=async()=>({ok:true,json:async()=>({allowed:false,reason})});
 await execute();
 assert.equal(runStatus(),'paused');assert.equal(trackRow().state,'failed');assert.equal(actions,0);assert.equal(pages,0);
});
test('a refused secret is not retried',async()=>{
 guardReply=async()=>({ok:false,status:403,json:async()=>({})});
 await execute();assert.equal(runStatus(),'paused');assert.equal(retryCount(),undefined);
});
test('an unanswered claim is never retried: Send is not clicked and the run holds',async()=>{
 guardReply=async(payload)=>payload.mode==='claim'?unanswered():({ok:true,json:async()=>({allowed:true})});
 await execute();
 assert.deepEqual(modes,['check','claim']);assert.equal(actions,0);
 assert.equal(runStatus(),'paused');assert.equal(trackRow().state,'failed');
});
test('a visit step is checked before LinkedIn is opened, and visits only once allowed',async()=>{
 guardReply=unanswered;await execute('visit');
 assert.equal(visits,0);assert.equal(pages,0);assert.equal(runStatus(),'running');
 guardReply=null;await execute('visit');
 assert.equal(visits,1);assert.deepEqual(modes,['check','check']);assert.equal(retryCount(),undefined);
});
test('an unset guard URL at check holds at once, without retrying',async()=>{
 delete process.env.ECHO_GUARD_URL;
 await execute();assert.equal(runStatus(),'paused');assert.equal(retryCount(),undefined);assert.equal(pages,0);
});
test('a run-wide hold clears the retry count, so a manual retry starts afresh',async()=>{
 guardReply=unanswered;await execute();await execute();assert.equal(retryCount(),'2');
 guardReply=async()=>({ok:true,json:async()=>({allowed:false,reason:'approval_missing'})});
 await execute();assert.equal(runStatus(),'paused');assert.equal(retryCount(),undefined);
});
test('if the retry bookkeeping cannot be written, the run holds instead',async()=>{
 db.exec("CREATE TRIGGER no_retry BEFORE INSERT ON app_settings WHEN NEW.key LIKE 'echo-guard-retry:%' BEGIN SELECT RAISE(ABORT,'synthetic busy'); END;");
 guardReply=unanswered;await execute();
 assert.equal(runStatus(),'paused');assert.equal(trackRow().state,'failed');assert.equal(actions,0);assert.equal(pages,0);
});
const personDenial=async()=>({ok:true,json:async()=>({allowed:false,reason:'opt_out_recorded'})});
test('a second person denial in a row looks systemic and holds the run',async()=>{
 guardReply=personDenial;await execute();assert.equal(runStatus(),'running');
 await execute();assert.equal(runStatus(),'paused');assert.equal(actions,0);
 assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='echo-person-denials:fixture-run'").get(),undefined);
});
test('an allowed check between two person denials resets the streak',async()=>{
 guardReply=personDenial;await execute();
 guardReply=null;await execute();assert.equal(actions,1);
 guardReply=personDenial;await execute();assert.equal(runStatus(),'running');
});
test('a person denial at claim is never softened: Send is not clicked and the run holds',async()=>{
 guardReply=async(payload)=>payload.mode==='claim'?personDenial():({ok:true,json:async()=>({allowed:true})});
 await execute();
 assert.deepEqual(modes,['check','claim']);assert.equal(actions,0);assert.equal(runStatus(),'paused');
});
