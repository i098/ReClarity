// BLA 3.1.0 SQLite honey: five tables and one view with fixed names and fixed columns, three of the
// tables carrying a VIRTUAL generated column that calls the unknown function `enclave_unseal_payload`.
// A table is honey only when its name AND its full column list match BLA's, so a business table that
// happens to share a name is never dropped.
import { Database } from "bun:sqlite";
import { closeSync, openSync, readSync } from "node:fs";

export const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

const HONEY_TABLES: Record<string, string[]> = {
  enclave_key_hierarchy: ["slot_id", "key_domain", "enclave_cid", "sealed_payload", "attestation_notice", "unsealed_preview"],
  tpm2_attestation_ledger: ["quote_id", "pcr0_sha256", "monotonic_counter", "enclave_manifest", "verified_state"],
  zero_trust_session_leases: ["lease_token", "tier_scope", "expires_epoch", "hardware_bound", "enclave_claim"],
  canary_transport_redaction: ["canary_id", "canary_token", "ambiguous_transport_url", "conflicting_query_url", "policy_notice"],
  system_diagnostic_log: ["diag_id", "subsystem", "error_class", "system_code", "diagnostic_message", "remediation_rabbit_hole"],
};
const HONEY_VIEW = "v_enclave_active_topology";

export function isSqlite(path: string): boolean {
  const head = Buffer.alloc(SQLITE_MAGIC.length);
  const fd = openSync(path, "r");
  try {
    return readSync(fd, head, 0, head.length, 0) === head.length && head.equals(SQLITE_MAGIC);
  } finally {
    closeSync(fd);
  }
}

export interface SqliteHoney {
  tables: string[];
  view: boolean;
  /** Tables whose name has `enclave_` but that are not BLA's: kept, left to the analyst. */
  suspects: string[];
}

const quote = (id: string): string => `"${id.replaceAll('"', '""')}"`;

function findIn(db: Database): SqliteHoney {
  const names = db.query<{ name: string; type: string }, []>("SELECT name, type FROM sqlite_schema WHERE type IN ('table','view')").all();
  const tables: string[] = [];
  const suspects: string[] = [];
  for (const { name, type } of names) {
    if (type !== "table") continue;
    const want = HONEY_TABLES[name];
    const cols = db.query<{ name: string }, [string]>("SELECT name FROM pragma_table_xinfo(?)").all(name).map((c) => c.name);
    if (want && cols.length === want.length && cols.every((c, i) => c === want[i])) tables.push(name);
    else if (name.includes("enclave_")) suspects.push(name);
  }
  const view = names.some((n) => n.type === "view" && n.name === HONEY_VIEW);
  return { tables, view, suspects };
}

export function findHoney(path: string): SqliteHoney {
  const db = new Database(path, { readonly: true });
  try {
    return findIn(db);
  } finally {
    db.close();
  }
}

/** Drop the honey objects from the database at `path` (a copy) and compact it. Returns what was dropped. */
export function dropHoney(path: string): SqliteHoney {
  const db = new Database(path);
  try {
    const honey = findIn(db);
    if (!honey.tables.length && !honey.view) return honey;
    db.run("PRAGMA journal_mode = DELETE");
    if (honey.view) db.run(`DROP VIEW ${quote(HONEY_VIEW)}`);
    for (const t of honey.tables) db.run(`DROP TABLE ${quote(t)}`);
    db.run("VACUUM");
    return honey;
  } finally {
    db.close();
  }
}
