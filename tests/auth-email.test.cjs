// Run: node --experimental-strip-types --experimental-sqlite --test tests/auth-email.test.cjs
// Real in-memory SQLite and actual API handlers; only framework, rate limiter,
// and bcrypt are isolated. These tests check matching, not bcrypt cryptography.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const modules = {
  'next-auth': 'export default function NextAuth(options) { return options; }',
  'next-auth/providers/credentials': 'export default function CredentialsProvider(options) { return options; }',
  'bcryptjs': 'export default { async hash(value) { return "test-only:" + value; }, async compare(value, hash) { return hash === "test-only:" + value; } };',
  '@/lib/db': 'export function getDb() { return globalThis.authTestDb; }',
  '@/lib/rate-limit': 'export function isRateLimited() { return globalThis.authTestLimited; }',
};
registerHooks({ resolve(specifier, context, next) {
  if (modules[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]), shortCircuit: true };
  if (specifier === '@/lib/auth-email') return next(pathToFileURL(path.join(root, 'lib/auth-email.ts')).href, context);
  return next(specifier, context);
}});
let db, signup, authorize;
beforeEach(async () => {
  if (db) db.close();
  db = globalThis.authTestDb = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL)');
  globalThis.authTestLimited = false;
  process.env.AUTH_PASSWORD = 'fixture-invite';
  signup = (await import(pathToFileURL(path.join(root, 'pages/api/auth/signup.ts')).href)).default;
  authorize = (await import(pathToFileURL(path.join(root, 'pages/api/auth/[...nextauth].ts')).href)).authOptions.providers[0].authorize;
});
const password = ' Fixture password with spaces ';
function insert(email, id='fixture-user') { db.prepare('INSERT INTO users VALUES (?, ?, ?)').run(id, email, 'test-only:' + password); }
async function register(body) {
  const res = { status(code) { this.code=code; return this; }, json(value) { this.body=value; return this; }, end() { return this; } };
  await signup({method:'POST', body}, res);
  return res;
}
test('signup canonicalizes email and login finds case/whitespace variants', async () => {
  assert.equal((await register({ email:' Kayvon@Example.test ', password, inviteCode:'fixture-invite' })).code, 201);
  assert.equal(db.prepare('SELECT email FROM users').get().email, 'kayvon@example.test');
  for (const email of ['kayvon@example.test', 'KAYVON@EXAMPLE.TEST', '  Kayvon@example.test  ', '\tKayvon@example.test\n']) {
    assert.equal((await authorize({email,password}, {})).email, 'kayvon@example.test');
  }
});
test('legacy mixed-case padded email retains its identity', async () => {
  insert(' Kayvon@Example.test ');
  assert.deepEqual(await authorize({email:'kayvon@example.test',password},{}), {id:'fixture-user',email:' Kayvon@Example.test '});
});
test('signup rejects a canonical duplicate of a legacy account', async () => {
  insert(' Kayvon@Example.test ');
  assert.equal((await register({email:'KAYVON@example.test',password,inviteCode:'fixture-invite'})).code,409);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n,1);
});
test('ambiguous legacy aliases fail closed', async () => {
  insert('Kayvon@example.test','one'); insert('kayvon@example.test','two');
  assert.equal(await authorize({email:'Kayvon@example.test',password},{}),null);
});
test('wrong or trimmed passwords are rejected; password bytes stay exact', async () => {
  insert('kayvon@example.test');
  assert.equal(await authorize({email:'kayvon@example.test',password:password.trim()},{}),null);
  assert.equal(await authorize({email:'kayvon@example.test',password:'incorrect'},{}),null);
  assert.equal((await authorize({email:'kayvon@example.test',password},{})).id,'fixture-user');
});
test('invite check is exact and remains required', async () => {
  for (const inviteCode of ['fixture-invite ', 'wrong', undefined]) {
    const result=await register({email:'kayvon@example.test',password,inviteCode});
    assert.ok([400,403].includes(result.code));
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n,0);
});
test('blank and non-string identifiers fail safely', async () => {
  for (const email of ['   ', undefined, 42, {}]) {
    assert.equal(await authorize({email,password},{}),null);
    assert.equal((await register({email,password,inviteCode:'fixture-invite'})).code,400);
  }
});
test('rate limits remain enforced', async () => {
  insert('kayvon@example.test'); globalThis.authTestLimited=true;
  await assert.rejects(authorize({email:'kayvon@example.test',password},{}), /Too many attempts/);
  assert.equal((await register({email:'other@example.test',password,inviteCode:'fixture-invite'})).code,429);
});
