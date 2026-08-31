# Fixed point

Three single-page tools that run straight from disk, no server and no build step. Open any of them
in a browser:

| Page                          | What it does                                                     |
| ----------------------------- | ---------------------------------------------------------------- |
| `q-format-converter.html`     | A decimal value to and from a TI Q format word                   |
| `fixed-point-arithmetic.html` | Two Q format operands through one operation, exactly             |
| `struct-visualizer.html`      | A SystemVerilog or SystemRDL declaration drawn as a bit vector    |

`fixed-point.css` is shared by all three. `fixed-point.js` carries the fixed-point arithmetic and
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
