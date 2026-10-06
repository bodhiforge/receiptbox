import {DatabaseSync} from 'node:sqlite';
import {normal,searchText} from '../public/receipts.mjs';

export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = action();
    if (value?.then) throw new Error('Database transactions must not await external work.');
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const migrations = [
  {version: 1, name: 'baseline', sql: `
    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY, number INTEGER UNIQUE NOT NULL, created TEXT NOT NULL,
      updated TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, details TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES receipts(id),
      hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_files_receipt ON files(receipt_id);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES receipts(id),
      created TEXT NOT NULL, type TEXT NOT NULL, details TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_events_receipt ON events(receipt_id,id);
    CREATE TABLE IF NOT EXISTS company_profile(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS receipt_ai (
      id INTEGER PRIMARY KEY, receipt TEXT NOT NULL REFERENCES receipts(id), fingerprint TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL,
      result TEXT, error TEXT, model TEXT, notified INTEGER NOT NULL DEFAULT 0, UNIQUE(receipt,fingerprint));
    CREATE INDEX IF NOT EXISTS idx_ai_queue ON receipt_ai(status,id);
    CREATE TABLE IF NOT EXISTS telegram_offsets(bot TEXT PRIMARY KEY,next_offset INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS telegram_receipts (
      bot TEXT NOT NULL,chat TEXT NOT NULL,message INTEGER NOT NULL,receipt TEXT NOT NULL REFERENCES receipts(id),
      reply INTEGER,transport TEXT NOT NULL,PRIMARY KEY(bot,chat,message));
    CREATE TABLE IF NOT EXISTS telegram_followups (
      bot TEXT,chat TEXT,message INTEGER,receipt TEXT NOT NULL REFERENCES receipts(id),PRIMARY KEY(bot,chat,message));
    CREATE TABLE IF NOT EXISTS telegram_notifications (
      bot TEXT NOT NULL,job INTEGER NOT NULL,chat TEXT NOT NULL,message INTEGER NOT NULL,
      receipt TEXT NOT NULL REFERENCES receipts(id),PRIMARY KEY(bot,job));
  `},
  {version: 2, name: 'leased-jobs-and-notification-outbox', sql: `
    ALTER TABLE receipt_ai ADD COLUMN lease_token TEXT;
    ALTER TABLE receipt_ai ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE receipt_ai ADD COLUMN next_attempt INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE receipt_ai ADD COLUMN pipeline_version TEXT NOT NULL DEFAULT 'legacy';
    CREATE TABLE notification_outbox (
      id INTEGER PRIMARY KEY,job INTEGER NOT NULL UNIQUE REFERENCES receipt_ai(id),
      status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
      error TEXT,created TEXT NOT NULL,updated TEXT NOT NULL);
    INSERT INTO notification_outbox(job,created,updated)
      SELECT id,created,updated FROM receipt_ai WHERE status IN ('ready','failed') AND notified=0;
    CREATE TABLE worker_health(name TEXT PRIMARY KEY,updated INTEGER NOT NULL,details TEXT NOT NULL);
  `},
  {version: 3, name: 'durable-telegram-inbox', sql: `
    CREATE TABLE telegram_updates (
      bot TEXT NOT NULL,id INTEGER NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,error TEXT,
      created TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(bot,id));
    CREATE INDEX idx_telegram_pending ON telegram_updates(bot,status,next_attempt,id);
  `},
  {version: 4, name: 'documents-and-expense-evidence', sql: `
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,created TEXT NOT NULL);
    CREATE TABLE expense_documents (
      expense_id TEXT NOT NULL REFERENCES receipts(id),document_id TEXT NOT NULL REFERENCES documents(id),
      name TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(expense_id,document_id));
    CREATE INDEX idx_evidence_document ON expense_documents(document_id);
    INSERT INTO documents SELECT id,hash,mime,size,created FROM files;
    INSERT INTO expense_documents SELECT receipt_id,id,name,created FROM files;
    DROP TABLE files;
    CREATE VIEW files AS SELECT d.id,e.expense_id receipt_id,d.hash,e.name,d.mime,d.size,e.created
      FROM documents d JOIN expense_documents e ON e.document_id=d.id;
    CREATE INDEX idx_receipt_date ON receipts(json_extract(details,'$.date'),number);
    CREATE INDEX idx_receipt_category ON receipts(json_extract(details,'$.category'),number);
    CREATE INDEX idx_receipt_status ON receipts(json_extract(details,'$.status'),number);
    CREATE INDEX idx_receipt_currency_date ON receipts(json_extract(details,'$.currency'),json_extract(details,'$.date'));
  `},
  {version: 5, name: 'search-projection', sql: `
    CREATE TABLE receipt_search(id TEXT PRIMARY KEY REFERENCES receipts(id),text TEXT NOT NULL);
  `,after: db=>{
    for(const row of db.prepare('SELECT * FROM receipts').all()){
      const files=db.prepare('SELECT name FROM files WHERE receipt_id=?').all(row.id);
      db.prepare('INSERT INTO receipt_search VALUES(?,?)').run(row.id,searchText({...JSON.parse(row.details),created:row.created,reference:`RC-${String(row.number).padStart(5,'0')}`,files}));
    }
  }},
  {version:6,name:'recoverable-receipt-trash',sql:`ALTER TABLE receipts ADD COLUMN deleted_at TEXT;`},
  {version:7,name:'duplicate-confirmation',sql:`ALTER TABLE receipts ADD COLUMN duplicate_of TEXT; ALTER TABLE receipts ADD COLUMN duplicate_key TEXT; ALTER TABLE receipts ADD COLUMN duplicate_decision TEXT;`},
];

export function migrate(db) {
  db.function('normalise',{deterministic:true},normal);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied TEXT NOT NULL)');
  const current = db.prepare('SELECT coalesce(max(version),0) version FROM schema_migrations').get().version;
  if (current > migrations.at(-1).version) throw new Error('Database belongs to a newer application release.');
  for (const migration of migrations) {
    transaction(db, () => {
      if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(migration.version)) return;
      db.exec(migration.sql);
      migration.after?.(db);
      db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(migration.version,migration.name,new Date().toISOString());
      db.exec(`PRAGMA user_version=${migration.version}`);
    });
  }
  return db;
}

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  try { return migrate(db); } catch (error) { db.close(); throw error; }
}
