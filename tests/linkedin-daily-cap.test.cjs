// Actual runner budget helpers on in-memory SQLite. No browser, network or provider.
const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const ts=require('typescript');
const Database=require('better-sqlite3');
function load(file,stubs={}) {
 const source=fs.readFileSync(path.join(process.cwd(),file),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const module={exports:{}};
 vm.runInNewContext(js,{module,exports:module.exports,require:id=>id in stubs?stubs[id]:require(id),process,URL,AbortSignal,fetch:(...a)=>global.fetch(...a),global,console,Date,setTimeout,clearTimeout},{filename:file});
 return module.exports;
}
const boundary=async()=>{throw new Error('Unexpected provider boundary')};
const runner=load('lib/linkedin/runner.ts',{
 '@/lib/linkedin/schedule':load('lib/linkedin/schedule.ts'),
 '@/lib/db':{getDb:()=>{throw new Error('use the fixture db')}},
 '@/lib/linkedin/echo-guard':load('lib/linkedin/echo-guard.ts',{'./readiness-artifact':{BUILT_GUARD_REVISION:''}}),
 '@/lib/linkedin/readiness-artifact':{recordExecutorStarted:()=>{},recordExecutorStopped:()=>{}},
 '@/lib/linkedin/connect':load('lib/linkedin/connect.ts'),
 '@/lib/linkedin/session':{getSessionPage:boundary,saveSessionState:boundary,getSessionContext:boundary},
 '@/lib/linkedin/visit':{visitProfile:boundary},'@/lib/linkedin/message':{sendMessage:boundary},
 '@/lib/linkedin/sync-accepted':{},'@/lib/email/sender':{sendEmail:boundary},'@/lib/email/inbox':{},
 '@/lib/linkedin/enrich':{enrichProfile:boundary},'@/lib/apollo':{matchPerson:boundary},'@/lib/premium':{},'@/lib/crypto':{},
});
let db;
beforeEach(()=>{
 db=new Database(':memory:');
 db.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY,workflow_id TEXT,list_id TEXT,account_id TEXT,status TEXT);
 CREATE TABLE logs(id TEXT PRIMARY KEY,run_id TEXT,target_id TEXT,level TEXT,message TEXT,created_at TEXT DEFAULT (datetime('now')));
 CREATE TABLE workflow_steps(id TEXT PRIMARY KEY,workflow_id TEXT,step_order INTEGER,step_type TEXT,track TEXT DEFAULT 'linkedin');
 CREATE TABLE run_profiles(id TEXT PRIMARY KEY,run_id TEXT,target_id TEXT);
 CREATE TABLE run_profile_tracks(id TEXT PRIMARY KEY,run_profile_id TEXT,track TEXT,state TEXT,current_step INTEGER,next_step_at TEXT);`);
 const steps={'w-echo':['visit','connect'],'w-cm':['connect','delay','message'],'w-vdc':['visit','delay','connect'],'w-inmail':['sales_inmail'],'w-visit':['visit']};
 for(const [w,list] of Object.entries(steps))list.forEach((type,i)=>db.prepare('INSERT INTO workflow_steps VALUES (?,?,?,?,?)').run(`${w}-${i}`,w,i+1,type,'linkedin'));
 db.prepare("INSERT INTO workflow_steps VALUES ('w-echo-email','w-echo',1,'email','email')").run();
 for(const [id,w,a] of [['r1','w-echo','a1'],['r2','w-cm','a2'],['r3','w-inmail','a1']])db.prepare('INSERT INTO runs VALUES (?,?,?,?,?)').run(id,w,'l',a,'running');
});
afterEach(()=>db.close());
let n=0;const id=()=>'id-'+(++n);
function logLine(run,message,when="datetime('now')"){db.prepare(`INSERT INTO logs(id,run_id,target_id,level,message,created_at) VALUES (?,?,?,?,?,${when})`).run(id(),run,'t','info',message)}
function track(run,state,when,trackName='linkedin'){const rp=id();db.prepare('INSERT INTO run_profiles VALUES (?,?,?)').run(rp,run,'t-'+rp);db.prepare(`INSERT INTO run_profile_tracks VALUES (?,?,?,?,0,${when})`).run(id(),rp,trackName,state)}

test('connections spent today count Echo confirmations, including owner-reconciled ones',()=>{
 logLine('r1','Connection request sent to A — will recheck in 24h');
 logLine('r1','Echo initial connection confirmed; no followup authorized');
 logLine('r1','Echo initial connection confirmed by owner reconciliation (LinkedIn Sent list); no followup authorized');
 logLine('r1','Sending connection request to B');
 logLine('r1','Message sent to C');
 logLine('r1','Echo initial connection confirmed; no followup authorized',"datetime('now','-1 day')");
 logLine('r2','Connection request sent to D');
 assert.equal(runner.connectsSentTodayCount(db,'a1'),3);
 assert.equal(runner.connectsSentTodayCount(db,'a2'),1);
});
test('the first spending step skips visits and delays',()=>{
 assert.equal(runner.firstActionStepType(db,'w-echo'),'connect');
 assert.equal(runner.firstActionStepType(db,'w-cm'),'connect');
 assert.equal(runner.firstActionStepType(db,'w-vdc'),'connect');
 assert.equal(runner.firstActionStepType(db,'w-inmail'),'sales_inmail');
 assert.equal(runner.firstActionStepType(db,'w-visit'),undefined);
});
test('visit-first Echo tracks due today use connection slots; other states, days and tracks do not',()=>{
 track('r1','in_progress',"datetime('now')");track('r1','in_progress',"datetime('now')");
 track('r1','in_progress',"datetime('now','+1 day')");track('r1','completed',"datetime('now')");
 track('r1','pending',"datetime('now')");track('r1','in_progress',"datetime('now')",'email');
 track('r3','in_progress',"datetime('now')");
 assert.equal(runner.scheduledFirstActionsToday(db,'a1','connect'),2);
 assert.equal(runner.scheduledFirstActionsToday(db,'a1','sales_inmail'),1);
 assert.equal(runner.scheduledFirstActionsToday(db,'a2','connect'),0);
});
