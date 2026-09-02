/* The rounding modes: what FP.quantize makes of each one, and what the three
   rounding strips on the arithmetic page do when they are pressed.

   The three nearest modes agree everywhere except on an exact tie, so most of
   what follows is about ties. The sweep checks the quantizer against an oracle
   written the other way round - decomposing the signed value with a floor,
   where the quantizer works on the magnitude - so a sign slip cannot pass by
   agreeing with itself. */
"use strict";
const {chromium} = require("playwright");
const {loadFixedPoint, ARITH_URL, CONVERTER_URL, reporter} = require("./support/harness");

const FP = loadFixedPoint();
const report = reporter("rounding");
const ok = report.ok;

const MODES = ["near", "even", "odd", "trunc", "floor"];

const floorDiv = (a,b) => { const q = a/b; return (a%b !== 0n && (a<0n) !== (b<0n)) ? q-1n : q; };
const scale = (p,n) => p * (1n << BigInt(n));

/* What the answer has to be, decided from the signed value: `down` is the word
   below it and `rest` is twice the leftover, so rest === q is exactly a tie. */
function oracle(num,den,mode){
  const down = floorDiv(num,den), rest = 2n*(num - down*den);
  if(mode === "floor") return down;
  if(mode === "trunc") return (num < 0n && rest !== 0n) ? down+1n : down;
  if(rest !== den) return rest > den ? down+1n : down;
  if(mode === "near") return num < 0n ? down : down+1n;
  return ((down & 1n) === 1n) === (mode === "odd") ? down : down+1n;
}

const isTie = (num,den) => 2n*(num - floorDiv(num,den)*den) === den;

const CASES = [];
for(const den of [1n,2n,3n,4n,5n,8n,10n,16n])
  for(let p = -60n; p <= 60n; p++)
    for(const n of [0,1,3,5]) CASES.push([p,den,n]);

/* ---------- the quantizer ---------- */

console.log("== the textbook table of halves");
const HALVES = [
  [-5n, {near:-3n, even:-2n, odd:-3n, trunc:-2n, floor:-3n}],
  [-3n, {near:-2n, even:-2n, odd:-1n, trunc:-1n, floor:-2n}],
  [-1n, {near:-1n, even: 0n, odd:-1n, trunc: 0n, floor:-1n}],
  [ 1n, {near: 1n, even: 0n, odd: 1n, trunc: 0n, floor: 0n}],
  [ 3n, {near: 2n, even: 2n, odd: 1n, trunc: 1n, floor: 1n}],
  [ 5n, {near: 3n, even: 2n, odd: 3n, trunc: 2n, floor: 2n}],
  [ 7n, {near: 4n, even: 4n, odd: 3n, trunc: 3n, floor: 3n}]
];
const row = (get) => MODES.map(m => m + " " + get(m)).join(", ");
for(const [p,want] of HALVES){
  const got = m => FP.quantize(p,2n,0,m);
  ok(MODES.every(m => got(m) === want[m]),
     "half " + p + "/2 rounds to " + row(m => want[m]), row(got));
}

console.log("== values that are not halves, and fraction bits above zero");
const PLAIN = [
  [ 1n, 3n, 4, {near: 5n, even: 5n, odd: 5n, trunc: 5n, floor: 5n}],   // 5.33
  [ 5n, 3n, 2, {near: 7n, even: 7n, odd: 7n, trunc: 6n, floor: 6n}],   // 6.67
  [-1n, 3n, 4, {near:-5n, even:-5n, odd:-5n, trunc:-5n, floor:-6n}],   // -5.33
  [ 1n, 4n, 3, {near: 2n, even: 2n, odd: 2n, trunc: 2n, floor: 2n}]    // 2 exactly
];
for(const [p,den,n,want] of PLAIN){
  const got = m => FP.quantize(p,den,n,m);
  ok(MODES.every(m => got(m) === want[m]),
     p + "/" + den + " at n=" + n + " rounds to " + row(m => want[m]), row(got));
}

console.log("== the quantizer against the oracle, over " + CASES.length + " values");
for(const mode of MODES){
  let bad = null;
  for(const [p,den,n] of CASES){
    const got = FP.quantize(p,den,n,mode), want = oracle(scale(p,n),den,mode);
    if(got !== want && !bad)
      bad = p + "/" + den + " at n=" + n + ": quantize said " + got + ", oracle said " + want;
  }
  ok(!bad, mode + " matches the oracle everywhere", bad);
}

console.log("== what separates the three nearest modes");
let plain = 0, ties = 0, split = 0, drift = null;
for(const [p,den,n] of CASES){
  const near = FP.quantize(p,den,n,"near");
  const even = FP.quantize(p,den,n,"even");
  const odd  = FP.quantize(p,den,n,"odd");
  if(isTie(scale(p,n),den)){
    ties++;
    if(even !== odd) split++;
  } else {
    plain++;
    if((near !== even || near !== odd) && !drift)
      drift = p + "/" + den + " at n=" + n + ": " + near + ", " + even + ", " + odd;
  }
}
ok(!drift, "all three agree on the " + plain + " values that are not ties", drift);
ok(ties > 0, "the sweep does reach a tie, " + ties + " of them");
ok(split === ties, "even and odd part company on every one of the " + ties + " ties",
   "only " + split + " of them");

