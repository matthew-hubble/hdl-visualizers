#!/usr/bin/env node
/* Run every JavaScript suite in turn and report the tally.

   Each suite is a separate process so that one crashing cannot take the rest
   with it, and so that a suite can be run on its own during development:

       node tests/js/roundtrip.test.js

   Suites that need an outside tool say so themselves; this only warns up front
   about anything missing, so a partial environment is obvious rather than
   puzzling. */
"use strict";

const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const {missing} = require("./support/harness");

const HERE = __dirname;
const ONLY = process.argv.slice(2);

const SUITES = [
  ["layout",    "the bits an unpacked struct puts its members in"],
  ["generate",  "C and Python, compiled and run"],
  ["nested",    "nested types in all three languages"],
  ["roundtrip", "SystemVerilog to SystemRDL and back"],
  ["page",      "the page in jsdom"],
  ["syntax",    "the source syntax control, in a browser"],
  ["gutter",    "the line numbers, in a browser"],
  ["image",     "copying the diagram as a picture, in a browser"]
];

function main(){
  const gone = missing();
  if(gone.length)
    console.log("note: not installed, so some checks will be skipped or fail: " +
                gone.join(", ") + "\n");

  const chosen = SUITES.filter(([name]) => !ONLY.length || ONLY.indexOf(name) >= 0);
  if(!chosen.length){
    console.error("no such suite: " + ONLY.join(", ") +
                  "\nknown: " + SUITES.map(s => s[0]).join(", "));
    return 2;
  }

  const results = [];
  for(const [name,about] of chosen){
    const file = path.join(HERE, name + ".test.js");
    if(!fs.existsSync(file)){ results.push([name,"missing",""]); continue; }
    process.stdout.write("running " + name + " - " + about + " ... ");
    const started = Date.now();
    const done = cp.spawnSync(process.execPath, [file], {encoding:"utf8"});
    const took = ((Date.now() - started)/1000).toFixed(1) + "s";
    const checks = (done.stdout.match(/^ {2}ok {3}/gm) || []).length;
    if(done.status === 0){
      console.log("ok, " + checks + " checks, " + took);
      results.push([name,"ok",checks]);
    } else {
      console.log("FAILED, " + took);
      console.log(done.stdout.split("\n").filter(l => /FAIL|ERROR/.test(l))
                  .slice(0,12).map(l => "    " + l).join("\n"));
      if(done.stderr.trim())
        console.log("    " + done.stderr.trim().split("\n").slice(0,6).join("\n    "));
      results.push([name,"failed",checks]);
    }
  }

  const bad = results.filter(r => r[1] !== "ok");
  const total = results.reduce((sum,r) => sum + (typeof r[2] === "number" ? r[2] : 0), 0);
  console.log("");
  console.log(bad.length
    ? bad.length + " of " + results.length + " suites failed: " +
      bad.map(r => r[0]).join(", ")
    : results.length + " suites passed, " + total + " checks");
  return bad.length ? 1 : 0;
}

process.exit(main());
