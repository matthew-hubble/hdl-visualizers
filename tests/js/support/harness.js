/* Shared plumbing for the JavaScript suites: where the page and the layout
   engine live, how to reach the outside tools that check the generated code, and
   the tally each suite prints when it finishes.

   Nothing here knows an absolute path. The repository root is found from this
   file, and the Python that carries systemrdl-compiler is the project virtual
   environment when there is one. */
"use strict";

const fs = require("fs");
const vm = require("vm");
const cp = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const OUT = path.join(ROOT, "tests", "js", "out");
const PAGE = path.join(ROOT, "struct-visualizer.html");
const ENGINE = path.join(ROOT, "sv-struct.js");
const ARITH = path.join(ROOT, "fixed-point-arithmetic.html");
const CONVERTER = path.join(ROOT, "q-format-converter.html");
const FP_ENGINE = path.join(ROOT, "fixed-point.js");
const RDL_MODEL = path.join(ROOT, "tests", "rdl_model.py");
const PAGE_URL = "file://" + PAGE;
const ARITH_URL = "file://" + ARITH;
const CONVERTER_URL = "file://" + CONVERTER;

fs.mkdirSync(OUT, {recursive:true});

/* ---------- the engines, on their own ---------- */

// both are plain scripts, so a bare context is all they need
function loadScript(file,global){
  const ctx = {console};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, "utf8"), ctx);
  return ctx[global];
}

const loadEngine = () => loadScript(ENGINE, "SV");
const loadFixedPoint = () => loadScript(FP_ENGINE, "FP");

/* The page with its script inlined and its font links dropped, so jsdom can run
   it without fetching anything. */
function inlinePage(){
  return fs.readFileSync(PAGE, "utf8")
    .replace('<script src="sv-struct.js"></script>',
             "<script>" + fs.readFileSync(ENGINE, "utf8") + "</script>")
    .replace(/<link[^>]*>/g, "");
}

/* ---------- the tools that check what the page generates ---------- */

// the project virtual environment first: it is where systemrdl-compiler lives
function python(){
  const venv = path.join(ROOT, ".venv", "bin", "python");
  return fs.existsSync(venv) ? venv : (process.env.PYTHON || "python3");
}

function run(tool,args,input){
  return cp.spawnSync(tool, args, {encoding:"utf8", input});
}

function installed(tool){
  const r = cp.spawnSync(tool, ["--version"], {encoding:"utf8"});
  return !r.error;
}

// elaborate every named addrmap and hand back what the compiler made of it
function elaborateRdl(file,tops){
  return run(python(), [RDL_MODEL, file].concat(tops));
}

function missing(){
  const want = {gcc:"C generation", verilator:"SystemVerilog generation"};
  const gone = Object.keys(want).filter(t => !installed(t));
  const py = run(python(), ["-c", "import systemrdl"]);
  if(py.status !== 0) gone.push("systemrdl-compiler (run: uv sync --group dev)");
  return gone;
}

/* ---------- reporting ---------- */

/* Every suite counts its own checks and exits on the tally. `ok` prints one
   line per check; `extra` is only shown when the check fails, where it carries
   what was actually found. */
function reporter(title){
  let fails = 0;
  const ok = (cond,what,extra) => {
    if(cond) console.log("  ok   " + what);
    else {
      fails++;
      console.log("  FAIL " + what + (extra !== undefined ? "\n         " + extra : ""));
    }
    return !!cond;
  };
  return {
    ok,
    section: name => console.log((fails === 0 && !ok.started ? "" : "") + "== " + name),
    note: msg => console.log(msg),
    get fails(){ return fails; },
    fail(what,extra){ ok(false,what,extra); },
    done(){
      console.log(fails ? "\n" + fails + " FAILURES in " + title
                        : "\nall " + title + " checks passed");
      process.exit(fails ? 1 : 0);
    }
  };
}

module.exports = {ROOT, OUT, PAGE, PAGE_URL, ENGINE, ARITH, ARITH_URL,
                  CONVERTER, CONVERTER_URL, RDL_MODEL,
                  loadEngine, loadFixedPoint, inlinePage, python, run, installed,
                  elaborateRdl, missing, reporter};
