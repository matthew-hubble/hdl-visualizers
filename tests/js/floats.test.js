/* The binary floating point formats the register page reads a field as, checked
   against three things that are not the code under test: the textbook formula
   worked in doubles, the floats the platform itself converts, and the words the
   specifications name.

   Every format of sixteen bits or fewer is walked word by word, which is every
   value it can hold; the wider two are sampled across every exponent. */
const {loadFixedPoint, reporter} = require("./support/harness");

const FP = loadFixedPoint();
const report = reporter("float formats");
const ok = report.ok;

const {pow2, dblRat, parseDecimal, floatNamed, floatsFor, floatNaN, floatInf,
       unpackFloat, packFloat, FLOATS} = FP;

const view = new DataView(new ArrayBuffer(8));

/* ---------- what a word should hold, worked out a different way ----------
   The textbook formula in doubles, which is exact for every format up to
   binary32: a significand of at most 24 bits scaled by a power of two that
   stays inside the range of a double. */
function textbook(bits,f){
  const sign = (bits >>> (f.e + f.m)) & 1;
  const exp = (bits >>> f.m) & ((1 << f.e) - 1);
  const frac = bits & ((1 << f.m) - 1);
  const value = exp === 0
    ? frac * Math.pow(2, 1 - f.bias - f.m)
    : (frac + Math.pow(2, f.m)) * Math.pow(2, exp - f.bias - f.m);
  return sign ? -value : value;
}

/* What a word holds, as an exact rational. unpackFloat hands back p / 2^k with k
   either way about, and a large value has it negative. */
const rat = got => got.k >= 0 ? {p:got.p, q:pow2(got.k)}
                              : {p:got.p << BigInt(-got.k), q:1n};
const alike = (a,b) => a.p * b.q === b.p * a.q;

// does the word hold exactly the double x?
function holds(got,x){
  if(!isFinite(x) || got.nan || got.inf) return false;
  return alike(rat(got), dblRat(x));
}

const special = (bits,f) => {
  const exp = Number((BigInt(bits) >> BigInt(f.m)) & (pow2(f.e) - 1n));
  const frac = BigInt(bits) & (pow2(f.m) - 1n);
  if(exp !== f.top || f.kind === "finite") return null;
  if(f.kind === "ieee") return frac ? "nan" : "inf";
  return frac === pow2(f.m) - 1n ? "nan" : null;     // E4M3 keeps back only that one
};

const SMALL = ["e2m1", "e3m0", "e4m3", "e5m2", "binary16", "bf16"];

/* ---------- the table ---------- */
report.section("the formats on offer");
ok(FLOATS.length === 8, "eight of them", FLOATS.length);
ok(FLOATS.every(f => f.bits === 1 + f.e + f.m), "a sign, an exponent and a significand each",
   FLOATS.map(f => f.key + ":" + f.bits).join(" "));
ok(FLOATS.map(f => f.key + "/" + f.bits).join(" ") ===
   "binary16/16 bf16/16 binary32/32 binary64/64 e4m3/8 e5m2/8 e2m1/4 e3m0/4",
   "each is as wide as its name says", FLOATS.map(f => f.key + "/" + f.bits).join(" "));
ok(FLOATS.every(f => f.bias === (1 << (f.e - 1)) - 1), "with the usual bias on the exponent");
ok(floatsFor(16).map(f => f.key).join(" ") === "binary16 bf16" &&
   floatsFor(8).map(f => f.key).join(" ") === "e4m3 e5m2" &&
   floatsFor(4).map(f => f.key).join(" ") === "e2m1 e3m0",
   "two formats a width where a width has two",
   floatsFor(16).concat(floatsFor(8), floatsFor(4)).map(f => f.key).join(" "));
ok(floatsFor(32)[0].key === "binary32" && floatsFor(64)[0].key === "binary64" &&
   floatsFor(20).length === 0, "and one, or none, where it does not");
ok(floatsFor(16)[0].key === "binary16" && floatsFor(8)[0].key === "e4m3" &&
   floatsFor(4)[0].key === "e2m1",
   "the IEEE one comes first at sixteen bits, and the commoner one below that");

report.section("naming a format");
[["binary16","binary16"], ["fp16","binary16"], ["half","binary16"], ["FP16","binary16"],
 ["bf16","bf16"], ["BFloat16","bf16"], ["binary32","binary32"], ["single","binary32"],
 ["double","binary64"], ["fp64","binary64"], ["fp8","e4m3"], ["FP8 (E4M3)","e4m3"],
 ["e5m2","e5m2"], ["E5M2","e5m2"], ["fp4","e2m1"], ["FP4 (E2M1)","e2m1"],
 ["FP4 (E3M0)","e3m0"], ["e8m7","bf16"], ["e11m52","binary64"]
].forEach(([name,key]) => {
  const f = floatNamed(name);
  ok(!!f && f.key === key, '"' + name + '" is ' + key, f ? f.key : "nothing");
});
["", "q1.14", "signed", "e9m9", "fp12", "float"].forEach(name =>
  ok(floatNamed(name) === null, '"' + name + '" names no format', name));

