'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

// Summaries are a recent-context cache. Never load an unbounded transcript.
function readTranscriptTail(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, MAX_TRANSCRIPT_BYTES);
    const start = stat.size - length;
    const buffer = Buffer.alloc(length);
    let count = 0;
    while (count < length) {
      const read = fs.readSync(fd, buffer, count, length - count, start + count);
      if (read === 0) break;
      count += read;
    }
    let text = buffer.toString('utf8', 0, count);
    if (start > 0) {
      // Discard the incomplete first record, including a split UTF-8 codepoint.
      const previousByte = Buffer.alloc(1);
      const previousCount = fs.readSync(fd, previousByte, 0, 1, start - 1);
      if (previousCount !== 1 || previousByte[0] !== 10) {
        const newline = text.indexOf('\n');
        text = newline < 0 ? '' : text.slice(newline + 1);
      }
    }
    return { text, truncated: start > 0 };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Best-effort filtering of common credentials; not a general secret detector.
function redactSessionSecrets(text) {
  return text
    .replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/(?:sk-(?:ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    .replace(/(\b(?:api[_-]?key|access[_-]?token|secret|password)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]');
}

function rejectSymbolicDirectories(directory) {
  // Check existing ancestors before mkdir so a redirected ancestor cannot
  // cause us to create session directories outside the requested tree.
  const trustedRoots = new Set([path.resolve(os.homedir()), path.resolve(os.tmpdir())]);
  let current = path.resolve(directory);
  while (!trustedRoots.has(current)) {
    // Home/temp roots are process-configured trust anchors; system aliases
    // above them (e.g. macOS /var -> /private/var) are legitimate.

    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Refusing symbolic session directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function writePrivateSessionFile(filePath, content) {
  const parent = path.dirname(filePath);
  rejectSymbolicDirectories(parent);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  rejectSymbolicDirectories(parent);
  if (process.platform !== 'win32') fs.chmodSync(parent, 0o700);
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error('Refusing symbolic session file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(parent, `.${path.basename(filePath)}.${crypto.randomBytes(12).toString('hex')}.pending`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      // Keep any original write/rename error; the temporary file is private.
      if (error.code !== 'ENOENT') console.error('[SessionPrivacy] Temporary-file cleanup failed');
    }
  }
}

module.exports = { readTranscriptTail, redactSessionSecrets, writePrivateSessionFile };
