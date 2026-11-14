'use strict';

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const initSqlJs = require('sql.js');
const { AsyncLocalStorage } = require('async_hooks');

const { applyMigrations, getAppliedMigrations } = require('./migrations');
const { createQueryApi } = require('./queries');
const { assertValidEntity, validateEntity } = require('./schema');
const {
  buildInstallStateStoreRecord,
  projectInstallState,
  reconcileCurrentInstallState,
  reconcileInstallStateProjections,
  removeInstallStateProjection,
  summarizeProjectedInstallHealth,
} = require('./install-state-projection');

const DEFAULT_STATE_STORE_RELATIVE_PATH = path.join('.claude', 'ecc', 'state.db');
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function stateStorePathError(targetPath, detail) {
  return new Error(`Unsafe state-store path '${targetPath}': ${detail}`);
}

function lstatIfPresent(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function isAllowedPlatformSymlink(targetPath, stats) {
  if (process.platform !== 'darwin' || !stats || stats.uid !== 0) {
    return false;
  }

  const allowedTargets = new Map([
    ['/var', '/private/var'],
    ['/tmp', '/private/tmp'],
    ['/etc', '/private/etc'],
  ]);
  const expectedTarget = allowedTargets.get(targetPath);
  if (!expectedTarget) {
    return false;
  }

  try {
    return fs.realpathSync(targetPath) === expectedTarget;
  } catch (_error) {
    return false;
  }
}

function assertNotSymlink(targetPath, stats) {
  if (stats && stats.isSymbolicLink()) {
    if (isAllowedPlatformSymlink(targetPath, stats)) {
      return;
    }
    throw stateStorePathError(targetPath, 'a symlink is not allowed');
  }
}

function ensurePrivateDirectory(directoryPath) {
  const absolutePath = path.resolve(directoryPath);
  const parsed = path.parse(absolutePath);
  const segments = absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let currentPath = parsed.root;

  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    let stats = lstatIfPresent(currentPath);
    assertNotSymlink(currentPath, stats);

    if (!stats) {
      try {
        fs.mkdirSync(currentPath, { mode: PRIVATE_DIRECTORY_MODE });
      } catch (error) {
        if (!error || error.code !== 'EEXIST') {
          throw error;
        }
      }
      stats = fs.lstatSync(currentPath);
      assertNotSymlink(currentPath, stats);
    }

    if (!stats.isDirectory() && !isAllowedPlatformSymlink(currentPath, stats)) {
      throw stateStorePathError(currentPath, 'an intermediate component is not a directory');
    }
  }

  return absolutePath;
}

function assertSafeDatabaseFile(dbPath) {
  const stats = lstatIfPresent(dbPath);
  assertNotSymlink(dbPath, stats);
  if (stats && !stats.isFile()) {
    throw stateStorePathError(dbPath, 'database path is not a regular file');
  }
  return stats;
}

