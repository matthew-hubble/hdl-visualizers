/* SystemVerilog -> SystemRDL -> SystemVerilog and back, checking the bits never
   move. The generated RDL is compiled by systemrdl-compiler and the generated
   SystemVerilog is linted by Verilator, which also evaluates $bits on the type
   and on every member so the widths are confirmed by something other than us. */
const fs = require("fs"), cp = require("child_process"), path = require("path");
const {loadEngine, reporter, python, RDL_MODEL, OUT: OUTDIR} = require("./support/harness");

const OUT = path.join(OUTDIR, "roundtrip");
fs.mkdirSync(OUT, {recursive:true});

const SV = loadEngine();
const report = reporter("round trip");
const ok = report.ok;

const tile = v => v.segs.map(s => s.hi+":"+s.lo).join(" ");
const real = v => v.segs.filter(s => !s.pad && !/^_rsvd\d*$/.test(s.path));
const spots = v => real(v).map(s => s.hi+":"+s.lo).join(" ");
const names = v => real(v).map(s => s.path.replace(/\./g,"_")).join(" ");

function gapless(v,label){
  let want = v.width - 1;
  const good = v.segs.every(s => { const hit = s.hi === want; want = s.lo - 1; return hit; });
  ok(good && want === -1, label + ": the members tile the vector", tile(v));
}

// verilator lints the file and evaluates $bits on the type and each member
function lintSv(text, typeName, width, members, label){
  const L = ["module gen_check;", text.replace(/^/gm,"  "),
             "  " + typeName + " x;",
             '  if ($bits(' + typeName + ') != ' + width + ') $error("total is %0d", $bits(' +
               typeName + '));'];
  members.forEach(m => L.push('  if ($bits(x.' + m.name + ') != ' + m.w +
    ') $error("' + m.name + ' is %0d", $bits(x.' + m.name + '));'));
  L.push("endmodule");
  const file = OUT + "/lint.sv";
  fs.writeFileSync(file, L.join("\n") + "\n");
  const r = cp.spawnSync("verilator", ["--lint-only","-sv",file], {encoding:"utf8"});
  ok(r.status === 0, label + ": verilator accepts the SystemVerilog and its widths",
     (r.stderr||"").split("\n").filter(l=>/Error|Warning/.test(l)).slice(0,4).join(" | "));
}

function rdlCompiles(rdl, tops, label){
  const file = OUT + "/round.rdl";
  fs.writeFileSync(file, rdl);
  const r = cp.spawnSync(python(), [RDL_MODEL, file].concat(tops), {encoding:"utf8"});
  ok(r.status === 0, label + ": systemrdl-compiler accepts the SystemRDL",
     (r.stdout||"").slice(0,160) + (r.stderr||"").split("\n").slice(0,2).join(" | "));
}

