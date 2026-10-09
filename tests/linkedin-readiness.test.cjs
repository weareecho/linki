// Synthetic only. Never imports the real runtime/session launcher or opens the
// owner's database. Temporary fixture files stay inside this Archives worktree.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const {Readable}=require('node:stream');
const ts=require('typescript');
const Database=require('better-sqlite3');
const root=path.resolve(__dirname,'..');
const plain=v=>JSON.parse(JSON.stringify(v));
function loader({env={},stubs={},timer=setTimeout,fetcher=()=>{throw Error('NETWORK FORBIDDEN')}}={}) {
  const cache=new Map();
  const context=vm.createContext({Buffer,URL,AbortSignal,TextEncoder,Date,Map,Set,console,
    setTimeout:timer,clearTimeout,fetch:fetcher,process:{env,cwd:()=>root}});
  context.global=context;
  function load(file,extra='') {
    file=path.resolve(root,file);
    if(cache.has(file))return cache.get(file).exports;
    const module={exports:{}};cache.set(file,module);
    const source=fs.readFileSync(file,'utf8')+extra;
    const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
    const requireLocal=id=>{
      if(id in stubs)return stubs[id];
      if(id.startsWith('@/'))return load(id.slice(2)+'.ts');
      if(id.startsWith('.'))return load(path.resolve(path.dirname(file),id+'.ts'));
      return require(id);
    };
    vm.runInContext('(function(module,exports,require,__dirname){'+js+'\n})',context,{filename:file})(module,module.exports,requireLocal,path.dirname(file));
    return module.exports;
  }
  return {load,context};
}
const scope={account_id:'fixture-account',workflow_id:'fixture-workflow',list_id:'fixture-list'};
const profile='https://www.linkedin.com/in/fixture-owner';
const revision='sha256:'+'a'.repeat(64);
const rawManifest='[{"note":"Hi \\u00e9 \\ud83d\\udc4b", "max_person_touches":2,"contact_id":"fixture"}]';
const now=Date.now();
function fixture(options={}) {
  const loaded=loader(options),api=loaded.load('lib/linkedin/readiness.ts');
  const manifestDigest=api.canonicalManifestDigest(rawManifest);
  const config={...scope,account_profile_url:profile,bridge_action_url:'http://127.0.0.1:3457/echo/action',guard_revision:revision,
    approval_manifest_path:'/Volumes/Archives/fixture-manifest.json',approval_manifest_digest:manifestDigest};
  let calls=0;
  const request={...scope,guard_revision:revision,approval_manifest_digest:manifestDigest,challenge:'b'.repeat(64)};
  let current=true;
  const deps={config:()=>({...config}),inspectScope:()=> 'snapshot',manifest:()=>rawManifest,revision:()=>revision,
    observe:async()=>({profile,observedAt:now,startedAt:now,isCurrent:()=>current}),guardURL:()=>config.bridge_action_url,now:()=>now,
    bridge:async(url,payload,signal)=>{
      calls++;assert.equal(url.href,'http://127.0.0.1:3457/echo/readiness');assert.ok(signal);
      return {...payload,ready:true};
    }};
  return {...loaded,api,config,deps,request,expireSession(){current=false},get calls(){return calls}};
}
test('complete positive receipt includes only the eight contracted non-secret fields',async()=>{
  const f=fixture();const receipt=await f.api.produceReadiness(f.request,f.deps);
  assert.deepEqual(plain(receipt),{...f.request,
    checked_at:new Date(now).toISOString(),guarded_owner_ready:true});assert.equal(f.calls,1);
});
test('canonical complete manifest agrees with Python ensure_ascii compact sorted-key bytes',()=>{
  const f=fixture();const canonical='[{"contact_id":"fixture","max_person_touches":2,"note":"Hi \\u00e9 \\ud83d\\udc4b"}]';
  assert.equal(f.config.approval_manifest_digest,crypto.createHash('sha256').update(canonical).digest('hex'));
  for(const raw of ['{}','[]','[{"n":1.0}]','[{"n":1e2}]','[{"n":9007199254740992}]'])
    assert.throws(()=>f.api.canonicalManifestDigest(raw),{reason:'manifest_unavailable'});
});
for(const [name,change,reason] of [
  ['unknown account',f=>f.config.account_id='other','scope_mismatch'],
  ['unknown workflow',f=>f.config.workflow_id='other','scope_mismatch'],
  ['unknown list',f=>f.config.list_id='other','scope_mismatch'],
  ['missing loaded guard',f=>f.deps.revision=()=>null,'guard_artifact_unavailable'],
  ['wrong artifact',f=>f.deps.revision=()=> 'sha256:'+'c'.repeat(64),'guard_revision_mismatch'],
  ['wrong guard URL',f=>f.deps.guardURL=()=> 'http://127.0.0.1:9999/echo/action','bridge_url_mismatch'],
  ['manifest changed',f=>f.deps.manifest=()=>rawManifest.replace('fixture','changed'),'manifest_changed'],
  ['missing session',f=>f.deps.observe=async()=>null,'session_unavailable'],
  ['wrong signed-in owner',f=>f.deps.observe=async()=>({profile:profile+'other',observedAt:now,startedAt:now}),'identity_mismatch'],
  ['stale document',f=>f.deps.observe=async()=>({profile,observedAt:now,startedAt:now-1}),'session_stale'],
  ['future document',f=>f.deps.observe=async()=>({profile,observedAt:now,startedAt:now+1}),'session_stale'],
  ['pre-request observation',f=>f.deps.observe=async()=>({profile,observedAt:now-1,startedAt:now-2}),'session_stale'],
  ['future observation',f=>f.deps.observe=async()=>({profile,observedAt:now+1,startedAt:now}),'session_stale'],
])test('fail closed without bridge probe: '+name,async()=>{
  const f=fixture();change(f);await assert.rejects(f.api.produceReadiness(f.request,f.deps),{reason});assert.equal(f.calls,0);
});
for(const url of ['https://public.test/echo/action','http://u:p@localhost/echo/action','http://localhost/other','http://localhost/echo/action?q=x','http://localhost/echo/action#x'])
  test('invalid configured URL never dispatches secret: '+url,async()=>{
    const f=fixture();f.config.bridge_action_url=url;await assert.rejects(f.api.produceReadiness(f.request,f.deps),{reason:'bridge_url_mismatch'});assert.equal(f.calls,0);
  });