console.log("== a tie lands on a word of the parity that was asked for");
for(const mode of ["even","odd"]){
  const want = mode === "odd" ? 1n : 0n;
  let bad = null;
  for(const [p,den,n] of CASES){
    if(!isTie(scale(p,n),den)) continue;
    const got = FP.quantize(p,den,n,mode);
    if((got & 1n) !== want && !bad) bad = p + "/" + den + " at n=" + n + " gave " + got;
  }
  ok(!bad, "every tie under " + mode + " lands on " + (want ? "an odd" : "an even") + " word", bad);
}

console.log("== no mode wanders off");
let stray = null, far = null;
for(const [p,den,n] of CASES){
  const num = scale(p,n), down = floorDiv(num,den);
  for(const mode of MODES){
    const got = FP.quantize(p,den,n,mode);
    if(got !== down && got !== down+1n && !stray)
      stray = mode + " gave " + got + " for " + p + "/" + den + " at n=" + n;
    if(mode === "trunc" || mode === "floor") continue;
    const off = got*den - num;
    if(2n*(off < 0n ? -off : off) > den && !far)
      far = mode + " is over half a step from " + p + "/" + den + " at n=" + n;
  }
}
ok(!stray, "every mode returns one of the two words either side of the value", stray);
ok(!far, "the nearest modes never move by more than half a step", far);

console.log("== symmetry about zero");
for(const mode of ["near","even","odd","trunc"]){
  let bad = null;
  for(const [p,den,n] of CASES)
    if(FP.quantize(p,den,n,mode) !== -FP.quantize(-p,den,n,mode) && !bad)
      bad = p + "/" + den + " at n=" + n;
  ok(!bad, mode + " rounds a value and its negative alike", bad);
}
ok(FP.quantize(1n,2n,0,"floor") !== -FP.quantize(-1n,2n,0,"floor"),
   "floor is the one that does not, which is the point of it");
ok(FP.quantize(-1n,-2n,0,"even") === FP.quantize(1n,2n,0,"even"),
   "a negative denominator is normalised before rounding");

/* ---------- the pages ---------- */

/* Q0.2 puts the last bit at 0.25, so each of these sits on an exact tie. Both
   pages take a value and a format and show the word they stored, so both are
   driven through the same three. */
const TIES = [
  ["0.375",  {near:"2",  even:"2",  odd:"1",  trunc:"1",  floor:"1"}],
  ["0.625",  {near:"3",  even:"2",  odd:"3",  trunc:"2",  floor:"2"}],
  ["-0.375", {near:"-2", even:"-2", odd:"-1", trunc:"-1", floor:"-2"}]
];

async function checkTies(p,where,sel){
  await p.fill(sel.q, "Q0.2");
  for(const [value,want] of TIES){
    await p.fill(sel.val, value);
    for(const mode of MODES){
      await p.click(sel.strip + ' button[data-v="' + mode + '"]');
      await p.waitForTimeout(50);
      const got = await p.inputValue(sel.raw);
      ok(got === want[mode],
         where + ": " + value + " in Q0.2 under " + mode + " stores " + want[mode], got);
    }
  }
}

async function listsModes(p,id){
  const vs = await p.$$eval("#" + id + " button", bs => bs.map(x => x.dataset.v));
  ok(vs.join(",") === MODES.join(","), id + " lists " + MODES.join(", "), vs.join(","));
}

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({viewport:{width:1400,height:1400}});
  const errs = [];
  p.on("pageerror", e => errs.push(e.message));
  /* a web font that did not arrive is logged as an error too, and no check here
     turns on whether the font service was reachable */
  p.on("console", m => {
    if(m.type() === "error" && !/^Failed to load resource/.test(m.text()))
      errs.push("console: " + m.text());
  });
  await p.goto(ARITH_URL);
  await p.waitForTimeout(600);

  console.log("== every rounding strip on the arithmetic page offers the five modes");
  for(const id of ["a-round","b-round","r-round"]) await listsModes(p,id);

  console.log("== operand A rounds a tie the way its strip says");
  await checkTies(p, "operand A", {q:"#a-q", val:"#a-val", strip:"#a-round", raw:"#a-raw"});

  console.log("== the result strip rounds the answer the way it says");
  // 0.625 x 0.5 is 0.3125 exactly, which is two and a half of Q0.3's last bit
  await p.fill("#a-q", "Q0.3"); await p.fill("#a-val", "0.625");
  await p.fill("#b-q", "Q0.1"); await p.fill("#b-val", "0.5");
  await p.uncheck("#r-auto");
  await p.fill("#r-q", "Q0.3");
  await p.waitForTimeout(80);
  ok(await p.textContent("#r-val") !== "—", "the manual result format took");
  const RESULT = {near:"3", even:"2", odd:"3", trunc:"2", floor:"2"};
  for(const mode of MODES){
    await p.click('#r-round button[data-v="' + mode + '"]');
    await p.waitForTimeout(50);
    const got = await p.textContent("#r-int");
    ok(got === RESULT[mode], "0.3125 into Q0.3 under " + mode + " is " + RESULT[mode], got);
  }

  await p.goto(CONVERTER_URL);
  await p.waitForTimeout(600);

  console.log("== the converter offers the same five modes");
  await listsModes(p, "seground");

  console.log("== the converter rounds a tie the way its strip says");
  await checkTies(p, "converter", {q:"#qtext", val:"#fval", strip:"#seground", raw:"#rawin"});

  ok(errs.length === 0, "neither page reported a script error", errs.join(" | "));
  await b.close();
  report.done();
})();