function trip(title, sv, root, rw, opts){
  console.log("== " + title + " at " + rw + " bits per register");
  const p1 = SV.parse(sv);
  const pick = root || p1.roots[p1.roots.length-1].name;
  const r1 = SV.views(p1, pick, opts||{});
  if(r1.error){ ok(false,"lays out",r1.error); return; }
  const v1 = r1.views[0];

  const rdl = SV.rdlCode(r1.views, {regwidth:rw});
  const amap = pick.replace(/_t$/,"");
  rdlCompiles(rdl, [amap], "rdl");

  const p2 = SV.parseRdl(rdl);
  ok(p2.skipped.length === 0, "the RDL reads back without a skipped line",
     p2.skipped.join(","));
  ok(p2.roots.some(r => r.name === amap), "and offers the addrmap as a type",
     p2.roots.map(r=>r.name).join(","));
  const r2 = SV.views(p2, amap, opts||{});
  if(r2.error){ ok(false,"the RDL lays out",r2.error); return; }
  const v2 = r2.views[0];

  // a register map holds whole registers, so a vector that does not fill the
  // last one comes back rounded up, with the spare bits reserved
  const rounded = Math.ceil(v1.width / rw) * rw;
  ok(v2.width === rounded, "width rounded up to whole registers",
     v2.width + ", expected " + rounded + " from " + v1.width);
  if(v2.width !== v1.width)
    ok(real(v2).length === real(v1).length,
       "and nothing was lost in the " + (v2.width - v1.width) + " spare bits",
       real(v2).length + " of " + real(v1).length);
  ok(spots(v2) === spots(v1), "every field back in its own bits",
     spots(v2) + "\n         " + spots(v1));
  ok(names(v2) === names(v1), "with its own name", names(v2) + "\n         " + names(v1));
  gapless(v2, "rdl");

  /* flattened: one struct, dotted paths joined by underscores */
  const sv2 = SV.svCode(r2.views);
  fs.writeFileSync(OUT+"/round_"+title.replace(/\W+/g,"_")+"_"+rw+".sv", sv2);
  const r3 = SV.views(SV.parse(sv2), amap+"_t", opts||{});
  if(r3.error){ ok(false,"the SystemVerilog lays out",r3.error); return; }
  const v3 = r3.views[0];
  ok(v3.width === v2.width && tile(v3) === tile(v2),
     "and the SystemVerilog it writes lays out the same",
     tile(v3) + "\n         " + tile(v2));
  const flatNames = v2.segs.map(s => s.path.replace(/\./g,"_")).join(" ");
  ok(v3.segs.map(s=>s.path).join(" ") === flatNames, "member for member",
     v3.segs.map(s=>s.path).join(" ") + "\n         " + flatNames);
  lintSv(sv2, amap+"_t", v2.width,
         v2.segs.map(s => ({name:s.path.replace(/\./g,"_"), w:s.w})), "flat sv");

  /* nested: a subtype for every name.field group, which verilator has to be
     able to walk into for $bits(x.ctrl.cmd) to resolve */
  const rn = SV.views(p2, amap, Object.assign({}, opts, {flatten:false}));
  if(!rn.error){
    const svn = SV.svCode(rn.views);
    fs.writeFileSync(OUT+"/round_"+title.replace(/\W+/g,"_")+"_"+rw+"_nested.sv", svn);
    const deep = v2.segs.filter(s => s.path.indexOf(".") >= 0).length;
    ok((svn.match(/^typedef struct packed \{$/gm)||[]).length === (deep ? 2 : 1) ||
       deep === 0,
       "a typedef per level" + (deep ? "" : " (nothing nested here)"),
       (svn.match(/\} \w+;/g)||[]).join(" "));
    const rb = SV.views(SV.parse(svn), amap+"_t", opts||{});
    ok(!rb.error && tile(rb.views[0]) === tile(v2),
       "the nested SystemVerilog lays out the same too",
       rb.error || tile(rb.views[0]));
    ok(!rb.error && rb.views[0].segs.map(s=>s.path).join(" ") ===
       v2.segs.map(s=>s.path).join(" "),
       "keeping the dotted names", rb.error || rb.views[0].segs.map(s=>s.path).join(" "));
    lintSv(svn, amap+"_t", v2.width,
           v2.segs.map(s => ({name:s.path, w:s.w})), "nested sv");
  }
  console.log("");
}

const DESC = `
typedef struct packed { logic [1:0] cmd; logic valid; logic [4:0] _rsvd; } ctrl_t;
typedef struct packed {
  ctrl_t ctrl; logic [31:0] addr; logic [7:0] len; logic [3:0] qos; logic [11:0] _pad;
} desc_t;`;
const IPV4 = `
typedef struct packed {
  logic [3:0] version; logic [3:0] ihl; logic [7:0] tos; logic [15:0] total_length;
  logic [15:0] identification; logic [2:0] flags; logic [12:0] frag_offset;
  logic [7:0] ttl; logic [7:0] protocol; logic [15:0] checksum;
  logic [31:0] src_addr; logic [31:0] dst_addr;
} ipv4_hdr_t;`;
const CFG = `typedef struct { logic [2:0] mode; logic [11:0] count; logic en;
  logic [15:0] tag; } cfg_t;`;
const ODD = `typedef struct packed { logic [2:0] a; logic [40:0] b; logic c; } odd_t;`;

[8,16,32,64].forEach(rw => trip("descriptor", DESC, "desc_t", rw));
[8,32].forEach(rw => trip("ipv4", IPV4, "ipv4_hdr_t", rw));
trip("byte aligned with pads", CFG, "cfg_t", 32);
trip("byte aligned, 32-bit words", CFG, "cfg_t", 32, {align:32, lsb:true});
trip("odd widths", ODD, "odd_t", 16);
trip("one field", "typedef struct packed { logic [7:0] only; } one_t;", "one_t", 32);

