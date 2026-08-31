/* Where an unpacked struct puts its members: the alignment word and which end of
   it the member sits at. Engine only, no browser. */
const {loadEngine, reporter} = require("./support/harness");

const SV = loadEngine();
const report = reporter("alignment");
const ok = report.ok;

function lay(src,opts,root){
  const p = SV.parse(src);
  const r = SV.views(p, root || p.roots[p.roots.length-1].name, opts||{});
  if(r.error) return {err:r.error};
  const v = r.views[0];
  return {
    width: v.width,
    map: v.segs.map(s => (s.pad ? "pad" : s.path) + (s.hi===s.lo?"["+s.hi+"]":"["+s.hi+":"+s.lo+"]")).join(" "),
    unpacked: r.unpacked, align: r.align, lsb: r.lsb, views: r.views
  };
}

const CFG = `typedef struct {
  logic [2:0]  mode;
  logic [11:0] count;
  logic        en;
  logic [15:0] tag;
} cfg_t;`;

console.log("== byte alignment is still the default");
let r = lay(CFG);
ok(r.width === 48 && r.align === 8 && r.unpacked === true, "48 bits, unit 8", r.width+" "+r.align);
ok(r.map === "mode[47:45] pad[44:40] count[39:28] pad[27:24] en[23] pad[22:16] tag[15:0]",
   "unchanged from before", r.map);

console.log("== 16-bit alignment, field at the top");
r = lay(CFG,{align:16});
ok(r.width === 64, "four 16-bit words", r.width);
ok(r.map === "mode[63:61] pad[60:48] count[47:36] pad[35:32] en[31] pad[30:16] tag[15:0]",
   "each member starts a word", r.map);

console.log("== 16-bit alignment, field at the bottom");
r = lay(CFG,{align:16,lsb:true});
ok(r.width === 64, "same width either way", r.width);
ok(r.map === "pad[63:51] mode[50:48] pad[47:44] count[43:32] pad[31:17] en[16] tag[15:0]",
   "pad comes first, member ends on the boundary", r.map);

console.log("== 32-bit alignment");
r = lay(CFG,{align:32});
ok(r.width === 128, "four 32-bit words", r.width);
ok(r.map === "mode[127:125] pad[124:96] count[95:84] pad[83:64] en[63] pad[62:32] tag[31:16] pad[15:0]",
   "top justified", r.map);
r = lay(CFG,{align:32,lsb:true});
ok(r.map === "pad[127:99] mode[98:96] pad[95:76] count[75:64] pad[63:33] en[32] pad[31:16] tag[15:0]",
   "bottom justified", r.map);
ok(r.views[0].segs.filter(s=>!s.pad).every(s => s.lo % 32 === 0),
   "every member's low bit lands on a 32-bit boundary");

console.log("== 64-bit alignment");
r = lay(CFG,{align:64,lsb:true});
ok(r.width === 256, "four 64-bit words", r.width);
ok(r.map === "pad[255:195] mode[194:192] pad[191:140] count[139:128] pad[127:65] en[64] pad[63:16] tag[15:0]",
   "bottom justified", r.map);

console.log("== a packed struct ignores both options");
const PK = "typedef struct packed { logic [2:0] a; logic [11:0] b; logic c; } p_t;";
const base = lay(PK).map;
ok(base === "a[15:13] b[12:1] c[0]", "packed layout", base);
[8,16,32,64].forEach(u => {
  ok(lay(PK,{align:u}).map === base && lay(PK,{align:u,lsb:true}).map === base,
     "unit "+u+" leaves it alone");
});
ok(lay(PK).unpacked === false, "and it reports nothing unpacked");

console.log("== a packed struct nested in a plain one");
const MIX = `typedef struct packed { logic [3:0] lo; logic [3:0] hi; } byte_t;
typedef struct {
  logic  [2:0] head;
  byte_t       body;
  logic        tail;
} mix_t;`;
r = lay(MIX,{align:32});
ok(r.map === "head[95:93] pad[92:64] body.lo[63:60] body.hi[59:56] pad[55:32] tail[31] pad[30:0]",
   "the packed member abuts inside its own word", r.map);