/* ---------- decoding ---------- */
report.section("every word of every small format, against the textbook formula");
SMALL.forEach(key => {
  const f = floatNamed(key);
  const wrong = [];
  for(let bits = 0; bits < (1 << f.bits) && wrong.length < 4; bits++){
    const got = unpackFloat(BigInt(bits), f);
    const want = special(bits,f);
    if(want === "nan"){
      if(!got.nan) wrong.push(bits.toString(16) + " should be NaN");
      continue;
    }
    if(want === "inf"){
      if(!got.inf) wrong.push(bits.toString(16) + " should be infinite");
      continue;
    }
    if(got.nan || got.inf){ wrong.push(bits.toString(16) + " should be a number"); continue; }
    if(!holds(got, textbook(bits,f)))
      wrong.push(bits.toString(16) + " is " + got.p + "/2^" + got.k +
                 ", not " + textbook(bits,f));
  }
  ok(!wrong.length, f.label + ": all " + (1 << f.bits) + " words", wrong.join(" | "));
});

report.section("binary16 against the platform's own half");
{
  const wrong = [];
  for(let bits = 0; bits < 65536 && wrong.length < 4; bits++){
    view.setUint16(0, bits);
    const x = view.getFloat16(0);
    const got = unpackFloat(BigInt(bits), floatNamed("binary16"));
    const same = Number.isNaN(x) ? !!got.nan
      : !isFinite(x) ? !!got.inf && got.neg === (x < 0)
      : holds(got,x);
    if(!same) wrong.push(bits.toString(16) + " reads " + x);
  }
  ok(!wrong.length, "all 65536 words agree with DataView.getFloat16", wrong.join(" | "));
}

report.section("bf16 is the top half of a binary32");
{
  const wide = floatNamed("binary32"), narrow = floatNamed("bf16");
  const wrong = [];
  for(let bits = 0; bits < 65536 && wrong.length < 4; bits++){
    const half = unpackFloat(BigInt(bits), narrow);
    const whole = unpackFloat(BigInt(bits) << 16n, wide);
    const same = half.nan ? whole.nan : half.inf ? whole.inf && half.neg === whole.neg
      : !whole.nan && !whole.inf && alike(rat(half), rat(whole));
    if(!same) wrong.push(bits.toString(16));
    view.setUint32(0, bits * 65536);
    if(!same || Number.isNaN(view.getFloat32(0)) !== !!half.nan) wrong.push(bits.toString(16));
  }
  ok(!wrong.length, "all 65536 words widen to the same value", wrong.join(" | "));
}

report.section("binary32 and binary64 across every exponent");
{
  const f = floatNamed("binary32"), wrong = [];
  for(let exp = 0; exp < 256 && wrong.length < 4; exp++)
    for(const frac of [0, 1, 0x400001, 0x7FFFFF, 0x123456])
      for(const sign of [0, 1]){
        const bits = (sign * 0x80000000) + exp * 0x800000 + frac;
        view.setUint32(0, bits);
        const x = view.getFloat32(0);
        const got = unpackFloat(BigInt(bits), f);
        const same = Number.isNaN(x) ? !!got.nan
          : !isFinite(x) ? !!got.inf && got.neg === (x < 0)
          : holds(got,x);
        if(!same) wrong.push(bits.toString(16) + " reads " + x);
      }
  ok(!wrong.length, "2560 binary32 words agree with DataView.getFloat32", wrong.join(" | "));
}
{
  const f = floatNamed("binary64"), wrong = [];
  for(let exp = 0; exp < 2048 && wrong.length < 4; exp++)
    for(const frac of [0n, 1n, 0x8000000000000n, 0xFFFFFFFFFFFFFn])
      for(const sign of [0n, 1n]){
        const bits = (sign << 63n) | (BigInt(exp) << 52n) | frac;
        view.setBigUint64(0, bits);
        const x = view.getFloat64(0);
        const got = unpackFloat(bits, f);
        const same = Number.isNaN(x) ? !!got.nan
          : !isFinite(x) ? !!got.inf && got.neg === (x < 0)
          : holds(got,x);
        if(!same) wrong.push(bits.toString(16) + " reads " + x);
      }
  ok(!wrong.length, "16384 binary64 words agree with DataView.getFloat64", wrong.join(" | "));
}