/* ---- hand written SystemRDL, not something this page wrote ---- */
function rdlCase(title, rdl, top, expect){
  console.log("== hand written: " + title);
  const p = SV.parseRdl(rdl);
  ok(p.roots.length > 0, "something to draw", p.roots.map(r=>r.name+"("+r.kind+")").join(","));
  const name = top || p.roots[p.roots.length-1].name;
  const r = SV.views(p, name, {});
  if(r.error){ ok(false,"lays out",r.error); return; }
  const v = r.views[0];
  const got = v.segs.map(s => s.path + "[" + s.hi + ":" + s.lo + "]").join(" ");
  ok(got === expect, "laid out as expected", got + "\n         " + expect);
  gapless(v, "rdl");
  const sv = SV.svCode(r.views);
  const back = SV.views(SV.parse(sv), name.replace(/_t$/,"")+"_t", {});
  ok(!back.error && tile(back.views[0]) === tile(v), "and survives a trip through SV",
     back.error || tile(back.views[0]));
  lintSv(sv, name.replace(/_t$/,"")+"_t", v.width,
         v.segs.map(s => ({name:s.path, w:s.w})), "sv");
  console.log("");
}

rdlCase("implicit field allocation", `
addrmap imp {
    default regwidth = 32;
    reg {
        field { fieldwidth = 4; } a;
        field { fieldwidth = 8; } b;
        field {} c;
    } r0 @ 0x0;
};`, "imp", "_rsvd0[31:13] c[12:12] b[11:4] a[3:0]");

rdlCase("a named reg used twice", `
addrmap twice {
    default regwidth = 16;
    reg pair {
        field { desc = "hi"; } hi [15:8];
        field { desc = "lo"; } lo [ 7:0];
    };
    pair first  @ 0x0;
    pair second @ 0x2;
};`, "twice", "second_hi[31:24] second_lo[23:16] first_hi[15:8] first_lo[7:0]");

rdlCase("an array of registers", `
addrmap arr {
    default regwidth = 8;
    reg slot { field {} v [7:0]; };
    slot s[3] @ 0x0 += 0x1;
};`, "arr", "s_2_v[23:16] s_1_v[15:8] s_0_v[7:0]");

rdlCase("a regfile inside an addrmap", `
addrmap outer {
    default regwidth = 16;
    regfile inner {
        reg { field {} lo [15:0]; } a @ 0x0;
        reg { field {} hi [15:0]; } b @ 0x2;
    };
    inner blk @ 0x4;
};`, "outer", "hi[63:48] lo[47:32] _rsvd0[31:0]");

rdlCase("a regfile whose registers collide by name", `
addrmap clash {
    default regwidth = 16;
    reg one { field {} v [15:0]; };
    one a @ 0x0;
    one b @ 0x2;
};`, "clash", "b_v[31:16] a_v[15:0]");

rdlCase("hex and binary addresses", `
addrmap hexy {
    default regwidth = 32;
    reg { field {} x [3:0]; } r0 @ 0x0;
    reg { field {} y [3:0]; } r1 @ 0b100;
};`, "hexy", "_rsvd0[63:36] y[35:32] _rsvd1[31:4] x[3:0]");

rdlCase("a gap in the addresses", `
addrmap holey {
    default regwidth = 32;
    reg { field {} a [7:0]; } r0 @ 0x0;
    reg { field {} b [7:0]; } r2 @ 0x8;
};`, "holey", "_rsvd0[95:72] b[71:64] _rsvd1[63:8] a[7:0]");

rdlCase("a lone reg definition", `
reg standalone {
    regwidth = 16;
    field { desc = "top"; } top [15:8];
    field { desc = "bot"; } bot [ 7:0];
};`, "standalone", "top[15:8] bot[7:0]");

/* ---- name.field descriptions become subtypes, _name stays reserved ---- */
function nestCase(title, rdl, top, expect, opts){
  console.log("== subtype: " + title);
  const p = SV.parseRdl(rdl);
  const r = SV.views(p, top, {});
  if(r.error){ ok(false,"lays out",r.error); return null; }
  const v = r.views[0];
  const got = v.segs.map(s => s.path + "[" + s.hi + ":" + s.lo + "]").join(" ");
  ok(got === expect, "grouped as expected", got + "\n         " + expect);
  gapless(v, "rdl");
  if(opts && opts.types)
    ok(opts.types.every(t => p.types.has(t)), "a type per group: " + opts.types.join(" "),
       [...p.types.keys()].join(" "));
  if(opts && opts.reserved)
    ok(v.segs.filter(s => s.us).map(s => s.path).join(" ") === opts.reserved,
       "reserved fields spotted", v.segs.filter(s => s.us).map(s => s.path).join(" "));
  const nested = SV.views(p, top, {flatten:false});
  const svn = SV.svCode(nested.views);
  lintSv(svn, top.replace(/_t$/,"")+"_t", v.width,
         v.segs.map(s => ({name:s.path, w:s.w})), "nested sv");
  console.log("");
  return {p, v, svn};
}