for(const field of ['challenge','account_id','workflow_id','list_id','guard_revision','approval_manifest_digest','ready','extra'])
  test('reject each mismatched/replayed bridge response field: '+field,async()=>{
    const f=fixture();f.deps.bridge=async(_,p)=>({...p,ready:true,[field]:'wrong'});
    await assert.rejects(f.api.produceReadiness(f.request,f.deps),{reason:'bridge_mismatch'});
  });
test('fresh parent challenge forwarded unchanged, old response replay rejected',async()=>{
  const f=fixture();let previous;
  f.deps.bridge=async(_,p)=>{previous={...p,ready:true};return previous};
  await f.api.produceReadiness(f.request,f.deps);
  f.request.challenge='c'.repeat(64);f.deps.bridge=async()=>previous;
  await assert.rejects(f.api.produceReadiness(f.request,f.deps),{reason:'bridge_mismatch'});
});
test('provider exception is sanitized and a stuck identity observation is bounded',async()=>{
  const f=fixture();f.deps.bridge=async()=>{throw Error('provider-secret')};
  await assert.rejects(f.api.produceReadiness(f.request,f.deps),{reason:'bridge_unavailable'});
  const stuck=fixture({timer:(fn,ms)=>setTimeout(fn,ms===7000?5:ms)});
  stuck.deps.observe=()=>new Promise(()=>{});
  await assert.rejects(stuck.api.produceReadiness(stuck.request,stuck.deps),{reason:'observation_timeout'});assert.equal(stuck.calls,0);
});
for(const field of ['config','revision','inspectScope','guardURL','manifest','observe'])test('detect mid-observation mutation: '+field,async()=>{
  const f=fixture();f.deps.bridge=async(_,p)=>{
    if(field==='config')f.config.list_id='changed';
    if(field==='revision')f.deps.revision=()=>null;
    if(field==='inspectScope')f.deps.inspectScope=()=> 'changed';
    if(field==='guardURL')f.deps.guardURL=()=> 'changed';
    if(field==='manifest')f.deps.manifest=()=>rawManifest.replace('fixture','changed');
    if(field==='observe')f.expireSession();
    return {...p,ready:true};
  };await assert.rejects(f.api.produceReadiness(f.request,f.deps),{reason:'runtime_changed'});
});

