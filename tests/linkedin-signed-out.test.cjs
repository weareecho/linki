// Actual runner code with in-memory SQLite: a sign-in page is about the account,
// never about the person. No browser, network, account or credential.
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
const state=load('lib/linkedin/session-state.ts');
const connect=load('lib/linkedin/connect.ts');
const profile='https://www.linkedin.com/in/ada';
const signedIn={cookies:[{name:'li_at',value:'synthetic-fixture-only',domain:'.linkedin.com',path:'/',expires:-1}],origins:[]};
let db,runner,f;
const boundary=async()=>{throw new Error('Unexpected provider boundary')};
beforeEach(()=>{
 f={pageUrl:profile,cookies:signedIn,flagged:false,reauthChecks:0,claims:0,visit:null,connect:null,save:async()=>{},sessionPage:null};
 db=new Database(':memory:');
 db.exec(`CREATE TABLE targets(id TEXT PRIMARY KEY,linkedin_url TEXT UNIQUE,email TEXT,sales_nav_url TEXT,full_name TEXT,first_name TEXT,last_name TEXT,title TEXT,company TEXT,location TEXT,notes TEXT,degree INTEGER,last_replied_at TEXT,email_replied_at TEXT,connection_requested_at TEXT,connected_at TEXT,messaging_urn TEXT);
 CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE workflows(id TEXT PRIMARY KEY,name TEXT);
 CREATE TABLE runs(id TEXT PRIMARY KEY,list_id TEXT,status TEXT);
 CREATE TABLE run_profile_tracks(id TEXT PRIMARY KEY,run_profile_id TEXT,state TEXT,current_step INTEGER,last_step_at TEXT,next_step_at TEXT,error_message TEXT);
 CREATE TABLE logs(id TEXT,run_id TEXT,target_id TEXT,level TEXT,message TEXT);`);
 db.prepare('INSERT INTO targets(id,linkedin_url,full_name,company,degree) VALUES (?,?,?,?,2)').run('t',profile,'Ada Lovelace','Analytical Engines');
 db.prepare('INSERT INTO workflows VALUES (?,?)').run('w','Ordinary fixture');
 db.prepare('INSERT INTO runs VALUES (?,?,?)').run('r','l','running');
 db.prepare('INSERT INTO run_profile_tracks(id,run_profile_id,state,current_step) VALUES (?,?,?,0)').run('tr','rp','pending');
 const page={url:()=>f.pageUrl,context:()=>({storageState:async()=>f.cookies}),close:async()=>{}};
 runner=load('lib/linkedin/runner.ts',{
  '@/lib/linkedin/schedule':load('lib/linkedin/schedule.ts'),
  '@/lib/db':{getDb:()=>db},
  '@/lib/linkedin/echo-guard':load('lib/linkedin/echo-guard.ts',{'./readiness-artifact':{BUILT_GUARD_REVISION:''}}),
  '@/lib/linkedin/readiness-artifact':{recordExecutorStarted:()=>{},recordExecutorStopped:()=>{}},
  '@/lib/linkedin/connect':{...connect,sendConnectionRequest:async(pg,url,before)=>f.connect(before)},
  '@/lib/linkedin/session':{
   getSessionPage:async()=>{if(f.sessionPage)throw f.sessionPage;return page},
   saveSessionState:async()=>f.save(),getSessionContext:boundary,
   markNeedsReauth:async()=>{f.reauthChecks++;return f.flagged}},
  '@/lib/linkedin/session-state':state,
  '@/lib/linkedin/visit':{visitProfile:async()=>f.visit()},'@/lib/linkedin/message':{sendMessage:boundary},
  '@/lib/linkedin/sync-accepted':{},'@/lib/email/sender':{sendEmail:boundary},'@/lib/email/inbox':{},
  '@/lib/linkedin/enrich':{enrichProfile:boundary},'@/lib/apollo':{matchPerson:boundary},'@/lib/premium':{},'@/lib/crypto':{},
 },'\nexports.fixtureExecuteStep = executeStep;');
});
afterEach(()=>db.close());
const allDay={active_hours_start:0,active_hours_end:24,timezone:'UTC',working_days:'0,1,2,3,4,5,6'};
async function execute(type){
 const target=db.prepare('SELECT * FROM targets').get();
 await runner.fixtureExecuteStep(db,'r',{id:'tr',run_profile_id:'rp',workflow_id:'w',current_step:0},target,[{step_type:type,delay_seconds:0}],'a',{...allDay,daily_connection_limit:15,daily_message_limit:0,daily_inmail_limit:0});
}
const trackRow=()=>db.prepare('SELECT state,error_message,next_step_at FROM run_profile_tracks').get();
const lastLog=()=>db.prepare('SELECT level,message FROM logs ORDER BY rowid DESC').get();
function assertKept(){
 const row=trackRow();
 assert.equal(row.state,'pending');assert.equal(row.error_message,null);
 const wait=new Date(row.next_step_at).getTime()-Date.now();
 assert.ok(wait>55*60_000&&wait<=60*60_000,'retries in about an hour');
 assert.equal(db.prepare('SELECT status FROM runs').get().status,'running');
}