const one = nestCase("one level", `
addrmap sub1 {
    default regwidth = 32;
    reg {
        field { desc = "ctrl.cmd";   } ctrl_cmd   [31:30];
        field { desc = "ctrl.valid"; } ctrl_valid [29:29];
        field { desc = "ctrl._rsvd"; } ctrl__rsvd [28:24];
        field { desc = "len";        } len        [23:16];
    } r0 @ 0x0;
};`, "sub1",
  "ctrl.cmd[31:30] ctrl.valid[29:29] ctrl._rsvd[28:24] len[23:16] _rsvd0[15:0]",
  {types:["ctrl_t"], reserved:"ctrl._rsvd _rsvd0"});
if(one) ok(/\} ctrl_t;/.test(one.svn) && /ctrl_t {2,}ctrl;/.test(one.svn),
           "the SystemVerilog declares and uses the subtype",
           (one.svn.match(/.*ctrl.*/g)||[]).join(" | "));

nestCase("two levels", `
addrmap sub2 {
    default regwidth = 16;
    reg {
        field { desc = "a.b.x"; } abx [15:12];
        field { desc = "a.b.y"; } aby [11: 8];
        field { desc = "a.z";   } az  [ 7: 4];
        field { desc = "top";   } top [ 3: 0];
    } r0 @ 0x0;
};`, "sub2", "a.b.x[15:12] a.b.y[11:8] a.z[7:4] top[3:0]",
  {types:["b_t","a_t"]});

nestCase("a hole inside a subtype", `
addrmap sub3 {
    default regwidth = 16;
    reg {
        field { desc = "g.hi"; } ghi [15:12];
        field { desc = "g.lo"; } glo [ 7: 4];
        field { desc = "tail"; } t   [ 3: 0];
    } r0 @ 0x0;
};`, "sub3", "g.hi[15:12] g._rsvd0[11:8] g.lo[7:4] t[3:0]",
  {types:["g_t"], reserved:"g._rsvd0"});

nestCase("the same group name twice, split apart", `
addrmap sub4 {
    default regwidth = 16;
    reg {
        field { desc = "p.a";  } pa  [15:12];
        field { desc = "mid";  } mid [11: 8];
        field { desc = "p.b";  } pb  [ 7: 4];
        field { desc = "tail"; } t   [ 3: 0];
    } r0 @ 0x0;
};`, "sub4", "p.a[15:12] mid[11:8] p_2.b[7:4] t[3:0]",
  {types:["p_t","p_t_2"]});

nestCase("prose in desc is left as prose", `
addrmap sub5 {
    default regwidth = 8;
    reg {
        field { desc = "The command to run"; } cmd  [7:4];
        field { desc = "enable";             } en   [3:2];
        field { desc = "_spare";             } junk [1:0];
    } r0 @ 0x0;
};`, "sub5", "cmd[7:4] en[3:2] _spare[1:0]",
  {reserved:"_spare"});

console.log("== held back subtype fields stay out of the generated code");
{
  const p = SV.parseRdl(`
addrmap held {
    default regwidth = 16;
    reg {
        field { desc = "ctl.go";    } ctl_go    [15:15];
        field { desc = "ctl._keep"; } ctl__keep [14: 8];
        field { desc = "data";      } data      [ 7: 0];
    } r0 @ 0x0;
};`);
  const r = SV.views(p,"held",{});
  const flat = r.views[0];
  ok(flat.segs.filter(s=>s.us).map(s=>s.path).join(" ") === "ctl._keep",
     "the underscored subtype field is marked",
     flat.segs.filter(s=>s.us).map(s=>s.path).join(" "));
  const c = SV.cCode(r.views,{skipUnderscore:true});
  ok(!/_keep/.test(c), "C leaves it out when names are held back",
     (c.match(/.*_keep.*/)||[])[0]);
  ok(/zero: \[14:8\]/.test(c), "and says which bits it left at zero",
     (c.match(/.*left out.*/)||[])[0]);
  const py = SV.pyCode(r.views,{skipUnderscore:true});
  ok(!/_keep/.test(py), "python too");
  const c2 = SV.cCode(r.views,{skipUnderscore:false});
  ok(/ctl__keep/.test(c2), "and keeps it when they are shown",
     (c2.match(/.*_keep.*/)||[])[0]);
  console.log("");
}

report.done();
