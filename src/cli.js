import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DiaNotFoundError, convertFile, findDiaFiles, isOutOfDate } from './index.js';

const USAGE = `Usage: dia2png [directory] [--size <WxH>] [--force] [--check]

Convert every .dia file under <directory> (default: "content") to a PNG
written beside it with the same base name.

Options:
  -s, --size <WxH>  Export size passed to dia, e.g. 800x600, 800x or x600
  -f, --force       Convert all files, even if the PNG is up to date
  -c, --check       List files that need conversion without writing anything;
                    exit with code 1 if any are out of date
  -h, --help        Show this help
  -v, --version     Show the version

Exit codes:
  0  success (or nothing to do)
  1  a conversion failed, dia is missing, the directory is missing,
     or (with --check) files are out of date
  2  invalid command-line arguments`;

const INSTALL_HELP = `Error: the 'dia' command was not found on your PATH.

dia2png uses the Dia diagram editor to render PNGs. Install it first:
  Debian/Ubuntu:  sudo apt-get install dia
  Fedora:         sudo dnf install dia
  Arch Linux:     sudo pacman -S dia
  macOS/Windows:  download it from http://dia-installer.de/

Then check that 'dia --version' works in this shell.`;

const SIZE_PATTERN = /^(\d+x\d*|\d*x\d+)$/;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function version() {
  const pkgUrl = new URL('../package.json', import.meta.url);
  return JSON.parse(await readFile(pkgUrl, 'utf8')).version;
}

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      size: { type: 'string', short: 's' },
      force: { type: 'boolean', short: 'f', default: false },
      check: { type: 'boolean', short: 'c', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (positionals.length > 1) {
    throw new Error(`expected at most one directory, got ${positionals.length}`);
  }
  if (values.size !== undefined && !SIZE_PATTERN.test(values.size)) {
    throw new Error(`invalid --size '${values.size}', expected WxH such as 800x600`);
  }
  return { ...values, directory: positionals[0] ?? 'content' };
}

/**
 * Run the CLI and resolve with the process exit code.
 * Never calls process.exit, so it is safe to call from tests or other tools.
 */
export async function main(argv) {
  let opts;
  try {
    opts = parse(argv);
  } catch (err) {
    console.error(`dia2png: ${err.message}\n\n${USAGE}`);
    return 2;
  }

  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.version) {
    console.log(await version());
    return 0;
  }

  const root = opts.directory;
  try {
    if (!(await stat(root)).isDirectory()) {
      console.error(`dia2png: '${root}' is not a directory`);
      return 1;
    }
  } catch {
    console.error(`dia2png: directory '${root}' does not exist`);
    return 1;
  }

  const files = await findDiaFiles(root);
  if (files.length === 0) {
    console.log(`No .dia files found in '${root}'.`);
    return 0;
  }

  const display = (file) => path.relative(process.cwd(), file) || file;

  if (opts.check) {
    const stale = [];
    for (const file of files) {
      if (opts.force || (await isOutOfDate(file))) stale.push(file);
    }
    for (const file of stale) console.log(`out of date: ${display(file)}`);
    if (stale.length > 0) {
      console.log(`\n${plural(stale.length, 'file')} of ${files.length} need conversion.`);
      return 1;
    }
    console.log(`All ${plural(files.length, 'file')} up to date.`);
    return 0;
  }

  let converted = 0;
  let skipped = 0;
  let failed = 0;

  // Sequential on purpose: Dia is a heavyweight GTK app and running many at
  // once is rarely faster and makes failures harder to read.
  for (const file of files) {
    if (!opts.force && !(await isOutOfDate(file))) {
      skipped++;
      continue;
    }
    try {
      const png = await convertFile(file, { size: opts.size });
      converted++;
      console.log(`converted: ${display(file)} -> ${display(png)}`);
    } catch (err) {
      if (err instanceof DiaNotFoundError) {
        console.error(INSTALL_HELP);
        return 1;
      }
      failed++;
      console.error(`FAILED: ${display(file)}\n${indent(err.message)}`);
    }
  }

  console.log(
    `\nSummary: ${converted} converted, ${skipped} skipped (up to date), ${failed} failed.`,
  );
  return failed > 0 ? 1 : 0;
}

function indent(text) {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