test('isSignInWall knows LinkedIn sign-in, guest and checkpoint pages only',()=>{
 for(const url of ['https://www.linkedin.com/login','https://www.linkedin.com/authwall?trk=x','https://linkedin.com/checkpoint/challenge/x','https://www.linkedin.com/uas/login','https://www.linkedin.com/signup/cold-join'])assert.equal(state.isSignInWall(url),true,url);
 for(const url of ['https://www.linkedin.com/feed/','https://www.linkedin.com/in/login','https://evil.test/login','https://www.linkedin.com/loginx','not a url'])assert.equal(state.isSignInWall(url),false,url);
});
test('a visit that lands on a sign-in page keeps the person for retry and asks LinkedIn',async()=>{
 f.pageUrl='https://www.linkedin.com/authwall?trk=synthetic';f.visit=async()=>{throw new Error('LinkedIn did not load the exact target profile')};
 await execute('visit');
 assertKept();assert.equal(f.reauthChecks,1);
 assert.match(lastLog().message,/saved login still works, retrying in 1h/);
});
test('a guest view that drops the login cookie is a sign-in page too',async()=>{
 f.cookies={cookies:[],origins:[]};f.visit=async()=>{throw new Error('Target profile card is absent or ambiguous')};
 await execute('visit');
 assertKept();assert.equal(f.reauthChecks,1);
});
test('a confirmed sign-out moves the person to a random slot on the next working day',async()=>{
 f.flagged=true;f.pageUrl='https://www.linkedin.com/login';f.visit=async()=>{throw new Error('LinkedIn did not load the exact target profile')};
 await execute('visit');
 const row=trackRow();assert.equal(row.state,'pending');assert.equal(row.error_message,null);
 assert.ok(row.next_step_at.slice(0,10)>new Date().toISOString().slice(0,10),'next working day');
 assert.equal(db.prepare('SELECT status FROM runs').get().status,'running');
 assert.match(lastLog().message,/after the next login \(Settings > Server login\)/);
});
test('a lost saved session (no usable cookie, or one LinkedIn removed during the visit) keeps the person',async()=>{
 f.sessionPage=new state.LinkedInSessionUnavailableError();
 await execute('visit');assertKept();assert.equal(f.reauthChecks,1);
 f.sessionPage=null;db.prepare("UPDATE run_profile_tracks SET next_step_at=NULL").run();
 f.visit=async()=>({isFirstDegree:false,messagingUrn:null});f.save=async()=>{throw new state.LinkedInSessionUnavailableError()};
 await execute('visit');assertKept();assert.equal(f.reauthChecks,2);
});
test('an ordinary failure on a signed-in page still fails the person without a login check',async()=>{
 f.visit=async()=>{throw new Error('Target profile heading is ambiguous')};
 await execute('visit');
 assert.equal(trackRow().state,'failed');assert.equal(f.reauthChecks,0);
});
test('a connect step that meets a sign-in page before any claim keeps the person',async()=>{
 f.pageUrl='https://www.linkedin.com/checkpoint/challenge/synthetic';
 f.connect=async()=>{throw new connect.TargetProfileMismatchError('Exact target profile was not reached; stop.')};
 await execute('connect');
 assertKept();assert.equal(f.reauthChecks,1);
 assert.equal(db.prepare("SELECT COUNT(*) AS c FROM app_settings WHERE key LIKE 'invitation-unknown:%'").get().c,0);
});
test('after a claim started, a sign-in page never turns a doubtful send into a retry',async()=>{
 f.pageUrl='https://www.linkedin.com/login';
 f.connect=async before=>{await before();throw new connect.TargetProfileMismatchError('Invitation recipient or controls changed during eligibility check; stop.')};
 await execute('connect');
 assert.equal(trackRow().state,'failed');assert.equal(f.reauthChecks,0);
 assert.equal(connect.hasUnresolvedInvitationOutcome(db,'t',profile),true);
});
test('a confirmed invitation completes even when refreshed cookies cannot be saved',async()=>{
 f.connect=async before=>{await before()};f.save=async()=>{throw new state.LinkedInSessionUnavailableError()};
 await execute('connect');
 const row=trackRow();assert.equal(row.state,'pending');assert.equal(row.error_message,null);
 assert.ok(db.prepare('SELECT connection_requested_at FROM targets').get().connection_requested_at);
 assert.equal(connect.hasUnresolvedInvitationOutcome(db,'t',profile),false);
 assert.equal(f.reauthChecks,0);
 assert.ok(db.prepare("SELECT COUNT(*) AS c FROM logs WHERE message LIKE '%refreshed cookies were not saved%'").get().c===1);
});
