import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/dia2png.js', import.meta.url));
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A stand-in for the real `dia` binary. It understands the flags dia2png uses,
// records each invocation, and its behaviour is controlled by env vars:
//   FAKE_DIA_LOG         file to append one JSON line of argv per call
//   FAKE_DIA_MODE=nopng  exit 0 without writing anything
//   FAKE_DIA_FAIL_MATCH  exit 3 with an error when the input path contains this
// The shebang points at the current node binary so the fake works even when
// PATH contains nothing but the fake's own directory.
const FAKE_DIA = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_DIA_LOG) {
  fs.appendFileSync(process.env.FAKE_DIA_LOG, JSON.stringify(args) + '\\n');
}
const out = args[args.indexOf('-e') + 1];
const input = args[args.length - 1];
if (process.env.FAKE_DIA_FAIL_MATCH && input.includes(process.env.FAKE_DIA_FAIL_MATCH)) {
  process.stderr.write('dia error: need valid input file ' + input + '\\n');
  process.exit(3);
}
if (process.env.FAKE_DIA_MODE === 'nopng') process.exit(0);
if (!fs.existsSync(input)) {
  process.stdout.write('Missing input: ' + input + '\\n');
  process.exit(0);
}
fs.writeFileSync(out, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
process.stdout.write(input + ' --> ' + out + '\\n');
`;

let sandbox; // per-suite temp root
let fakeBin; // directory holding the fake `dia`
let emptyBin; // directory with no `dia`, for the missing-binary test
let work; // per-test working directory (the CLI's cwd)
let logFile;

before(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'dia2png-test-'));
  fakeBin = path.join(sandbox, 'bin');
  emptyBin = path.join(sandbox, 'empty-bin');
  mkdirSync(fakeBin);
  mkdirSync(emptyBin);
  writeFileSync(path.join(fakeBin, 'dia'), FAKE_DIA);
  chmodSync(path.join(fakeBin, 'dia'), 0o755);
});

after(() => rmSync(sandbox, { recursive: true, force: true }));

let counter = 0;
beforeEach(() => {
  work = path.join(sandbox, `case ${++counter}`); // contains a space on purpose
  mkdirSync(work);
  logFile = path.join(work, '..', `dia-calls-${counter}.log`);
});

/** Run the CLI in `work` with the fake dia as the only thing on PATH. */
function runCli(args = [], { env = {}, pathDir = fakeBin } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: work,
    encoding: 'utf8',
    env: { PATH: pathDir, FAKE_DIA_LOG: logFile, ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Each recorded dia invocation as an argv array. */
function diaCalls() {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

/** Create a file (and parent dirs) relative to `work`; returns its absolute path. */
function touch(rel, content = '<dia/>', mtimeSeconds) {
  const file = path.join(work, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mtimeSeconds !== undefined) utimesSync(file, mtimeSeconds, mtimeSeconds);
  return file;
}

const OLD = 1_700_000_000; // older timestamp
const NEW = 1_800_000_000; // newer timestamp

function assertIsFakePng(file) {
  assert.ok(existsSync(file), `expected ${file} to exist`);
  assert.deepEqual(readFileSync(file), PNG_MAGIC);
}

/** No temporary export files may be left behind anywhere under `work`. */
function assertNoTempFiles() {
  const leftovers = readdirSync(work, { recursive: true }).filter((f) => String(f).includes('.dia2png-'));
  assert.deepEqual(leftovers, []);
}

const skipOnWindows = { skip: process.platform === 'win32' && 'fake dia is a POSIX script' };

describe('dia2png CLI', skipOnWindows, () => {
  test('converts .dia files in nested folders, writing each PNG beside its source', () => {
    touch('content/top.dia');
    touch('content/a/b/deep.dia');
    touch('content/a/sibling.DIA');
    touch('content/a/not-a-diagram.txt');

    const { code, stdout } = runCli();

    assert.equal(code, 0);
    assertIsFakePng(path.join(work, 'content/top.png'));
    assertIsFakePng(path.join(work, 'content/a/b/deep.png'));
    assertIsFakePng(path.join(work, 'content/a/sibling.png'));
    assert.equal(diaCalls().length, 3);
    assert.match(stdout, /Summary: 3 converted, 0 skipped \(up to date\), 0 failed\./);
    assertNoTempFiles();
  });

  test('defaults to the "content" directory and accepts an explicit one', () => {
    touch('content/in-content.dia');
    touch('docs/in-docs.dia');

    assert.equal(runCli().code, 0);
    assert.ok(existsSync(path.join(work, 'content/in-content.png')));
    assert.ok(!existsSync(path.join(work, 'docs/in-docs.png')));

    assert.equal(runCli(['docs']).code, 0);
    assert.ok(existsSync(path.join(work, 'docs/in-docs.png')));
  });

  test('skips hidden directories and node_modules', () => {
    touch('content/visible.dia');
    touch('content/.git/hidden.dia');
    touch('content/node_modules/pkg/dep.dia');

    const { code } = runCli();

    assert.equal(code, 0);
    assert.equal(diaCalls().length, 1);
    assert.ok(!existsSync(path.join(work, 'content/.git/hidden.png')));
  });

  test('handles paths containing spaces, passing them as single arguments', () => {
    touch('content/my docs/my diagram.dia');

    const { code } = runCli();

    assert.equal(code, 0);
    assertIsFakePng(path.join(work, 'content/my docs/my diagram.png'));
    const [args] = diaCalls();
    assert.equal(args.at(-1), path.join('content', 'my docs', 'my diagram.dia'));
    assert.match(args[args.indexOf('-e') + 1], /my docs[/\\]\.my diagram\.dia2png-.*\.png$/);
  });

  test('calls dia with -n -t png -e <output> <input>', () => {
    touch('content/x.dia');

    runCli();

    const [args] = diaCalls();
    assert.deepEqual(args.slice(0, 4), ['-n', '-t', 'png', '-e']);
    assert.match(args[4], /\.png$/);
    assert.equal(args.length, 6);
    assert.ok(!args.includes('-s'));
  });

  test('skips files whose PNG is at least as new as the .dia file', () => {
    touch('content/fresh.dia', '<dia/>', OLD);
    touch('content/fresh.png', 'existing', NEW);
    touch('content/same-age.dia', '<dia/>', OLD);
    touch('content/same-age.png', 'existing', OLD);
    touch('content/stale.dia', '<dia/>', NEW);
    touch('content/stale.png', 'existing', OLD);

    const { code, stdout } = runCli();

    assert.equal(code, 0);
    assert.equal(readFileSync(path.join(work, 'content/fresh.png'), 'utf8'), 'existing');
    assert.equal(readFileSync(path.join(work, 'content/same-age.png'), 'utf8'), 'existing');
    assertIsFakePng(path.join(work, 'content/stale.png'));
    assert.equal(diaCalls().length, 1);
    assert.match(stdout, /Summary: 1 converted, 2 skipped \(up to date\), 0 failed\./);
  });

  test('--force converts files even when their PNG is up to date', () => {
    touch('content/fresh.dia', '<dia/>', OLD);
    touch('content/fresh.png', 'existing', NEW);

    const { code, stdout } = runCli(['--force']);

    assert.equal(code, 0);
    assertIsFakePng(path.join(work, 'content/fresh.png'));
    assert.match(stdout, /Summary: 1 converted, 0 skipped/);
  });

  test('--size is passed through to dia as -s <WxH>', () => {
    touch('content/x.dia');

    const { code } = runCli(['--size', '800x600']);

    assert.equal(code, 0);
    const [args] = diaCalls();
    const i = args.indexOf('-s');
    assert.ok(i !== -1, 'expected -s flag');
    assert.equal(args[i + 1], '800x600');
    assert.equal(args.at(-1), path.join('content', 'x.dia'));

    runCli(['-s', '1024x', '--force']);
    assert.equal(diaCalls()[1][diaCalls()[1].indexOf('-s') + 1], '1024x');
  });

  test('rejects a malformed --size with exit code 2 and does not call dia', () => {
    touch('content/x.dia');

    const { code, stderr } = runCli(['--size', 'big']);

    assert.equal(code, 2);
    assert.match(stderr, /invalid --size 'big'/);
    assert.equal(diaCalls().length, 0);
  });

  test('--check lists out-of-date files, writes nothing, and exits 1', () => {
    touch('content/missing-png.dia');
    touch('content/stale.dia', '<dia/>', NEW);
    touch('content/stale.png', 'existing', OLD);
    touch('content/fresh.dia', '<dia/>', OLD);
    touch('content/fresh.png', 'existing', NEW);

    const { code, stdout } = runCli(['--check']);

    assert.equal(code, 1);
    assert.match(stdout, /out of date: content[/\\]missing-png\.dia/);
    assert.match(stdout, /out of date: content[/\\]stale\.dia/);
    assert.doesNotMatch(stdout, /fresh\.dia/);
    assert.match(stdout, /2 files of 3 need conversion/);
    assert.equal(diaCalls().length, 0);
    assert.ok(!existsSync(path.join(work, 'content/missing-png.png')));
    assert.equal(readFileSync(path.join(work, 'content/stale.png'), 'utf8'), 'existing');
  });

  test('--check exits 0 when everything is up to date, even without dia installed', () => {
    touch('content/fresh.dia', '<dia/>', OLD);
    touch('content/fresh.png', 'existing', NEW);

    const { code, stdout } = runCli(['--check'], { pathDir: emptyBin });

    assert.equal(code, 0);
    assert.match(stdout, /All 1 file up to date/);
  });

  test('a missing dia binary prints install instructions and exits 1', () => {
    touch('content/x.dia');

    const { code, stderr } = runCli([], { pathDir: emptyBin });

    assert.equal(code, 1);
    assert.match(stderr, /'dia' command was not found/);
    assert.match(stderr, /apt-get install dia/);
    assert.ok(!existsSync(path.join(work, 'content/x.png')));
  });

  test('a failed conversion is reported, the rest continue, and the exit code is 1', () => {
    touch('content/a-good.dia');
    touch('content/b-broken.dia');
    touch('content/c-good.dia');

    const { code, stdout, stderr } = runCli([], { env: { FAKE_DIA_FAIL_MATCH: 'b-broken' } });

    assert.equal(code, 1);
    assert.match(stderr, /FAILED: content[/\\]b-broken\.dia/);
    assert.match(stderr, /dia exited with code 3/);
    assert.match(stderr, /need valid input file/);
    assertIsFakePng(path.join(work, 'content/a-good.png'));
    assertIsFakePng(path.join(work, 'content/c-good.png'));
    assert.ok(!existsSync(path.join(work, 'content/b-broken.png')));
    assert.equal(diaCalls().length, 3);
    assert.match(stdout, /Summary: 2 converted, 0 skipped \(up to date\), 1 failed\./);
    assertNoTempFiles();
  });

  test('a successful dia exit that writes no PNG is treated as a failure', () => {
    touch('content/x.dia');

    const { code, stdout, stderr } = runCli([], { env: { FAKE_DIA_MODE: 'nopng' } });

    assert.equal(code, 1);
    assert.match(stderr, /FAILED: content[/\\]x\.dia/);
    assert.match(stderr, /did not write a PNG/);
    assert.match(stdout, /Summary: 0 converted, 0 skipped \(up to date\), 1 failed\./);
    assert.ok(!existsSync(path.join(work, 'content/x.png')));
  });

  test('a stale PNG left over from before does not hide a no-output failure', () => {
    touch('content/x.dia', '<dia/>', NEW);
    touch('content/x.png', 'old render', OLD);

    const { code, stderr } = runCli([], { env: { FAKE_DIA_MODE: 'nopng' } });

    assert.equal(code, 1);
    assert.match(stderr, /did not write a PNG/);
    assert.equal(readFileSync(path.join(work, 'content/x.png'), 'utf8'), 'old render');
  });

  test('no .dia files found prints a message and exits 0', () => {
    touch('content/readme.md', '# hi');

    const { code, stdout } = runCli();

    assert.equal(code, 0);
    assert.match(stdout, /No \.dia files found in 'content'/);
    assert.equal(diaCalls().length, 0);
  });

  test('a missing directory is an error with exit code 1', () => {
    const { code, stderr } = runCli(['nope']);

    assert.equal(code, 1);
    assert.match(stderr, /directory 'nope' does not exist/);
  });

  test('more than one directory argument is a usage error', () => {
    const { code, stderr } = runCli(['a', 'b']);

    assert.equal(code, 2);
    assert.match(stderr, /Usage: dia2png/);
  });

  test('--help prints usage and exits 0', () => {
    const { code, stdout } = runCli(['--help']);

    assert.equal(code, 0);
    assert.match(stdout, /Usage: dia2png \[directory\] \[--size <WxH>\] \[--force\] \[--check\]/);
  });
});
