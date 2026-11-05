# dia2png

Convert [Dia](https://wiki.gnome.org/Apps/Dia) diagram files (`.dia`) to PNG by
calling the installed `dia` command. Each PNG is written beside its source file
with the same base name, and files that are already up to date are skipped.

It is designed to run as a pre-build step for static site generators such as
Hugo, but it has no dependency on Hugo (or on anything else at runtime).

```
content/
└── posts/
    └── my-post/
        ├── index.md
        ├── architecture.dia
        └── architecture.png   ← generated
```

## Installation

dia2png needs **Node.js 20 or newer** and **Dia installed separately**. Dia is
not an npm package, so `npm install` cannot install it for you.

1. Install Dia and make sure `dia` is on your `PATH`:

   | Platform        | Command                                         |
   | --------------- | ----------------------------------------------- |
   | Debian / Ubuntu | `sudo apt-get install dia`                      |
   | Fedora          | `sudo dnf install dia`                          |
   | Arch Linux      | `sudo pacman -S dia`                            |
   | macOS / Windows | download from <http://dia-installer.de/>        |

   Check it works with `dia --version`.

2. Add dia2png to your project:

   ```sh
   npm install --save-dev dia2png
   ```

   Or run it once without installing: `npx dia2png`.

## Usage

```
dia2png [directory] [--size <WxH>] [--force] [--check]
```

| Argument / option   | Description                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `directory`         | Folder to search recursively for `.dia` files. Defaults to `content`.                               |
| `-s, --size <WxH>`  | Export size, passed through to `dia -s`. Examples: `800x600`, `800x` (width only), `x600`.           |
| `-f, --force`       | Convert every file, even when its PNG is already up to date.                                        |
| `-c, --check`       | List files that need conversion without writing anything. Exits with `1` if any are out of date.    |
| `-h, --help`        | Show help.                                                                                          |
| `-v, --version`     | Show the version.                                                                                   |

A PNG is considered **up to date** when it exists and its modification time is
the same as or newer than its `.dia` file's.

The search skips hidden directories (such as `.git`) and `node_modules`, and
does not follow symlinked directories. Files are converted one at a time.

Example output:

```
$ dia2png
converted: content/posts/my-post/architecture.dia -> content/posts/my-post/architecture.png
FAILED: content/posts/old/broken.dia
  dia exited with code 1
  dia error: need valid input file content/posts/old/broken.dia

Summary: 1 converted, 4 skipped (up to date), 1 failed.
```

Under the hood each file is converted with:

```sh
dia -n -t png -e <output.png> [-s <WxH>] <input.dia>
```

Dia is run with an argument array (no shell), so paths containing spaces or
shell metacharacters are safe. The export goes to a temporary file that is
renamed into place only when Dia actually produced a PNG. This matters because
Dia can exit with status 0 without writing anything, for example when an input
file cannot be read. A failed export never overwrites or leaves behind a
broken PNG.

> **Note on `--size`:** some Dia builds ignore `-s` for PNG export. Dia 0.98.0
> on Linux, for example, renders at the diagram's natural size whatever `-s`
> says. dia2png always passes the value through. If the output size doesn't
> change, your Dia build is ignoring the flag.

### Exit codes

| Code | Meaning                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------- |
| `0`  | Success: everything converted or already up to date, or no `.dia` files were found.             |
| `1`  | At least one conversion failed, `dia` is not installed, the directory doesn't exist, or (with `--check`) at least one PNG is out of date. |
| `2`  | Invalid command-line arguments (for example a malformed `--size`).                              |

When one file fails, dia2png reports it, carries on with the remaining files,
and exits with `1` at the end. If `dia` itself cannot be found, it stops
straight away with installation instructions.

`--check` never runs Dia, so it works on machines where Dia isn't installed.

## Using with Hugo

### Run before every build

Add dia2png as a `prebuild` script in `package.json`. npm runs `prebuild`
automatically before `build`:

```json
{
  "scripts": {
    "prebuild": "dia2png",
    "build": "hugo --minify"
  },
  "devDependencies": {
    "dia2png": "^0.1.0"
  }
}
```

```sh
npm run build   # runs dia2png, then hugo --minify
```

If dia2png exits with a non-zero code, npm stops and Hugo doesn't run, so a
broken diagram can't be published silently.

Pass a directory or options as needed, e.g. `"prebuild": "dia2png assets/diagrams --size 1200x"`.

### Don't publish the `.dia` sources

Hugo copies every file in a page bundle to the output, `.dia` files included.
To keep the sources out of `public/`, add this to `hugo.toml`:

```toml
ignoreFiles = ['\.dia$']
```

Then reference the generated image from your content as usual:

```markdown
![Architecture](architecture.png)
```

You can either commit the generated PNGs or generate them in CI. If you commit
them, `dia2png --check` in CI confirms nobody forgot to regenerate after editing
a diagram.

## Headless CI

Dia is a GTK application. Depending on the build, it may need an X display
even when it's only exporting. If a conversion fails in CI with errors such as
`cannot open display` or `Gtk-WARNING`, run dia2png under a virtual framebuffer
with `xvfb-run`:

```sh
xvfb-run -a npx dia2png
```

`-a` picks a free display number automatically, so parallel jobs don't clash.

Example GitHub Actions job:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install Dia and Hugo
        run: sudo apt-get update && sudo apt-get install -y dia xvfb hugo
      - run: npm ci
      - name: Convert diagrams
        run: xvfb-run -a npx dia2png
      - name: Build site
        run: hugo --minify
```

If you use the `prebuild` script, you can wrap the whole build instead:
`xvfb-run -a npm run build`.

To only verify committed PNGs are current, without installing Dia:

```yaml
      - run: npx dia2png --check
```

## Programmatic use

The building blocks are exported too:

```js
import { findDiaFiles, isOutOfDate, convertFile } from 'dia2png';

for (const file of await findDiaFiles('content')) {
  if (await isOutOfDate(file)) await convertFile(file, { size: '800x' });
}
```

`convertFile` throws a `DiaNotFoundError` when `dia` isn't installed and an
`Error` describing the problem when a conversion fails.

## Development

```sh
npm test
```

The tests use the built-in `node:test` runner and a fake `dia` executable
placed on `PATH`, so they run without Dia installed.

## License

[MIT](LICENSE) © Khaleel Jageer
