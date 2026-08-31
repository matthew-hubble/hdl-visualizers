/* Generate C and Python for a set of structs, then compile/run both and check
   that pack() produces exactly the word the layout says it should. */
const fs = require("fs"), cp = require("child_process"), path = require("path");
const {loadEngine, reporter, python, RDL_MODEL, OUT: OUTDIR} = require("./support/harness");

const OUT = path.join(OUTDIR, "generate");
fs.mkdirSync(OUT, {recursive:true});

const SV = loadEngine();
const report = reporter("generator");
const ok = report.ok;

// deterministic value for field i, masked to its width
const valOf = (i,w) => ((BigInt(i)*0x9E3779B97F4A7C15n + 0x5DEECE66Dn) >> 3n) & ((1n<<BigInt(w))-1n);

const MEMBER = /^ {4}(uint\d+_t) +(\w+)(?:\[(\d+)\])?; *\/\* \[ *(\d+): *(\d+)\] +(\d+) bits? +(.*?) *\*\/$/;

function membersFromC(src,ctype){
  const lines = src.split("\n");
  const start = lines.findIndex(l => l === "typedef struct {");
  const end   = lines.findIndex(l => l === "} "+ctype+";");
  const out = [];
  for(let i=start+1;i<end;i++){
    const m = MEMBER.exec(lines[i]);
    if(m) out.push({ctype:m[1], name:m[2], dim:m[3]?+m[3]:0,
                    hi:+m[4], lo:m[5]!==undefined?+m[5]:+m[4], w:+m[6], svtype:m[7]});
  }
  return {members:out, count:end-start-1};
}

/* The field comments must read as a table: [msb:lsb] with both indices right
   justified in equal width columns, and bit/bits starting at a fixed column. */
function columnsOk(lines, lang){
  if(lines.length < 2){ ok(true, lang+": too few fields to align"); return; }
  const cols = lines.map(l => {
    const r = /\[ *(\d+): *(\d+)\]/.exec(l);
    const u = /(\d+) (bits?)\b/.exec(l);
    if(!r || !u) return null;
    return {line:l,
      open:r.index, colon:r.index + r[0].indexOf(":"), close:r.index + r[0].length - 1,
      unit:u.index + u[1].length + 1,
      msbw:r[0].indexOf(":") - 1, lsbw:r[0].length - r[0].indexOf(":") - 2};
  });
  if(cols.some(c => !c)){
    ok(false, lang+": every field comment carries [msb:lsb] and a bit count",
       lines[cols.indexOf(null)]);
    return;
  }
  const same = k => cols.every(c => c[k] === cols[0][k]);
  ok(same("open") && same("close"), lang+": the range column is one width",
     cols.map(c=>c.open+".."+c.close).join(" "));
  ok(same("colon"), lang+": msb and lsb sit either side of one colon column",
     cols.map(c=>c.colon).join(" "));
  ok(cols.every(c => c.msbw === cols[0].msbw && c.lsbw === cols[0].lsbw),
     lang+": every msb and lsb field is the same width",
     cols.map(c=>c.msbw+"/"+c.lsbw).join(" "));
  ok(cols[0].msbw === cols[0].lsbw, lang+": msb width equals lsb width",
     cols[0].msbw+" vs "+cols[0].lsbw);
  ok(same("unit"), lang+": bit and bits start in the same column",
     cols.map(c=>c.unit+JSON.stringify(c.line.slice(c.unit,c.unit+4))).join(" "));
  const digits = cols.map(c => c.line.slice(c.open+1, c.colon).trim() + "," +
                               c.line.slice(c.colon+1, c.close).trim());
  ok(digits.every(d => /^\d+,\d+$/.test(d)), lang+": both indices are always printed",
     digits.join(" "));
}

/* Each struct, dataclass and addrmap is its own block, and columns are aligned
   within a block, so the checks below run per block rather than per file. */
