import { execFile } from 'node:child_process';
import { readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

/** Directories never descended into while searching for .dia files. */
const IGNORED_DIRS = new Set(['node_modules']);

export class DiaNotFoundError extends Error {
  constructor(command) {
    super(`'${command}' command not found`);
    this.name = 'DiaNotFoundError';
    this.command = command;
  }
}

/**
 * Recursively find every .dia file under `dir`, sorted for stable output.
 * Hidden directories (".git", ".cache", ...) and node_modules are skipped.
 * Symlinked directories are not followed, which avoids cycles.
 */
export async function findDiaFiles(dir) {
  const found = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !IGNORED_DIRS.has(entry.name)) {
          await walk(full);
        }
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.dia') {
        found.push(full);
      }
    }
  }
  await walk(dir);
  return found.sort();
}

/** The PNG path written beside a .dia file: same directory, same base name. */
export function pngPathFor(diaPath) {
  const { dir, name } = path.parse(diaPath);
  return path.join(dir, `${name}.png`);
}

/** True when the PNG is missing or older than its .dia source. */
export async function isOutOfDate(diaPath, pngPath = pngPathFor(diaPath)) {
  let pngStat;
  try {
    pngStat = await stat(pngPath);
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
  const diaStat = await stat(diaPath);
  return pngStat.mtimeMs < diaStat.mtimeMs;
}

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function removeQuietly(file) {
  try {
    await unlink(file);
  } catch {
    // Already gone or never created.
  }
}

/**
 * Convert one .dia file to PNG with the dia CLI.
 *
 * Dia exports to a temporary file in the same directory, which is renamed over
 * the final PNG only after the export succeeded and produced a non-empty file.
 * This means a stale PNG can never be mistaken for fresh output (Dia exits 0
 * even for a missing input), and a failed export never leaves a broken PNG.
 *
 * Throws DiaNotFoundError if the dia executable cannot be found, and a plain
 * Error describing the failure otherwise.
 */
export async function convertFile(diaPath, { size, command = 'dia' } = {}) {
  const pngPath = pngPathFor(diaPath);
  const { dir, name } = path.parse(diaPath);
  const tmpPath = path.join(dir, `.${name}.dia2png-${process.pid}-${Date.now()}.png`);

  const args = ['-n', '-t', 'png', '-e', tmpPath];
  if (size) args.push('-s', size);
  args.push(diaPath);

  const { error, stdout, stderr } = await run(command, args);
  try {
    if (error) {
      if (error.code === 'ENOENT') throw new DiaNotFoundError(command);
      const detail = (stderr || stdout).trim();
      const reason =
        typeof error.code === 'number' ? `dia exited with code ${error.code}` : error.message;
      throw new Error(detail ? `${reason}\n${detail}` : reason);
    }

    let tmpStat;
    try {
      tmpStat = await stat(tmpPath);
    } catch {
      tmpStat = null;
    }
    if (!tmpStat || !tmpStat.isFile() || tmpStat.size === 0) {
      const detail = (stderr || stdout).trim();
      const reason = 'dia exited successfully but did not write a PNG';
      throw new Error(detail ? `${reason}\n${detail}` : reason);
    }

    await rename(tmpPath, pngPath);
    return pngPath;
  } finally {
    await removeQuietly(tmpPath);
  }
}