/* ---------- the words the specifications name ---------- */
report.section("the words each specification calls out");
const ANCHORS = {
  binary16: [[0x0000,"0"], [0x8000,"-0"], [0x0001,"2^-24"], [0x03FF,"1023/2^24"],
             [0x0400,"2^-14"], [0x3C00,"1"], [0x3C01,"1025/2^10"], [0xC000,"-2"],
             [0x7BFF,"65504"], [0x7C00,"inf"], [0xFC00,"-inf"], [0x7E00,"nan"],
             [0x7C01,"nan"]],
  bf16:     [[0x3F80,"1"], [0x4049,"3.140625"], [0x0080,"2^-126"], [0x0001,"2^-133"],
             [0x7F7F,"255/2^7 * 2^127"], [0x7F80,"inf"], [0xFF80,"-inf"], [0x7FC0,"nan"]],
  e4m3:     [[0x00,"0"], [0x80,"-0"], [0x01,"2^-9"], [0x07,"7/2^9"], [0x08,"2^-6"],
             [0x38,"1"], [0x78,"256"], [0x7E,"448"], [0xFE,"-448"], [0x7F,"nan"],
             [0xFF,"nan"]],
  e5m2:     [[0x00,"0"], [0x01,"2^-16"], [0x04,"2^-14"], [0x3C,"1"], [0x7B,"57344"],
             [0xFB,"-57344"], [0x7C,"inf"], [0xFC,"-inf"], [0x7D,"nan"], [0x7F,"nan"]],
  e2m1:     [[0x0,"0"], [0x1,"0.5"], [0x2,"1"], [0x3,"1.5"], [0x4,"2"], [0x5,"3"],
             [0x6,"4"], [0x7,"6"], [0x8,"-0"], [0xF,"-6"]],
  e3m0:     [[0x0,"0"], [0x1,"0.25"], [0x2,"0.5"], [0x3,"1"], [0x4,"2"], [0x5,"4"],
             [0x6,"8"], [0x7,"16"], [0x8,"-0"], [0xF,"-16"]],
  binary32: [[0x3F800000,"1"], [0x00800000,"2^-126"], [0x00000001,"2^-149"],
             [0x7F7FFFFF,"16777215/2^23 * 2^127"], [0x7F800000,"inf"]],
  binary64: [[0x3FF0000000000000n,"1"], [0xC00C000000000000n,"-3.5"],
             [0x0010000000000000n,"2^-1022"], [0x0000000000000001n,"2^-1074"],
             [0x7FF0000000000000n,"inf"], [0x7FF8000000000000n,"nan"]]
};

// "2^-9", "7/2^9", "255/2^7 * 2^127" and plain decimals, as an exact rational
function asked(text){
  if(text === "inf" || text === "-inf" || text === "nan") return text;
  let p = 1n, q = 1n;
  for(const part of text.split(" * ")){
    const over = /^(-?\d+)\/2\^(\d+)$/.exec(part);
    const power = /^(-?)2\^(-?\d+)$/.exec(part);
    if(over){ p *= BigInt(over[1]); q *= pow2(+over[2]); }
    else if(power){
      const k = +power[2];
      if(k >= 0) p *= pow2(k); else q *= pow2(-k);
      if(power[1] === "-") p = -p;
    } else {
      const r = parseDecimal(part);
      p *= r.p; q *= r.q;
    }
  }
  return {p,q};
}

Object.keys(ANCHORS).forEach(key => {
  const f = floatNamed(key);
  const wrong = [];
  ANCHORS[key].forEach(([bits,text]) => {
    const got = unpackFloat(BigInt(bits), f);
    const want = asked(text);
    const label = "0x" + BigInt(bits).toString(16).toUpperCase() + " = " + text;
    if(want === "nan"){ if(!got.nan) wrong.push(label); return; }
    if(want === "inf" || want === "-inf"){
      if(!got.inf || got.neg !== (want === "-inf")) wrong.push(label);
      return;
    }
    if(got.nan || got.inf){ wrong.push(label + " came out special"); return; }
    if(text === "-0" ? !(got.neg && got.p === 0n) : !alike(rat(got), want))
      wrong.push(label + " came out " + got.p + "/2^" + got.k);
  });
  ok(!wrong.length, f.label + ": " + ANCHORS[key].length + " named words", wrong.join(" | "));
});

/* ---------- encoding ---------- */
report.section("every word survives being read and written back");
SMALL.forEach(key => {
  const f = floatNamed(key);
  const wrong = [];
  for(let bits = 0; bits < (1 << f.bits) && wrong.length < 4; bits++){
    const got = unpackFloat(BigInt(bits), f);
    if(got.nan) continue;                          // a NaN payload is not a value
    if(got.inf){
      if(floatInf(f, got.neg) !== BigInt(bits)) wrong.push(bits.toString(16) + " lost infinity");
      continue;
    }
    if(got.p === 0n) continue;                     // packing cannot know a zero was negative
    const back = packFloat(rat(got), f);
    if(back !== BigInt(bits)) wrong.push(bits.toString(16) + " came back " + back.toString(16));
  }
  ok(!wrong.length, f.label + ": all " + (1 << f.bits) + " words", wrong.join(" | "));
});