function blocksBetween(text, startRe, endRe){
  const out = [];
  let cur = null;
  text.split("\n").forEach(l => {
    if(cur === null){ if(startRe.test(l)) cur = []; }
    else if(endRe.test(l)){ out.push(cur); cur = null; }
    else cur.push(l);
  });
  if(cur) out.push(cur);
  return out;
}
const cBlocks   = c   => blocksBetween(c,   /^typedef struct \{$/, /^\} \w+_t;$/);
const pyBlocks  = py  => blocksBetween(py,  /^@dataclass$/,        /^ {4}@classmethod$/);
const rdlBlocks = rdl => blocksBetween(rdl, /^addrmap \w+ \{$/,    /^\};$/);

/* Compile the generated SystemRDL with the Accellera-conformant compiler, then
   put every field back where the layout says it belongs. */
function checkRdl(views, rdl, rw, skipUS){
  const file = OUT + "/t.rdl";
  fs.writeFileSync(file, rdl);
  const has = v => v.segs.some(s => !s.pad && !(skipUS && s.us));
  const live = views.filter(has);
  if(!live.length){
    ok(/has no fields left to map/.test(rdl), "RDL says there is nothing to map",
       rdl.split("\n").slice(-3).join(" | "));
    ok(!/addrmap/.test(rdl.replace(/^\/\/.*$/gm,"")), "and emits no empty addrmap");
    return;
  }
  views = live;
  const tops = views.map(v => v.label.split(".").map(p=>p.replace(/_t$/,"")).join("_"));
  const r = cp.spawnSync(python(), [RDL_MODEL, file].concat(tops), {encoding:"utf8"});
  ok(r.status === 0, "SystemRDL compiles and elaborates",
     (r.stdout||"").trim().slice(0,300) + " " + (r.stderr||"").split("\n").slice(0,3).join(" | "));
  if(r.status !== 0) return;
  const model = JSON.parse(r.stdout);
  ok(model.length === views.length, "one addrmap per view", model.length+" of "+views.length);

  const stride = rw/8;
  views.forEach((v,vi) => {
    const m = model[vi], words = Math.ceil(v.width/rw);
    const fields = v.segs.filter(s => !s.pad && !(skipUS && s.us));
    ok(m.name === v.label, "the addrmap keeps the type name", m.name);
    ok(m.regs.every(g => g.regwidth === rw), "every register is " + rw + " bits wide",
       m.regs.map(g=>g.regwidth).join(","));
    ok(m.regs.every(g => g.addr % stride === 0), "addresses land on the stride",
       m.regs.map(g=>g.addr).join(","));
    ok(m.regs.length <= words && m.regs.length >= 1, "no more registers than words",
     m.regs.length+" for "+words+" words");

    // put each field part back into vector bits, from its register's address
    ok(m.regs.length < 2 || m.regs[0].addr === 0, "the listing starts at offset 0",
       m.regs.map(g=>g.addr).join(","));
    const low = m.regs.filter(g => g.addr === 0)[0];
    if(low) ok(low.desc === v.label + "[" + Math.min(v.width-1, rw-1) + ":0]",
               "and offset 0 holds the least significant word", low.desc);
    const parts = [];
    m.regs.forEach(g => {
      const wordLo = (g.addr/stride) * rw;
      ok(/^[\w.[\]]+\[\d+:\d+\]$/.test(g.desc||""),
         "the register says which bits it holds", g.desc);
      g.fields.forEach(f => parts.push({
        of: f.desc.replace(/\[\d+:\d+\]$/,""),
        hi: wordLo + f.msb, lo: wordLo + f.lsb, reg:g.inst, name:f.name
      }));
    });
    ok(parts.length >= fields.length, "at least one part per field",
       parts.length+" parts for "+fields.length+" fields");

    let rebuilt = 0;
    fields.forEach(f => {
      const mine = parts.filter(p => p.of === f.path).sort((a,b) => b.hi - a.hi);
      if(!mine.length){ report.fail("no RDL field for " + f.path); return; }
      let want = f.hi, gapless = true;
      mine.forEach(p => { if(p.hi !== want) gapless = false; want = p.lo - 1; });
      if(!(gapless && want === f.lo - 1)){
        report.fail(f.path + " [" + f.hi + ":" + f.lo + "] came back whole",
                    mine.map(p=>"["+p.hi+":"+p.lo+"]@"+p.reg).join(" "));
        return;
      }
      rebuilt++;
      if(mine.length > 1)
        ok(mine.every(p => /_\d+_\d+$/.test(p.name)),
           f.path + " is split across " + mine.length + " registers and says so",
           mine.map(p=>p.name).join(" "));
    });
    ok(rebuilt === fields.length, "every field rebuilt to its drawn bits",
       rebuilt + " of " + fields.length);

    // nothing may overlap, and reserved bits must stay unclaimed
    const sorted = parts.slice().sort((a,b) => b.hi - a.hi);
    ok(sorted.every((p,i) => i===0 || sorted[i-1].lo > p.hi), "no two parts overlap",
       sorted.map(p=>"["+p.hi+":"+p.lo+"]").join(" "));
    const claimed = parts.reduce((a,p) => a + (p.hi - p.lo + 1), 0);
    const want = fields.reduce((a,f) => a + f.w, 0);
    ok(claimed === want, "the parts claim exactly the field bits", claimed+" of "+want);
  });

  // and the field lines line up inside each addrmap
  rdlBlocks(rdl).forEach((block,bi) => {
    const lines = block.filter(l => /^ {8}field \{/.test(l));
    if(lines.length < 2) return;
    const tag = "RDL addrmap " + bi + ": ";
    const at = (l,ch) => l.indexOf(ch);
    ok(lines.every(l => at(l,"}") === at(lines[0],"}")), tag+"the brace column holds",
       lines.map(l=>at(l,"}")).join(","));
    const br = lines.map(l => l.indexOf("[", l.indexOf("}")));
    ok(br.every(x => x === br[0]), tag+"the bit range column holds", br.join(","));
    const rng = lines.map(l => /\[ *(\d+): *(\d+)\];$/.exec(l));
    ok(rng.every(m => m), tag+"every field carries [msb:lsb]");
    ok(rng.every(m => m && m[0].length === rng[0][0].length),
       tag+"msb and lsb are one width", rng.map(m=>m&&m[0]).join(" "));
  });
}

function run(title, src, rootName, opts, genOpts){
  console.log("== " + title + (genOpts && genOpts.skipUnderscore ? "  [underscore fields excluded]" : ""));
  const parsed = SV.parse(src);
  const res = SV.views(parsed, rootName || (parsed.roots.length ? parsed.roots[parsed.roots.length-1].name : ""), opts||{});
  if(res.error){ ok(false,"layout",res.error); return; }
  const v = res.views[0];
  const c = SV.cCode(res.views, genOpts), py = SV.pyCode(res.views, genOpts);
  const rw = (genOpts && genOpts.regwidth) || 32;
  const rdl = SV.rdlCode(res.views, Object.assign({regwidth:rw}, genOpts||{}));
  fs.writeFileSync(OUT+"/"+title.replace(/\W+/g,"_")+".rdl", rdl);
  checkRdl(res.views, rdl, rw, !!(genOpts && genOpts.skipUnderscore));
  fs.writeFileSync(OUT+"/"+title.replace(/\W+/g,"_")+".c", c);
  fs.writeFileSync(OUT+"/"+title.replace(/\W+/g,"_")+".py", py);

  cBlocks(c).forEach((block,i) =>
    columnsOk(block.filter(l => /\/\*/.test(l) && !/no fields/.test(l)), "C struct "+i));
  pyBlocks(py).forEach((block,i) =>
    columnsOk(block.filter(l => /^ {4}\w+: int = 0/.test(l)), "Python class "+i));
  const base = v.label.split(".").map(p=>p.replace(/_t$/,"")).join("_");
  const ctype = base+"_t";
  const {members, count} = membersFromC(c, ctype);
  const skipUS = !!(genOpts && genOpts.skipUnderscore);
  const fields = v.segs.filter(s => !s.pad && !(skipUS && s.us));
  const dropped = v.segs.filter(s => !s.pad && skipUS && s.us);
  if(skipUS){
    ok(dropped.length > 0, "the example has underscore fields to drop", dropped.length);
    ok(dropped.every(d => !new RegExp("\\b"+d.path.replace(/[.[\]]/g,"_")+"\\b").test(c)),
       "no C member for a dropped field");
    ok(dropped.every(d => !new RegExp("\\b"+d.path.replace(/[.[\]]/g,"_")+"\\b").test(py)),
       "no python field for a dropped field");
    dropped.forEach(d => {
      const r = d.hi===d.lo ? "["+d.hi+"]" : "["+d.hi+":"+d.lo+"]";
      ok(c.indexOf(r) >= 0 && py.indexOf(r) >= 0, "the comment records " + r);
    });
  }
  if(!fields.length)
    ok(members.length === 0 && count === 1 && /uint8_t _empty;/.test(c),
       "C keeps one placeholder member when nothing is emitted");
  else
    ok(members.length === count && members.length === fields.length,
       "C struct lists every field", members.length+" of "+fields.length);
  ok(members.every((m,i) => m.hi===fields[i].hi && m.lo===fields[i].lo && m.w===fields[i].w),
     "C comments carry the drawn bit ranges");

  // expected word, straight from the layout
  let want = 0n;
  members.forEach((m,i) => { want |= valOf(i,m.w) << BigInt(m.lo); });
  const nbytes = Math.ceil(v.width/8);
  const buffered = v.width > 64;

  /* ---- C ---- */
  const L = [c, "#include <stdio.h>", "", "int main(void)", "{",
             "    "+ctype+" a, b;", "    unsigned bad = 0;", ""];
  L.push("    memset_or_zero:; (void)0;");
  L.push("    { unsigned char *p = (unsigned char *)&a; unsigned k; for (k = 0; k < sizeof a; k++) p[k] = 0; }");
  members.forEach((m,i) => {
    const val = valOf(i,m.w);
    if(m.dim){                                    // wide field: fill byte by byte
      for(let b=0;b<m.dim;b++){
        const sh = BigInt(8*(m.dim-1-b));
        L.push("    a."+m.name+"["+b+"] = 0x"+((val>>sh)&0xFFn).toString(16).toUpperCase()+"u;");
      }
    } else {
      L.push("    a."+m.name+" = 0x"+val.toString(16).toUpperCase()+"u;");
    }
  });
  L.push("");
  if(buffered){
    L.push("    unsigned char buf["+nbytes+"] = {0};");
    L.push("    "+base+"_pack(&a, buf);");
    L.push("    { unsigned k; for (k = 0; k < "+nbytes+"u; k++) printf(\"%02X\", buf[k]); }");
    L.push("    printf(\"\\n\");");
    L.push("    "+base+"_unpack(buf, &b);");
  } else {
    L.push("    uint64_t w = (uint64_t)"+base+"_pack(&a);");
    L.push("    printf(\"%016llX\\n\", (unsigned long long)w);");
    L.push("    "+base+"_unpack(("+ (v.width<=8?"uint8_t":v.width<=16?"uint16_t":v.width<=32?"uint32_t":"uint64_t") +")w, &b);");
  }
  members.forEach(m => {
    if(m.dim) L.push("    { unsigned k; for (k = 0; k < "+m.dim+"u; k++) if (a."+m.name+"[k] != b."+m.name+"[k]) bad++; }");
    else      L.push("    if (a."+m.name+" != b."+m.name+") { bad++; printf(\"differs: "+m.name+"\\n\"); }");
  });
  L.push("    printf(bad ? \"ROUNDTRIP BAD\\n\" : \"ROUNDTRIP OK\\n\");");
  L.push("    return bad != 0;");
  L.push("}");
  const cfile = OUT+"/t.c", bin = OUT+"/t";
  fs.writeFileSync(cfile, L.join("\n").replace("    memset_or_zero:; (void)0;\n",""));
  let r = cp.spawnSync("gcc", ["-std=c99","-Wall","-Wextra","-Werror","-Wno-unused-function",
                               "-Wno-unused-label","-o",bin,cfile], {encoding:"utf8"});
  ok(r.status===0, "C compiles clean (-Wall -Wextra -Werror)", r.stderr.split("\n").slice(0,6).join(" | "));
  if(r.status===0){
    const out = cp.spawnSync(bin,[],{encoding:"utf8"});
    const lines = out.stdout.trim().split("\n");
    const got = lines[0];
    const wantHex = buffered ? want.toString(16).toUpperCase().padStart(nbytes*2,"0")
                             : want.toString(16).toUpperCase().padStart(16,"0");
    ok(got===wantHex, "C pack matches the layout", "got "+got+" want "+wantHex);
    ok(lines[lines.length-1]==="ROUNDTRIP OK", "C unpack returns every field", out.stdout.trim());
    if(skipUS){
      const packed = BigInt("0x"+got);
      const holes = dropped.every(d => ((packed >> BigInt(d.lo)) & ((1n<<BigInt(d.w))-1n)) === 0n);
      ok(holes, "the dropped bits come out zero");
    }
  }

  /* ---- Python ---- */
  const cls = base.split("_").filter(Boolean).map(p=>p[0].toUpperCase()+p.slice(1)).join("");
  const pyNames = (pyBlocks(py)[0] || [])
    .map(l => /^ {4}(\w+): int = 0 +# \[ *(\d+): *(\d+)\] +(\d+) bits?/.exec(l))
    .filter(Boolean).map(m => m[1]);
  ok(pyNames.length === members.length, "Python dataclass lists every field",
     pyNames.length+" of "+members.length);
  const P = [py, "", "f = "+cls+"("];
  members.forEach((m,i) => P.push("    "+pyNames[i]+"=0x"+valOf(i,m.w).toString(16).toUpperCase()+","));
  P.push(")");
  P.push("w = f.pack()");
  P.push('print("%0'+(nbytes*2)+'X" % w)');
  P.push("g = "+cls+".unpack(w)");
  P.push('print("ROUNDTRIP OK" if g == f else "ROUNDTRIP BAD %r %r" % (f, g))');
  P.push('print("BYTES OK" if '+cls+'.from_bytes(f.to_bytes()) == f else "BYTES BAD")');
  const pyfile = OUT+"/t.py";
  fs.writeFileSync(pyfile, P.join("\n"));
  const pr = cp.spawnSync("python3",[pyfile],{encoding:"utf8"});
  ok(pr.status===0, "Python runs", pr.stderr.split("\n").slice(0,4).join(" | "));
  if(pr.status===0){
    const lines = pr.stdout.trim().split("\n");
    ok(lines[0]===want.toString(16).toUpperCase().padStart(nbytes*2,"0"),
       "Python pack matches the layout", "got "+lines[0]);
    ok(lines[1]==="ROUNDTRIP OK", "Python unpack returns every field", lines[1]);
    ok(lines[2]==="BYTES OK", "Python to_bytes/from_bytes round trip", lines[2]);
  }
  console.log("");
}

run("descriptor", `
parameter int ADDR_W = 32;
typedef struct packed { logic [1:0] cmd; logic valid; logic [4:0] _rsvd; } ctrl_t;
typedef struct packed {
  ctrl_t ctrl; logic [ADDR_W-1:0] addr; logic [7:0] len; logic [3:0] qos; logic [11:0] _pad;
} desc_t;`);

run("ipv4 160 bits", `
typedef struct packed {
  logic [3:0] version; logic [3:0] ihl; logic [7:0] tos; logic [15:0] total_length;
  logic [15:0] identification; logic [2:0] flags; logic [12:0] frag_offset;
  logic [7:0] ttl; logic [7:0] protocol; logic [15:0] checksum;
  logic [31:0] src_addr; logic [31:0] dst_addr;
} ipv4_hdr_t;`);

run("byte aligned pads", `
typedef struct { logic [2:0] mode; logic [11:0] count; logic en; logic [15:0] tag; } cfg_t;`);

run("lrm pack1", `
struct packed signed { int a; shortint b; byte c; bit [7:0] d; } pack1;`);

run("nested array", `
typedef struct packed { logic [7:0] lo; logic [7:0] hi; } pair_t;
typedef struct packed { logic [3:0] tag; pair_t [3:0] slot; logic [11:0] _spare; } bank_t;`);

run("narrow 12 bit", `
typedef struct packed { logic [3:0] a; logic [7:0] b; } small_t;`);

run("wide field 96 bits", `
typedef struct packed { logic [7:0] tag; logic [95:0] payload; logic [7:0] crc; } blob_t;`);

run("c keywords as names", `
typedef struct packed { logic [3:0] int_x; logic [3:0] char_; logic [7:0] pack; } kw_t;`);

run("descriptor without underscore fields", `
parameter int ADDR_W = 32;
typedef struct packed { logic [1:0] cmd; logic valid; logic [4:0] _rsvd; } ctrl_t;
typedef struct packed {
  ctrl_t ctrl; logic [ADDR_W-1:0] addr; logic [7:0] len; logic [3:0] qos; logic [11:0] _pad;
} desc_t;`, null, {}, {skipUnderscore:true});

run("wide struct without underscore fields", `
typedef struct packed {
  logic [15:0] head;
  logic [63:0] _reserved;
  logic [31:0] tail;
  logic [7:0]  _crc_pad;
} frame_t;`, null, {}, {skipUnderscore:true});

run("byte aligned without underscore fields", `
typedef struct { logic [2:0] mode; logic [11:0] _spare; logic en; logic [15:0] tag; } cfg_t;`,
    null, {}, {skipUnderscore:true});

run("every field held back", `
typedef struct packed { logic [7:0] _a; logic [7:0] _b; } allhidden_t;`,
    null, {}, {skipUnderscore:true});

run("every field held back, wide", `
typedef struct packed { logic [63:0] _a; logic [15:0] _b; } allwide_t;`,
    null, {}, {skipUnderscore:true});

run("32-bit words, field at the LSB", `
typedef struct {
  logic [2:0]  mode;
  logic [11:0] count;
  logic        en;
  logic [15:0] tag;
} cfg_t;`, null, {align:32, lsb:true});

run("32-bit words, field at the MSB", `
typedef struct {
  logic [2:0]  mode;
  logic [11:0] count;
  logic        en;
  logic [15:0] tag;
} cfg_t;`, null, {align:32});

run("16-bit words, field at the LSB", `
typedef struct { logic [2:0] a; logic [11:0] b; logic [4:0] c; } small_t;`,
    null, {align:16, lsb:true});

run("64-bit words with a wide member", `
typedef struct { logic [2:0] tiny; logic [95:0] big; logic [7:0] last; } huge_t;`,
    null, {align:64, lsb:true});

run("32-bit words and held back fields", `
typedef struct { logic [2:0] mode; logic [11:0] _spare; logic [15:0] tag; } cfgx_t;`,
    null, {align:32, lsb:true}, {skipUnderscore:true});

const IPV4 = `
typedef struct packed {
  logic [3:0]  version;  logic [3:0]  ihl;      logic [7:0]  tos;
  logic [15:0] total_length; logic [15:0] identification;
  logic [2:0]  flags;    logic [12:0] frag_offset;
  logic [7:0]  ttl;      logic [7:0]  protocol; logic [15:0] checksum;
  logic [31:0] src_addr; logic [31:0] dst_addr;
} ipv4_hdr_t;`;

run("rdl: ipv4 in 8-bit registers",  IPV4, null, {}, {regwidth:8});
run("rdl: ipv4 in 16-bit registers", IPV4, null, {}, {regwidth:16});
run("rdl: ipv4 in 64-bit registers", IPV4, null, {}, {regwidth:64});

run("rdl: a field spanning three registers", `
typedef struct packed { logic [7:0] tag; logic [95:0] payload; logic [7:0] crc; } span_t;`,
    null, {}, {regwidth:32});

run("rdl: one field per register", `
typedef struct { logic [2:0] mode; logic [11:0] count; logic en; logic [15:0] tag; } cfg_t;`,
    null, {align:32, lsb:true}, {regwidth:32});

run("rdl: 8-bit registers on a byte aligned struct", `
typedef struct { logic [2:0] mode; logic [11:0] count; logic [15:0] tag; } cfg8_t;`,
    null, {}, {regwidth:8});

run("rdl: a union", `
typedef union packed {
  logic [31:0] raw;
  struct packed { logic [15:0] hi; logic [15:0] lo; } halves;
} word_t;`, null, {}, {regwidth:16});

run("rdl: rdl keywords as field names", `
typedef struct packed { logic [3:0] name; logic [3:0] desc; logic [7:0] reset; } kwr_t;`,
    null, {}, {regwidth:16});

report.done();
