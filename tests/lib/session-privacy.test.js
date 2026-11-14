'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { extractConversationText } = require('../../scripts/lib/llm-summary');
const { readTranscriptTail, redactSessionSecrets, writePrivateSessionFile } = require('../../scripts/lib/session-privacy');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-privacy-'));
try {
  const transcript = path.join(dir, 'large.jsonl');
  fs.writeFileSync(transcript, 'x'.repeat(5 * 1024 * 1024) + '\n{"type":"user","content":"recent"}\n');
  const result = readTranscriptTail(transcript);
  assert.strictEqual(result.truncated, true);
  assert.strictEqual(result.text, '{"type":"user","content":"recent"}\n');
  assert.strictEqual(readTranscriptTail(dir), null);
  const secret = 'sk-' + 'a'.repeat(30);
  assert(!redactSessionSecrets(`API_KEY=${secret}\nAuthorization: Bearer private-token\npassword="secret words"`).includes(secret));
  assert.strictEqual(redactSessionSecrets('password="secret words"'), 'password=[REDACTED]');
  assert(!redactSessionSecrets('-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----').includes('secret'));
  const file = path.join(dir, 'summary.tmp');
  writePrivateSessionFile(file, 'first');
  writePrivateSessionFile(file, 'second');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'second');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    const link = path.join(dir, 'link.tmp');
    fs.symlinkSync(file, link);
    assert.throws(() => writePrivateSessionFile(link, 'unsafe'), /symbolic/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'second');
  }
  // A failed atomic replacement retains the original bytes and removes staging.
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error('synthetic rename failure'); };
    assert.throws(() => writePrivateSessionFile(file, 'uncommitted'), /synthetic rename failure/);
  } finally {
    fs.renameSync = rename;
  }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'second');
  assert.deepStrictEqual(fs.readdirSync(dir).filter(name => name.endsWith('.pending')), []);
  // Redaction runs on complete messages before their display limits are applied.
  const boundarySecret = 'sk-' + 's'.repeat(40);
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', content: 'x'.repeat(390) + boundarySecret }) + '\n');
  const conversation = extractConversationText(transcript);
  assert(!conversation.includes('sk-'));
  assert(conversation.includes('[REDACTED]'));
  assert.strictEqual(redactSessionSecrets('"password": "private words"'), '"password": [REDACTED]');

  // A window beginning at a record boundary must retain that complete record.
  const alignedRecord = JSON.stringify({ type: 'user', content: 'aligned record' }) + '\n';
  const finalRecord = JSON.stringify({ type: 'user', content: 'recent record' }) + '\n';
  const limit = 4 * 1024 * 1024;
  fs.writeFileSync(transcript, 'discarded\n' + alignedRecord + ' '.repeat(limit - alignedRecord.length - finalRecord.length - 1) + '\n' + finalRecord);
  assert(readTranscriptTail(transcript).text.startsWith(alignedRecord));

  const home = path.join(dir, 'home');
  const data = path.join(home, '.claude');
  const sessions = path.join(data, 'session-data');
  fs.mkdirSync(home);
  const hook = path.resolve(__dirname, '../../scripts/hooks/session-end.js');
  const runHook = () => {
    const run = spawnSync(process.execPath, [hook], {
      cwd: dir, encoding: 'utf8', timeout: 10000,
      input: JSON.stringify({ transcript_path: transcript }),
      env: { ...process.env, HOME: home, USERPROFILE: home, ECC_AGENT_DATA_HOME: data,
        ECC_SESSION_ID: 'privacy-test', CLAUDE_SESSION_ID: 'privacy-test',
        ECC_SKIP_LLM_SUMMARY: '1', ECC_LLM_SUMMARY_SUBPROCESS: '',
        ECC_LLM_SUMMARY_INTERVAL: '1' },
    });
    assert.ifError(run.error);
    assert.strictEqual(run.status, 0, run.stderr);
    return run;
  };
  const writeTranscript = () => fs.writeFileSync(transcript, [
    { type: 'user', content: 'x'.repeat(190) + boundarySecret },
    { type: 'user', content: '"password": "private words"' },
    { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/' + boundarySecret } },
  ].map(entry => JSON.stringify(entry)).join('\n'));
  writeTranscript();
  runHook();
  const session = path.join(sessions, fs.readdirSync(sessions)[0]);
  let summary = fs.readFileSync(session, 'utf8');
  assert(!summary.includes('sk-'));
  assert(!summary.includes('private words'));
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(session).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(sessions).mode & 0o777, 0o700);
  }
  if (process.platform !== 'win32') {
    fs.chmodSync(sessions, 0o755);
    runHook();
    assert.strictEqual(fs.statSync(sessions).mode & 0o777, 0o700);
  }
  // Existing user notes are outside generated content, including secret-like text.
  const manualNotes = '### Notes for Next Session\npassword=manual-note\n';
  fs.writeFileSync(session, '# Old session\n\n---\n## Session Summary\nOld generated text\n\n' + manualNotes);
  runHook();
  summary = fs.readFileSync(session, 'utf8');
  assert(summary.includes(manualNotes));
  assert(!summary.includes('Old generated text'));
  runHook();
  assert(fs.readFileSync(session, 'utf8').includes(manualNotes));
  fs.writeFileSync(transcript, 'x'.repeat(5 * 1024 * 1024) + '\n' + finalRecord);
  runHook();
  summary = fs.readFileSync(session, 'utf8');
  assert(summary.includes('User messages in last 4 MiB (older context omitted): 1'));
  assert(summary.includes('recent record'));
  assert(summary.includes(manualNotes));
  if (process.platform !== 'win32') {
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    const redirected = path.join(home, 'redirected');
    fs.symlinkSync(outside, redirected);
    assert.throws(() => writePrivateSessionFile(path.join(redirected, 'nested', 'file.tmp'), 'unsafe'), /symbolic/);
    assert.deepStrictEqual(fs.readdirSync(outside), []);
    const original = fs.readFileSync(session, 'utf8');
    fs.unlinkSync(session);
    fs.symlinkSync(file, session);
    writeTranscript();
    const rejected = runHook();
    assert(rejected.stderr.includes('symbolic'));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'second');
    assert(original.includes(manualNotes));
  }
  console.log('session privacy: passed bounded-tail, redaction, atomic replacement, private permissions and symlink protection');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