report.section("a value between two words goes to the nearer one, ties to even");
const packs = (text,key) => packFloat(parseDecimal(text), floatNamed(key));
[["1.00048828125","binary16",0x3C00,"halfway up from one, to the even significand"],
 ["1.00146484375","binary16",0x3C02,"halfway again, to the even one above"],
 ["1.0009765625","binary16",0x3C01,"and the word between them itself"],
 ["0.0166015625","e4m3",0x08,"halfway above the smallest normal E4M3"],
 ["0.0170","e4m3",0x09,"just past halfway"],
 ["1.25","e2m1",0x2,"halfway between one and one and a half"],
 ["1.75","e2m1",0x4,"halfway between one and a half and two"],
 ["1.4","e2m1",0x3,"nearer one and a half"],
 ["2.9","e3m0",0x4,"nearer two"],
 ["3.1","e3m0",0x5,"nearer four"],
 ["0.001","e4m3",0x01,"over half the smallest subnormal, so not zero"],
 ["0.0009","e4m3",0x00,"under half of it, so zero"],
 ["3.141592653589793","binary64",0x400921FB54442D18n,"pi, to a double"],
 ["3.14159265358979","binary64",0x400921FB54442D11n,
  "a shorter pi, which is a different double, as the platform agrees"],
 ["0.1","binary32",0x3DCCCCCDn,"a tenth, to a single"],
 ["0.1","binary16",0x2E66n,"a tenth, to a half"],
 ["0.1","bf16",0x3DCDn,"a tenth, to a bf16"]
].forEach(([text,key,want,what]) => {
  const got = packs(text,key);
  ok(got === BigInt(want), what + ": " + text + " in " + key,
     "0x" + got.toString(16).toUpperCase());
});

report.section("a value too big for the format");
[["1e6","binary16",0x7C00,"a half overflows to infinity"],
 ["-1e6","binary16",0xFC00,"and to the other one"],
 ["1e39","bf16",0x7F80,"so does a bf16"],
 ["1e39","binary32",0x7F800000,"and a single"],
 ["1e6","e5m2",0x7C,"E5M2 keeps an infinity, so it overflows to that"],
 ["1000","e4m3",0x7E,"E4M3 has none, so it stops at 448"],
 ["-1000","e4m3",0xFE,"at both ends"],
 ["464","e4m3",0x7E,"even halfway to what would be next"],
 ["100","e2m1",0x7,"E2M1 stops at six"],
 ["100","e3m0",0x7,"and E3M0 at sixteen"],
 ["1e-30","binary16",0x0000,"far under the smallest half is zero"],
 ["1e-300","binary32",0x00000000,"and under the smallest single"]
].forEach(([text,key,want,what]) => {
  const got = packs(text,key);
  ok(got === BigInt(want), what + ": " + text + " in " + key,
     "0x" + got.toString(16).toUpperCase());
});

report.section("infinity and NaN belong only to the formats that keep them");
ok(floatInf(floatNamed("binary16"), false) === 0x7C00n &&
   floatInf(floatNamed("binary16"), true) === 0xFC00n, "a half has both infinities");
ok(floatInf(floatNamed("e5m2"), false) === 0x7Cn, "E5M2 has them too",
   String(floatInf(floatNamed("e5m2"), false)));
ok(floatInf(floatNamed("e4m3"), false) === null, "E4M3 has none");
ok(floatInf(floatNamed("e2m1"), false) === null && floatInf(floatNamed("e3m0"), false) === null,
   "and neither four-bit format does");
ok(floatNaN(floatNamed("binary16")) === 0x7E00n, "a half writes a quiet NaN",
   String(floatNaN(floatNamed("binary16"))));
ok(floatNaN(floatNamed("e4m3")) === 0x7Fn, "E4M3 writes the one word it keeps back",
   String(floatNaN(floatNamed("e4m3"))));
ok(floatNaN(floatNamed("e5m2")) === 0x7En, "E5M2 writes a quiet one",
   String(floatNaN(floatNamed("e5m2"))));
ok(floatNaN(floatNamed("e2m1")) === null && floatNaN(floatNamed("e3m0")) === null,
   "and the four-bit formats have no NaN to write");
ok(unpackFloat(0x78n, floatNamed("e4m3")).nan !== true,
   "so E4M3 reads its top exponent as a number, not as infinity");
ok(unpackFloat(0x7n, floatNamed("e2m1")).inf !== true &&
   unpackFloat(0x7n, floatNamed("e3m0")).inf !== true,
   "and the four-bit formats read theirs the same way");

report.done();
