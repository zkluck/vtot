import { app } from 'electron';
import Database from 'better-sqlite3';
import path from 'node:path';
import type { PersistedJob, JobStatus, AppError } from '@vtot/shared';

/**
 * db.ts: 封装 SQLite 数据库操作。
 * 
 * 职责：
 * 1) 初始化数据库表结构。
 * 2) 维护任务状态的持久化（作为权威数据源）。
 * 3) 提供类型安全的 CRUD 接口。
 */

let db: Database.Database | null = null;

/**
 * 获取数据库实例（单例）。
 */
export const getDb = (): Database.Database => {
  if (db) return db;

  const dbPath = path.join(app.getPath('userData'), 'vtot.db');
  db = new Database(dbPath);

  // 优化性能
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // 初始化表结构
  initSchema(db);

  return db;
};

/**
 * 初始化数据库表结构。
 */
const initSchema = (database: Database.Database): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      step TEXT,
      source_path TEXT NOT NULL,
      import_strategy TEXT NOT NULL,
      options_json TEXT NOT NULL,
      error_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      app_version TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
  `);
};

/**
 * SQLite `jobs` 表的行结构。
 */
interface JobRow {
  job_id: string;
  status: string;
  step: string | null;
  source_path: string;
  import_strategy: string;
  options_json: string;
  error_json: string | null;
  created_at: number;
  updated_at: number;
  app_version: string;
}

/**
 * 将 DB 行映射为 PersistedJob 对象。
 * 
 * 说明：使用 JobRow 接口避免 any，符合全量类型化要求。
 */
const mapRowToJob = (row: JobRow): PersistedJob => {
  return {
    schemaVersion: '1.0',
    jobId: row.job_id,
    status: row.status as JobStatus,
    step: row.step || undefined,
    source: {
      originalPath: row.source_path,
      importStrategy: row.import_strategy as any, // 这里的 any 是因为 SourceImportStrategy 是 enum 字符串，DB 存的是 string
    },
    options: JSON.parse(row.options_json),
    error: row.error_json ? JSON.parse(row.error_json) : undefined,
    meta: {
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdByAppVersion: row.app_version,
    },
  };
};

/**
 * 插入或更新任务。
 */
export const upsertJob = (job: PersistedJob): void => {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO jobs (
      job_id, status, step, source_path, import_strategy, 
      options_json, error_json, created_at, updated_at, app_version
    ) VALUES (
      @job_id, @status, @step, @source_path, @import_strategy,
      @options_json, @error_json, @created_at, @updated_at, @app_version
    )
    ON CONFLICT(job_id) DO UPDATE SET
      status = excluded.status,
      step = excluded.step,
      error_json = excluded.error_json,
      updated_at = excluded.updated_at
  `);

  stmt.run({
    job_id: job.jobId,
    status: job.status,
    step: job.step || null,
    source_path: job.source.originalPath,
    import_strategy: job.source.importStrategy,
    options_json: JSON.stringify(job.options),
    error_json: job.error ? JSON.stringify(job.error) : null,
    created_at: job.meta.createdAt,
    updated_at: job.meta.updatedAt,
    app_version: job.meta.createdByAppVersion,
  });
};

/**
 * 更新任务状态。
 */
export const updateJobStatus = (
  jobId: string, 
  status: JobStatus, 
  step?: string, 
  error?: AppError
): void => {
  const database = getDb();
  const stmt = database.prepare(`
    UPDATE jobs SET 
      status = ?, 
      step = ?, 
      error_json = ?, 
      updated_at = ?
    WHERE job_id = ?
  `);

  stmt.run(
    status,
    step || null,
    error ? JSON.stringify(error) : null,
    Date.now(),
    jobId
  );
};

/**
 * 获取单个任务。
 */
export const getJob = (jobId: string): PersistedJob | null => {
  const database = getDb();
  const row = database.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as JobRow | undefined;
  return row ? mapRowToJob(row) : null;
};

/**
 * 获取所有任务。
 */
export const listJobs = (): PersistedJob[] => {
  const database = getDb();
  const rows = database.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all() as JobRow[];
  return rows.map(mapRowToJob);
};
