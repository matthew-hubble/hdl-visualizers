# Fixed point

[![CI][ci-badge]][ci-runs]

Three single-page tools that run straight from disk, no server and no build step. They are live at
<https://matthew-hubble.github.io/hdl-visualizers/>, and open just as well from a checkout:

| Page                          | What it does                                                   |
| ----------------------------- | -------------------------------------------------------------- |
| `index.html`                  | Links the three below; the page the live site opens            |
| `q-format-converter.html`     | A decimal value to and from a TI Q format word                 |
| `fixed-point-arithmetic.html` | Two Q format operands through one operation, exactly           |
| `struct-visualizer.html`      | A SystemVerilog or SystemRDL declaration drawn as a bit vector |

`fixed-point.css` is shared by all four. `fixed-point.js` carries the fixed-point arithmetic and
`sv-struct.js` the struct reading, bit layout and code generation.

## Running the tests

Two environments, because the pages are JavaScript and the repository is a Python project.

```sh
npm install                 # jsdom and playwright
npm run browser             # the chromium build playwright drives
uv sync --group dev         # pytest, playwright, systemrdl-compiler, ruff, mypy

npm test                    # everything
npm run test:js             # the JavaScript suites only
npm run test:py             # the pytest suites only
```

A single JavaScript suite can be run on its own, which is quicker while working on one thing:

```sh
node tests/js/roundtrip.test.js
node tests/js/run-all.js layout generate
```

### What is checked, and by what

The generated code is checked by the tools that consume it rather than by reading it back:

| Tool                 | Used for                                                            |
| -------------------- | ------------------------------------------------------------------- |
| `gcc`                | Compiles and runs the generated C, confirming pack and unpack       |
| `python3`            | Runs the generated dataclasses the same way                         |
| `systemrdl-compiler` | Elaborates the generated SystemRDL and reports where each field sat |
| `verilator`          | Lints the generated SystemVerilog and confirms every `$bits`        |

`gcc` and `verilator` come from the system; a suite that needs a missing one says so and skips
rather than failing. `tests/js/run-all.js` warns up front about anything absent.

Test output, including the screenshots the browser suites take, goes to `tests/js/out/`, which is
not tracked.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull request, in two
jobs that go at once:

| Job                    | What it does                                                     |
| ---------------------- | ---------------------------------------------------------------- |
| Format, lint and types | `ruff format --check`, `ruff check`, then `mypy` in strict mode  |
| Test suites            | Both suites, on a runner with `gcc`, Verilator and Chromium      |

Because the runner has every outside tool installed, nothing is skipped there the way it is on a
partial machine. If a browser suite fails, what it drew is kept as a `test-output` artifact for a
week, which is usually enough to see why.

Dependencies are grouped into one pull request per ecosystem per month by
[`.github/dependabot.yml`](.github/dependabot.yml).

## Publishing

A push to `main` that clears both jobs is published to GitHub Pages by the third job. There is no
build: it copies every `.html` at the root together with `fixed-point.css`, `fixed-point.js` and
`sv-struct.js`, and leaves the tests and tooling behind. Nothing is published from a pull request,
and nothing is published from a commit that failed.

Pages has to be turned on once by hand, under **Settings → Pages → Build and deployment**, with
**Source** set to **GitHub Actions**. The workflow's own token is not allowed to do it.

[ci-badge]: https://github.com/matthew-hubble/hdl-visualizers/actions/workflows/ci.yml/badge.svg
[ci-runs]: https://github.com/matthew-hubble/hdl-visualizers/actions/workflows/ci.yml
