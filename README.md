# Fixed point

[![CI][ci-badge]][ci-runs] [![CD][cd-badge]][cd-runs]

Three single-page tools that run straight from disk, no server and no build step. They are live at
<https://matthew-hubble.github.io/hdl-visualizers/>, and open just as well from a checkout:

| Page                          | What it does                                                   |
| ----------------------------- | -------------------------------------------------------------- |
| `index.html`                  | Links the three below; the page the live site opens            |
| `q-format-converter.html`     | A decimal value to and from a TI Q format word                 |
| `fixed-point-arithmetic.html` | Two Q format operands through one operation, exactly           |
| `struct-visualizer.html`      | A SystemVerilog or SystemRDL declaration drawn as a bit vector |

`hdl-visualizers.css` is shared by all four. `fixed-point.js` carries the fixed-point arithmetic and
`sv-struct.js` the struct reading, bit layout and code generation.

## Drawing a bit layout from the command line

`struct-vis` writes the diagram the struct visualizer draws, as a PNG. It opens the page headless
and takes the picture the **copy image** button would have given you, so the command and the page
cannot drift apart.

```sh
uv sync                    # the command needs playwright
npm run browser            # and a browser for it to drive

struct-vis desc.sv -o desc.png
struct-vis -e 'typedef struct packed { logic [3:0] a; logic [11:0] b; } t;'
cat regs.rdl | struct-vis --rows 64
struct-vis desc.sv --list-types
```

SystemVerilog and SystemRDL are told apart by what the declaration says, and `--syntax` settles it
when the guess is wrong. The switches are the page's: `--type`, `--rows`, `--align`, `--justify`,
`--no-flatten`, `--hide-underscore`, and `--width` for how wide to draw. Without `--out` the file
is named after the type. A declaration that will not lay out is reported and nothing is written.

`struct_vis.image` is the same thing as a library, with `render`, `list_types` and
`detect_syntax`.

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

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to `main` and on every
pull request:

| Job                    | What it does                                                     |
| ---------------------- | ---------------------------------------------------------------- |
| Format, lint and types | `ruff format --check`, `ruff check`, then `mypy` in strict mode  |
| Test suites            | Both suites, on a runner with `gcc`, Verilator and Chromium      |
| CI passed              | Waits on those two and fails unless both succeeded               |

The first two go at once. Because the runner has every outside tool installed, nothing is skipped
there the way it is on a partial machine. If a browser suite fails, what it drew is kept as a
`test-output` artifact for a week, which is usually enough to see why.

`CI passed` is there to be the one check a branch rule asks for. Rules name checks as plain
strings, so requiring the other two directly would mean editing the rule whenever a job is added,
renamed or split. It also closes a gap: a job that is skipped rather than run counts as a pass to
branch protection, which would wave a red pull request through, so this one always runs and reads
their results itself.

Dependencies are grouped into one pull request per ecosystem per month by
[`.github/dependabot.yml`](.github/dependabot.yml).

### Requiring it to merge

No workflow can make itself mandatory, so this is a repository setting: **Settings → Rules →
Rulesets → New branch ruleset**, targeting `main`, with **Require status checks to pass** ticked
and `CI passed` chosen. Tick **Require a pull request before merging** beside it to stop a commit
reaching `main` without one.

That needs a plan which allows protected branches on a private repository, and GitHub Free is not
one: the API answers `403 Upgrade to GitHub Pro or make this repository public`. Making the
repository public lifts it, and lifts the same limit on Pages described below.

## Publishing

[`.github/workflows/cd.yml`](.github/workflows/cd.yml) publishes the site to GitHub Pages. It
waits on CI rather than on the push, and runs only when CI passed on `main`, so nothing is
published from a pull request and nothing is published from a commit that failed. There is no
build: it copies every `.html` at the root together with `hdl-visualizers.css`, `fixed-point.js`
and `sv-struct.js`, and leaves the tests and tooling behind.

Waiting on CI has one consequence worth knowing. A run triggered that way is handed the default
branch, not the commit that was tested, so CD checks out `workflow_run.head_sha` by name; a
second merge landing while a deploy is in flight cannot slip an untested commit onto the site.
Re-running a CI run from the Actions tab is the way to publish again without a new commit.

Two things have to be done by hand, once each. Pages needs turning on under **Settings → Pages →
Build and deployment**, with **Source** set to **GitHub Actions**, because the workflow's own
token is not allowed to do it. And GitHub only fires a `workflow_run` trigger for a copy of the
workflow already on the default branch, so the first deployment is the merge after the one that
adds `cd.yml`.

Pages cannot be turned on at all while the repository is private on GitHub Free, which publishes
only from a public repository. Note that a site published from a private repository is public
anyway on every plan below Enterprise Cloud, so making this repository public costs no privacy
that Pages would have kept, and it settles the branch rule above at the same time.

[ci-badge]: https://github.com/matthew-hubble/hdl-visualizers/actions/workflows/ci.yml/badge.svg
[ci-runs]: https://github.com/matthew-hubble/hdl-visualizers/actions/workflows/ci.yml
[cd-badge]: https://github.com/matthew-hubble/hdl-visualizers/actions/workflows/cd.yml/badge.svg
[cd-runs]: https://github.com/matthew-hubble/hdl-visualizers/actions/workflows/cd.yml