function fixtureDatabase() {
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE accounts(id TEXT); CREATE TABLE lists(id TEXT); CREATE TABLE workflows(id TEXT,name TEXT);
    CREATE TABLE runs(id TEXT,workflow_id TEXT,account_id TEXT,list_id TEXT,status TEXT);
    CREATE TABLE workflow_steps(id TEXT,workflow_id TEXT,step_order INTEGER,step_type TEXT,track TEXT);
    CREATE TABLE targets(id TEXT,linkedin_url TEXT,full_name TEXT,company TEXT,notes TEXT);
    CREATE TABLE list_targets(list_id TEXT,target_id TEXT); CREATE TABLE app_settings(key TEXT,value TEXT);
    CREATE TABLE run_profiles(id TEXT,run_id TEXT,target_id TEXT);`);
  db.prepare('INSERT INTO accounts VALUES (?)').run(scope.account_id);db.prepare('INSERT INTO lists VALUES (?)').run(scope.list_id);
  db.prepare('INSERT INTO workflows VALUES (?,?)').run(scope.workflow_id,'Echo fixture');
  db.prepare('INSERT INTO runs VALUES (?,?,?,?,?)').run('run',scope.workflow_id,scope.account_id,scope.list_id,'paused');
  db.prepare('INSERT INTO workflow_steps VALUES (?,?,?,?,?)').run('step',scope.workflow_id,1,'connect','linkedin');
  db.prepare('INSERT INTO targets VALUES (?,?,?,?,?)').run('target','https://www.linkedin.com/in/prospect','Fixture Person','Fixture Co',
    'Echo reservation '+'e'.repeat(64)+'; approved connection note: Hello fixture');
  db.prepare('INSERT INTO list_targets VALUES (?,?)').run(scope.list_id,'target');
  db.prepare('INSERT INTO run_profiles VALUES (?,?,?)').run('profile','run','target');
  return db;
}
test('real read-only scope SELECTs accept paused workflow without a write or enrollment',()=>{
  const db=fixtureDatabase(),f=fixture(),store=f.load('lib/linkedin/readiness-store.ts');
  try {
    db.pragma('query_only = ON');const before=db.prepare('SELECT total_changes() AS n').get().n;
    assert.match(store.inspectScopeDatabase(db,scope),/^[a-f0-9]{64}$/);
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n,before);
  } finally {db.close()}
});
for(const [sql,reason] of [
  ["UPDATE workflows SET name='Ordinary workflow'",'guard_not_enforced'],
  ["UPDATE targets SET notes=NULL",'guard_not_enforced'],
  ["UPDATE runs SET list_id='other'",'association_unavailable'],
  ["UPDATE runs SET account_id='other'",'association_unavailable'],
  ["DELETE FROM runs",'association_unavailable'],
  ["UPDATE run_profiles SET target_id='outside-list'",'association_unavailable'],
  ...['message','sales_inmail','email','delay'].map(type=>["UPDATE workflow_steps SET step_type='"+type+"'",'unsupported_steps']),
  ["UPDATE workflow_steps SET track='email'",'unsupported_steps'],
  ["INSERT INTO workflow_steps SELECT 'later',workflow_id,2,'connect','linkedin' FROM workflow_steps",'unsupported_steps'],
])test('actual store blocks unauthorized execution shape: '+sql,()=>{
  const db=fixtureDatabase(),f=fixture(),store=f.load('lib/linkedin/readiness-store.ts');
  try {db.exec(sql);db.pragma('query_only = ON');assert.throws(()=>store.inspectScopeDatabase(db,scope),{reason})}finally{db.close()}
});
test('actual readonly DB opener refuses absent store and never creates one',()=>{
  const dir=fs.mkdtempSync(path.join(root,'.readiness-fixture-'));
  try {
    const filename=path.join(dir,'missing.db'),l=loader({env:{LINKI_DB_PATH:filename}});
    assert.throws(()=>l.load('lib/linkedin/readiness-store.ts').inspectReadOnlyScope(scope),{reason:'association_unavailable'});
    assert.equal(fs.existsSync(filename),false);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('private config/manifest reader is bounded and refuses symlink, broad mode and unreadable/missing input',()=>{
  const dir=fs.mkdtempSync(path.join(root,'.readiness-fixture-'));
  const store=loader().load('lib/linkedin/readiness-store.ts');
  try {
    const file=path.join(dir,'manifest.json'),link=path.join(dir,'link.json');
    fs.writeFileSync(file,rawManifest,{mode:0o600});
    assert.equal(store.readBoundedFile(file,4096),rawManifest);
    assert.throws(()=>store.readBoundedFile(file,1),{reason:'configuration_unavailable'});
    fs.symlinkSync(file,link);assert.throws(()=>store.readBoundedFile(link,4096),{reason:'configuration_unavailable'});
    fs.chmodSync(file,0o644);assert.throws(()=>store.readBoundedFile(file,4096),{reason:'configuration_unavailable'});
    assert.throws(()=>store.readBoundedFile(path.join(dir,'missing'),4096),{reason:'configuration_unavailable'});
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
});
test('exact reviewed configuration rejects missing fields and wrong types instead of accepting caller assertions',()=>{
  const f=fixture();assert.deepEqual(plain(f.api.parseConfig(f.config)),f.config);
  for(const invalid of [{...f.config,extra:true},{...f.config,account_id:42},{...f.config,guard_revision:'73f9bf2156ea7f237a01263d49d9740467488cdb'},
    {...f.config,account_profile_url:'https://public.test/in/owner'},{...f.config,approval_manifest_path:'relative.json'}])
    assert.throws(()=>f.api.parseConfig(invalid),{reason:'configuration_unavailable'});
});
test('artifact requires actual executor and loaded guard registration, cleared on stopped loop',()=>{
  const l=loader({env:{LINKI_BUILT_GUARD_REVISION:revision}}),a=l.load('lib/linkedin/readiness-artifact.ts');
  assert.equal(a.runningGuardRevision(),null);a.recordExecutorStarted(revision);assert.equal(a.runningGuardRevision(),revision);
  a.recordExecutorStopped();assert.equal(a.runningGuardRevision(),null);a.recordExecutorStarted(revision);
  l.context.__linkiReadinessExecutor.revision='sha256:'+'f'.repeat(64);assert.equal(a.runningGuardRevision(),null);
  const unbuilt=loader().load('lib/linkedin/readiness-artifact.ts');unbuilt.recordExecutorStarted('');assert.equal(unbuilt.runningGuardRevision(),null);
});
const ownFeed='<nav><img class="global-nav__me-photo"></nav><aside><a data-control-name="identity_profile_photo" href="/in/fixture-owner/">Owner</a></aside>';
test('feed parser requires own identity and signed-in navigation, ignores scripts/comments/templates',()=>{
  const s=loader().load('lib/linkedin/readiness-session.ts');
  assert.equal(s.profileFromOwnFeed(ownFeed),profile);
  for(const html of ['<a href="/in/prospect">prospect</a>', '<!--'+ownFeed+'-->', '<script>'+ownFeed+'</script>',
    '<template>'+ownFeed+'</template>',ownFeed+ownFeed,ownFeed.replace('identity_profile_photo','post_author_photo')])
    assert.equal(s.profileFromOwnFeed(html),null);
});
test('existing-session observation performs only one fixed authenticated own-feed GET, no page or cookie access',async()=>{
  const s=loader().load('lib/linkedin/readiness-session.ts');
  assert.equal(await s.observeExistingIdentity(scope.account_id),null);
  let status=200,html=ownFeed,disposed=0,calls=0;
  const context={browser:()=>({isConnected:()=>true}),request:{get:async(url,options)=>{
    calls++;assert.equal(url,'https://www.linkedin.com/feed/');assert.equal(options.maxRedirects,0);
    assert.equal(options.maxRetries,0);assert.equal(options.timeout,4000);
    assert.equal(options.headers['cache-control'],'no-cache, no-store');
    return {status:()=>status,url:()=>url,headers:()=>({'content-type':'text/html'}),body:async()=>Buffer.from(html),dispose:async()=>{disposed++}};
  }}};
  s.existingContexts.set(scope.account_id,context);
  const observation=await s.observeExistingIdentity(scope.account_id);assert.equal(observation.profile,profile);assert.equal(observation.isCurrent(),true);
  status=302;assert.equal(await s.observeExistingIdentity(scope.account_id),null);
  status=200;html='<html>Guest</html>';assert.equal(await s.observeExistingIdentity(scope.account_id),null);
  assert.equal(calls,3);assert.equal(disposed,3);
  s.existingContexts.delete(scope.account_id);assert.equal(observation.isCurrent(),false);
});
function request(body,{secret='fixture-secret',method='POST',type='application/json'}={}) {
  const req=Readable.from([Buffer.from(typeof body==='string'?body:JSON.stringify(body))]);
  req.headers={'x-internal-secret':secret,'content-type':type};req.method=method;return req;
}
function response() {return {headers:{},code:0,body:null,setHeader(k,v){this.headers[k]=v},status(c){this.code=c;return this},json(b){this.body=plain(b);return this}}}
test('route authenticates before parsing; rejects invalid bodies without opening store/session/network',async()=>{
  let calls=0;const forbid=()=>{calls++;throw Error('NO SIDE EFFECT')};
  const l=loader({env:{INTERNAL_API_SECRET:'fixture-secret'},stubs:{
    '@/lib/linkedin/readiness-store':{loadReadinessConfig:forbid,inspectReadOnlyScope:forbid,readBoundedFile:forbid},
    '@/lib/linkedin/readiness-artifact':{runningGuardRevision:forbid},
    '@/lib/linkedin/readiness-session':{observeExistingIdentity:forbid},
  }}),handler=l.load('pages/api/echo/readiness.ts').default;
  for(const [req,code] of [[request('{bad',{secret:'wrong'}),401],[request(scope,{method:'GET'}),405],
    [request('{bad'),400],[request('x'.repeat(8193)),400],[request({...scope,guard_revision:revision}),400],
    [request({...scope,account_id:1}),400],[request(scope,{type:'text/plain'}),400]]) {
    const res=response();await handler(req,res);assert.equal(res.code,code);assert.equal(res.headers['Cache-Control'],'no-store');
    assert.equal(JSON.stringify(res.body).includes('fixture-secret'),false);
  }assert.equal(calls,0);
});

test('actual build source digest → loaded guard → existing paused executor → real scope and identity → producer acceptance',async()=>{
  const builder=loader(),buildConfig=builder.load('next.config.ts').default('phase-production-build');
  const builtRevision=buildConfig.env.LINKI_BUILT_GUARD_REVISION;
  assert.match(builtRevision,/^sha256:[a-f0-9]{64}$/);
  const forbid=()=>{throw Error('Unexpected prospect action, DB write, cookie read or browser launch')};
  const stubs={
    '@/lib/db':{getDb:()=>({prepare:sql=>{assert.match(sql,/^\s*SELECT/);return {all:()=>[]}}})},
    '@/lib/linkedin/session':{getSessionPage:forbid,saveSessionState:forbid,getSessionContext:forbid},
    '@/lib/linkedin/visit':{visitProfile:forbid},'@/lib/linkedin/message':{sendMessage:forbid},
    '@/lib/linkedin/sync-accepted':{},'@/lib/email/sender':{sendEmail:forbid},'@/lib/email/inbox':{},
    '@/lib/linkedin/enrich':{enrichProfile:forbid},'@/lib/apollo':{matchPerson:forbid},'@/lib/premium':{},'@/lib/crypto':{},
    '@/lib/import-jobs':{processScheduledImports:async()=>{}},
  };
  const l=loader({env:{LINKI_BUILT_GUARD_REVISION:builtRevision},stubs,timer:(fn,ms)=>ms===30000?0:setTimeout(fn,ms)});
  const artifact=l.load('lib/linkedin/readiness-artifact.ts');
  assert.equal(artifact.runningGuardRevision(),null);
  l.load('lib/linkedin/runner.ts').ensureGlobalRunnerStarted();
  assert.equal(artifact.runningGuardRevision(),builtRevision);
  assert.equal(l.load('lib/linkedin/echo-guard.ts').ECHO_GUARD_ARTIFACT_REVISION,builtRevision);
  const session=l.load('lib/linkedin/readiness-session.ts');let ownGets=0,bridgeCalls=0;
  session.existingContexts.set(scope.account_id,{browser:()=>({isConnected:()=>true}),request:{get:async(url)=>{
    ownGets++;assert.equal(url,'https://www.linkedin.com/feed/');return {status:()=>200,url:()=>url,
      headers:()=>({'content-type':'text/html'}),body:async()=>Buffer.from(ownFeed),dispose:async()=>{}};
  }}});
  const db=fixtureDatabase(),api=l.load('lib/linkedin/readiness.ts'),store=l.load('lib/linkedin/readiness-store.ts');
  const digest=api.canonicalManifestDigest(rawManifest);
  const expected={...scope,guard_revision:builtRevision,approval_manifest_digest:digest,challenge:'f'.repeat(64)};
  const config={...scope,guard_revision:builtRevision,approval_manifest_digest:digest,account_profile_url:profile,
    bridge_action_url:'http://127.0.0.1:3457/echo/action',approval_manifest_path:'/Volumes/Archives/fixture.json'};
  try {
    db.pragma('query_only = ON');
    const receipt=await api.produceReadiness(expected,{config:()=>config,inspectScope:s=>store.inspectScopeDatabase(db,s),
      manifest:()=>rawManifest,revision:artifact.runningGuardRevision,observe:session.observeExistingIdentity,
      guardURL:()=>config.bridge_action_url,bridge:async(url,payload)=>{
        bridgeCalls++;assert.equal(url.pathname,'/echo/readiness');assert.deepEqual(plain(payload),expected);
        return {...payload,ready:true};
      }});
    assert.equal(receipt.guarded_owner_ready,true);assert.equal(receipt.challenge,expected.challenge);
    assert.equal(ownGets,1);assert.equal(bridgeCalls,1);
  } finally {db.close();artifact.recordExecutorStopped()}
});

test('production build digest changes with action code; dev and runtime env cannot supply the configured build stamp',()=>{
  const first=loader().load('next.config.ts').default;
  const base=first('phase-production-build').env.LINKI_BUILT_GUARD_REVISION;
  const altered=loader({stubs:{'node:fs':{...fs,readFileSync:(filename,...args)=>{
    const bytes=fs.readFileSync(filename,...args);
    return filename.endsWith('/lib/linkedin/connect.ts')?Buffer.concat([bytes,Buffer.from('\n// synthetic variation')]):bytes;
  }}}}).load('next.config.ts').default;
  assert.notEqual(altered('phase-production-build').env.LINKI_BUILT_GUARD_REVISION,base);
  assert.equal(first('phase-development-server').env.LINKI_BUILT_GUARD_REVISION,'');
  assert.equal(loader({env:{LINKI_BUILT_GUARD_REVISION:revision}}).load('next.config.ts')
    .default('phase-production-server').env.LINKI_BUILT_GUARD_REVISION,'');
});