r = lay(MIX,{align:32,lsb:true});
ok(r.map === "pad[95:67] head[66:64] pad[63:40] body.lo[39:36] body.hi[35:32] pad[31:1] tail[0]",
   "and sits at the bottom of it", r.map);

console.log("== an unpacked array of a packed struct");
const ARR = `typedef struct packed { logic [11:0] v; } cell_t;
typedef struct { cell_t cell [3]; } bank_t;`;
r = lay(ARR,{align:16});
ok(r.width === 48 && r.map === "cell[2].v[47:36] pad[35:32] cell[1].v[31:20] pad[19:16] cell[0].v[15:4] pad[3:0]",
   "each element takes a word", r.width+" "+r.map);
r = lay(ARR,{align:16,lsb:true});
ok(r.map === "pad[47:44] cell[2].v[43:32] pad[31:28] cell[1].v[27:16] pad[15:12] cell[0].v[11:0]",
   "bottom justified elements", r.map);

console.log("== an unpacked array as the root");
r = lay(`typedef struct packed { logic [11:0] v; } cell_t;
typedef cell_t row_t [2];`, {align:16}, "row_t");
ok(r.width === 32, "the root array rounds up to whole words", r.width);
ok(r.map === "[1].v[31:20] pad[19:16] [0].v[15:4] pad[3:0]", "including the last element", r.map);

console.log("== nested plain structs compose");
const NEST = `typedef struct { logic [2:0] a; logic b; } in_t;
typedef struct { in_t x; logic [4:0] y; } out_t;`;
r = lay(NEST,{align:32});
ok(r.width === 96 && r.map === "x.a[95:93] pad[92:64] x.b[63] pad[62:32] y[31:27] pad[26:0]",
   "inner struct keeps its own word rounding", r.width+" "+r.map);

console.log("== a member wider than the word");
r = lay(`typedef struct { logic [39:0] wide; logic [3:0] small; } w_t;`,{align:32});
ok(r.width === 96 && r.map === "wide[95:56] pad[55:32] small[31:28] pad[27:0]",
   "40 bits takes two words", r.width+" "+r.map);
r = lay(`typedef struct { logic [39:0] wide; logic [3:0] small; } w_t;`,{align:32,lsb:true});
ok(r.map === "pad[95:72] wide[71:32] pad[31:4] small[3:0]",
   "40 bits bottom justified, ending on a boundary", r.map);

console.log("== an unpacked union");
r = lay(`typedef union { logic [7:0] b; logic [23:0] w; } u_t;`,{align:16});
ok(r.views.length === 2, "one view per member");
ok(r.views[0].width === 32 && r.views[1].width === 32, "both padded to the union size",
   r.views.map(v=>v.width).join(","));
ok(r.views[0].segs.map(s=>(s.pad?"pad":s.path)+"["+s.hi+":"+s.lo+"]").join(" ") === "b[31:24] pad[23:0]",
   "top justified variant", r.views[0].segs.map(s=>(s.pad?"pad":s.path)).join(" "));
r = lay(`typedef union { logic [7:0] b; logic [23:0] w; } u_t;`,{align:16,lsb:true});
ok(r.views[0].segs.map(s=>(s.pad?"pad":s.path)+"["+s.hi+":"+s.lo+"]").join(" ") === "pad[31:8] b[7:0]",
   "bottom justified variant", r.views[0].segs.map(s=>(s.pad?"pad":s.path)+"["+s.hi+":"+s.lo+"]").join(" "));

console.log("== every unit keeps pack-relevant invariants");
[8,16,32,64].forEach(u => [false,true].forEach(l => {
  const x = lay(CFG,{align:u,lsb:l});
  const segs = x.views[0].segs;
  const covered = segs.reduce((a,s)=>a+s.w,0);
  ok(covered === x.width, "unit "+u+(l?" lsb":" msb")+": segments cover the vector",
     covered+" of "+x.width);
  let expect = x.width - 1;
  const gapless = segs.every(s => { const okk = s.hi === expect; expect = s.lo - 1; return okk; });
  ok(gapless && expect === -1, "unit "+u+(l?" lsb":" msb")+": no overlap or hole");
  ok(x.width % u === 0, "unit "+u+(l?" lsb":" msb")+": total is a whole number of words");
}));

report.done();
