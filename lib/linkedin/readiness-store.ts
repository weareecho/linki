import Database from "better-sqlite3";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { blocked, parseConfig, ReadinessBlocked, type Scope } from "./readiness";
import { parseEchoScope } from "./echo-guard";

export function readBoundedFile(filename: string | undefined, limit: number): string {
  if (!filename || !path.isAbsolute(filename)) blocked("configuration_unavailable");
  let fd: number | undefined;
  try {
    if (realpathSync(filename) !== filename) blocked("configuration_unavailable");
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > limit || stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) blocked("configuration_unavailable");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length !== stat.size || length > limit || after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) blocked("configuration_unavailable");
    return bytes.subarray(0, length).toString("utf8");
  } catch { return blocked("configuration_unavailable"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function loadReadinessConfig() {
  try { return parseConfig(JSON.parse(readBoundedFile(process.env.ECHO_READINESS_CONFIG, 8192))); }
  catch { return blocked("configuration_unavailable"); }
}

/** Independent read-only connection: getDb() initializes/migrates the store and
 * therefore must never be imported by a readiness observation. */
export function inspectReadOnlyScope(scope: Scope): string {
  let db: Database.Database | undefined;
  try {
    db = new Database(process.env.LINKI_DB_PATH || path.join(process.cwd(), "linki.db"),
      { readonly: true, fileMustExist: true, timeout: 500 });
    return inspectScopeDatabase(db, scope);
  } catch (error) {
    if (error instanceof ReadinessBlocked) throw error;
    // Explicit finite errors, never serialize SQLite paths/rows or provider data.
    return blocked("association_unavailable");
  } finally { db?.close(); }
}

export function inspectScopeDatabase(db: Database.Database, scope: Scope): string {
  return db.transaction(() => {
    const account = db.prepare("SELECT id FROM accounts WHERE id = ?").get(scope.account_id);
    const list = db.prepare("SELECT id FROM lists WHERE id = ?").get(scope.list_id);
    const workflow = db.prepare("SELECT id, name FROM workflows WHERE id = ?").get(scope.workflow_id) as { id: string; name: string } | undefined;
    if (!account || !list || !workflow) blocked("association_unavailable");
    // The actual executor's managed predicate includes this workflow name. This
    // fences future list members too; a handful of managed target notes cannot
    // establish that the entire workflow is guarded.
    if (!/^Echo\b/i.test(workflow.name)) blocked("guard_not_enforced");
    const runs = db.prepare("SELECT id, account_id, list_id, status FROM runs WHERE workflow_id = ? AND status IN ('pending','paused','running') ORDER BY id LIMIT 33")
      .all(scope.workflow_id) as { id: string; account_id: string; list_id: string; status: string }[];
    if (runs.length !== 1 || runs[0].account_id !== scope.account_id || runs[0].list_id !== scope.list_id)
      blocked("association_unavailable");
    // Match runner SQL: it does not filter on enabled, so disabled unsupported
    // rows must also block. Exactly visit? → connect, no delays or later steps.
    const steps = db.prepare("SELECT id, step_order, step_type, track FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order, id LIMIT 4")
      .all(scope.workflow_id) as { id: string; step_order: number; step_type: string; track: string }[];
    if (!["connect", "visit,connect"].includes(steps.map(s => s.step_type).join(",")) ||
        steps.some(s => s.track !== "linkedin") || new Set(steps.map(s => s.step_order)).size !== steps.length)
      blocked("unsupported_steps");
    const targets = db.prepare(`SELECT t.id, t.linkedin_url, t.full_name, t.company, t.notes,
        s.value AS saved_scope FROM list_targets lt JOIN targets t ON t.id = lt.target_id
        LEFT JOIN app_settings s ON s.key = 'echo-scope:' || t.id
        WHERE lt.list_id = ? ORDER BY t.id LIMIT 1551`).all(scope.list_id) as {
          id: string; linkedin_url: string; full_name: string; company: string; notes: string | null; saved_scope: string | null
        }[];
    if (!targets.length || targets.length > 1550) blocked("association_unavailable");
    try {
      for (const target of targets) parseEchoScope(target.saved_scope || target.notes, {
        account_id: scope.account_id, list_id: scope.list_id, profile: target.linkedin_url,
        full_name: target.full_name || "", company: target.company || "",
      });
    } catch { blocked("guard_not_enforced"); }
    const profiles = db.prepare("SELECT id, target_id FROM run_profiles WHERE run_id = ? ORDER BY id LIMIT 1551")
      .all(runs[0].id) as { id: string; target_id: string }[];
    const targetIDs = new Set(targets.map(t => t.id));
    if (!profiles.length || profiles.length > 1550 || profiles.some(p => !targetIDs.has(p.target_id)))
      blocked("association_unavailable");
    return createHash("sha256").update(JSON.stringify({ account, list, workflow, runs, steps, targets, profiles })).digest("hex");
  }).deferred();
}