function readDatabaseFile(dbPath) {
  assertSafeDatabaseFile(dbPath);
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const fileDescriptor = fs.openSync(dbPath, fs.constants.O_RDONLY | noFollow);
  try {
    const stats = fs.fstatSync(fileDescriptor);
    if (!stats.isFile()) {
      throw stateStorePathError(dbPath, 'database path is not a regular file');
    }
    return fs.readFileSync(fileDescriptor);
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

function syncDirectory(directoryPath) {
  if (process.platform === 'win32') {
    return;
  }

  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(directoryPath, fs.constants.O_RDONLY);
    fs.fsyncSync(fileDescriptor);
  } catch (_error) {
    // Some filesystems do not permit directory fsync. The file was still
    // atomically replaced and fsynced before this durability best effort.
  } finally {
    if (fileDescriptor !== undefined) {
      fs.closeSync(fileDescriptor);
    }
  }
}

function writeDatabaseFileAtomic(dbPath, data) {
  const directoryPath = ensurePrivateDirectory(path.dirname(dbPath));
  assertSafeDatabaseFile(dbPath);
  const temporaryPath = path.join(
    directoryPath,
    `.${path.basename(dbPath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow;
  let fileDescriptor;

  try {
    fileDescriptor = fs.openSync(temporaryPath, flags, PRIVATE_FILE_MODE);
    fs.writeFileSync(fileDescriptor, data);
    fs.fchmodSync(fileDescriptor, PRIVATE_FILE_MODE);
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;

    // A final-path symlink is never followed. If one appeared after this
    // check, rename replaces the link itself rather than its target.
    assertSafeDatabaseFile(dbPath);
    fs.renameSync(temporaryPath, dbPath);
    syncDirectory(directoryPath);
  } finally {
    if (fileDescriptor !== undefined) {
      fs.closeSync(fileDescriptor);
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        // Preserve the original persistence result. The temporary file is
        // private, exclusively created, and never used as canonical state.
      }
    }
  }
}

function resolveStateStorePath(options = {}) {
  if (options.dbPath) {
    if (options.dbPath === ':memory:') {
      return options.dbPath;
    }
    return path.resolve(options.dbPath);
  }

  const homeDir = options.homeDir || process.env.HOME || os.homedir();
  return path.join(homeDir, DEFAULT_STATE_STORE_RELATIVE_PATH);
}

/**
 * Wraps a sql.js Database with a better-sqlite3-compatible API surface so
 * that the rest of the state-store code (migrations.js, queries.js) can
 * operate without knowing which driver is in use.
 *
 * IMPORTANT: sql.js db.export() implicitly ends any active transaction, so
 * we must defer all disk writes until after the transaction commits.
 */
function wrapSqlJsDatabase(SQL, dbPath) {
  let rawDb = new SQL.Database();
  let inTransaction = false;
  let accessing = false;
  let closed = false;
  const transactionContext = new AsyncLocalStorage();
  rawDb.run('PRAGMA foreign_keys = ON');

  // sql.js operates on snapshots, not on the SQLite file. Serialize the entire
  // read/modify/export cycle across processes, refreshing before each operation.
  // Never steal a lock: after a crash an operator must verify no writer remains
  // before removing the .lock directory. A busy store fails without writing.
  function access(fn, write = false) {
    if (closed) throw new Error('State store is closed');
    if (transactionContext.getStore()?.active === false) {
      throw new Error('State-store transactions must be synchronous; transaction has ended');
    }
    if (accessing || dbPath === ':memory:') return fn();
    ensurePrivateDirectory(path.dirname(dbPath));
    const lockPath = `${dbPath}.lock`;
    try {
      fs.mkdirSync(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const locked = new Error(`State store is locked: ${lockPath}. Retry after the writer completes; remove an abandoned lock only after verifying no writer is active.`);
      locked.code = 'ECC_STATE_STORE_LOCKED';
      throw locked;
    }
    accessing = true;
    try {
      const next = assertSafeDatabaseFile(dbPath)
        ? new SQL.Database(readDatabaseFile(dbPath))
        : new SQL.Database();
      rawDb.close();
      rawDb = next;
      rawDb.run('PRAGMA foreign_keys = ON');
      const result = fn();
      if (write) {
        writeDatabaseFileAtomic(dbPath, Buffer.from(rawDb.export()));
        rawDb.run('PRAGMA foreign_keys = ON');
      }
      return result;
    } finally {
      accessing = false;
      fs.rmdirSync(lockPath);
    }
  }

  function query(sql, args, first) {
    return access(() => {
      const stmt = rawDb.prepare(sql);
      try {
        if (args.length === 1 && typeof args[0] !== 'object') stmt.bind([args[0]]);
        else if (args.length > 1) stmt.bind(args);
        if (first) return stmt.step() ? stmt.getAsObject() : null;
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally { stmt.free(); }
    }, true);
  }

  return {
    exec(sql) { access(() => { rawDb.run(sql); }, true); },
    pragma(pragmaStr) {
      access(() => { rawDb.run(`PRAGMA ${pragmaStr}`); });
    },
    prepare(sql) {
      return {
        all(...args) { return query(sql, args, false); },
        get(...args) { return query(sql, args, true); },
        run(namedParams) {
          return access(() => {
            const stmt = rawDb.prepare(sql);
            try {
              if (namedParams && typeof namedParams === 'object' && !Array.isArray(namedParams)) {
                const sqlJsParams = {};
                for (const [key, value] of Object.entries(namedParams)) {
                  sqlJsParams[`@${key}`] = value === undefined ? null : value;
                }
                stmt.bind(sqlJsParams);
              }
              stmt.step();
            } finally { stmt.free(); }
          }, true);
        },
      };
    },
    transaction(fn) {
      return (...args) => access(() => {
        if (inTransaction) throw new Error('Nested state-store transactions are unsupported');
        if (fn.constructor?.name === 'AsyncFunction') {
          throw new Error('State-store transactions must be synchronous');
        }
        rawDb.run('BEGIN');
        inTransaction = true;
        const context = { active: true };
        try {
          const result = transactionContext.run(context, () => fn(...args));
          if (result && typeof result.then === 'function') {
            // Observe rejection; the context invalidation in finally prevents
            // escaped continuations from mutating state after rollback.
            transactionContext.run(context, () => Promise.resolve(result).catch(() => {}));
            throw new Error('State-store transactions must be synchronous');
          }
          rawDb.run('COMMIT');
          return result;
        } catch (error) {
          try { rawDb.run('ROLLBACK'); } catch (_) { /* Already rolled back. */ }
          throw error;
        } finally { context.active = false; inTransaction = false; }
      }, true);
    },
    close() {
      if (accessing || inTransaction) throw new Error('Cannot close an active state-store transaction');
      if (!closed) { rawDb.close(); closed = true; }
    },
  };
}

async function openDatabase(SQL, dbPath) {
  if (dbPath !== ':memory:') ensurePrivateDirectory(path.dirname(dbPath));
  return wrapSqlJsDatabase(SQL, dbPath);
}

async function createStateStore(options = {}) {
  const dbPath = resolveStateStorePath(options);
  const SQL = await initSqlJs();
  const db = await openDatabase(SQL, dbPath);
  let appliedMigrations;
  try { appliedMigrations = applyMigrations(db); } catch (error) { db.close(); throw error; }
  const queryApi = createQueryApi(db);

  return {
    dbPath,
    close() {
      db.close();
    },
    getAppliedMigrations() {
      return getAppliedMigrations(db);
    },
    validateEntity,
    assertValidEntity,
    ...queryApi,
    _database: db,
    _migrations: appliedMigrations,
  };
}

module.exports = {
  DEFAULT_STATE_STORE_RELATIVE_PATH,
  buildInstallStateStoreRecord,
  createStateStore,
  projectInstallState,
  reconcileCurrentInstallState,
  reconcileInstallStateProjections,
  removeInstallStateProjection,
  resolveStateStorePath,
  summarizeProjectedInstallHealth,
};
