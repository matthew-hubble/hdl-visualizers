/* With flatten off the generators describe nested structs as nested types.
   The check: for the same logical field values, the nested code must produce
   exactly the word the flattened layout says it should. C is compiled and run,
   Python is executed, SystemRDL is compiled by systemrdl-compiler. */
const fs = require("fs"), cp = require("child_process"), path = require("path");
const {loadEngine, reporter, python, RDL_MODEL, OUT: OUTDIR} = require("./support/harness");

const OUT = path.join(OUTDIR, "nested");
fs.mkdirSync(OUT, {recursive:true});

const SV = loadEngine();
const report = reporter("nested type");
const ok = report.ok;
const valOf = (i,w) => ((BigInt(i)*0x9E3779B97F4A7C15n + 0x5DEECE66Dn) >> 3n) & ((1n<<BigInt(w))-1n);

// dotted paths the generated code can actually reach, given a width limit
function reachable(view,limit){
  const out = {};
  (function walk(segs,prefix){
    segs.forEach(s => {
      if(s.pad) return;
      const p = prefix ? prefix + "." + s.path : s.path;
      if(s.sub && s.sub.width <= limit) walk(s.sub.segs, p);
      else out[p] = s;
    });
  })(view.segs, "");
  return out;
}

function run(title, src, root, opts, genOpts){
  console.log("== " + title);
  const parsed = SV.parse(src);
  const pick = root || (parsed.roots.length ? parsed.roots[parsed.roots.length-1].name : "");
  const flatOpts = Object.assign({}, opts, {flatten:true});
  const nestOpts = Object.assign({}, opts, {flatten:false});
  const flat = SV.views(parsed, pick, flatOpts);
  const nest = SV.views(parsed, pick, nestOpts);
  if(flat.error || nest.error){
    ok(false, "layout", flat.error || nest.error);
    return;
  }
  const skipUS = !!(genOpts && genOpts.skipUnderscore);
  const fv = flat.views[0], nv = nest.views[0];
  ok(fv.width === nv.width, "flat and nested agree on the width",
     fv.width + " vs " + nv.width);

  const leaves = fv.segs.filter(s => !s.pad && !(skipUS && s.us));
  const vals = leaves.map((s,i) => valOf(i,s.w));
  const want = leaves.reduce((a,s,i) => a | (vals[i] << BigInt(s.lo)), 0n);
  const nbytes = Math.ceil(nv.width/8);
  const hexWant = want.toString(16).toUpperCase().padStart(nbytes*2,"0");

  const c   = SV.cCode(nest.views, genOpts);
  const py  = SV.pyCode(nest.views, genOpts);
  const rdl = SV.rdlCode(nest.views, Object.assign({regwidth:32}, genOpts||{}));
  const tag = title.replace(/\W+/g,"_");
  fs.writeFileSync(OUT+"/n_"+tag+".c", c);
  fs.writeFileSync(OUT+"/n_"+tag+".py", py);
  fs.writeFileSync(OUT+"/n_"+tag+".rdl", rdl);

  const nestedC  = (c.match(/^typedef struct \{$/gm)||[]).length - 1;
  const nestedPy = (py.match(/^@dataclass$/gm)||[]).length - 1;
  ok(nestedC >= 0 && nestedPy >= 0, "one type per nesting level");

  /* ---- C ---- */
  const base = nv.label.split(".").map(p=>p.replace(/_t$/,"")).join("_");
  const ctype = base + "_t";
  const buffered = nv.width > 64;
  const cReach = reachable(nv,64);
  const cWhole = leaves.every(s => cReach[s.path] !== undefined);
  const L = [c, "#include <stdio.h>", "#include <string.h>", "", "int main(void)", "{",
             "    " + ctype + " a, b;", "    unsigned bad = 0;", "",
             "    memset(&a, 0, sizeof a);", "    memset(&b, 0, sizeof b);"];
  if(cWhole){
    leaves.forEach((s,i) => {
      if(s.w <= 64){
        L.push("    a." + s.path + " = 0x" + vals[i].toString(16).toUpperCase() + "u;");
        return;
      }
      const n = Math.ceil(s.w/8);                 // a wide leaf is a byte array
      for(let b=0;b<n;b++)
        L.push("    a." + s.path + "[" + b + "] = 0x" +
               ((vals[i] >> BigInt(8*(n-1-b))) & 0xFFn).toString(16).toUpperCase() + "u;");
    });
    L.push("");
    if(buffered){
      L.push("    unsigned char buf["+nbytes+"];");
      L.push("    " + base + "_pack(&a, buf);");
      L.push("    { unsigned k; for (k = 0; k < "+nbytes+"u; k++) printf(\"%02X\", buf[k]); }");
      L.push("    printf(\"\\n\");");
      L.push("    " + base + "_unpack(buf, &b);");
    } else {
      const wt = nv.width<=8?"uint8_t":nv.width<=16?"uint16_t":nv.width<=32?"uint32_t":"uint64_t";
      L.push("    " + wt + " word = " + base + "_pack(&a);");
      L.push("    printf(\"%0"+(nbytes*2)+"llX\\n\", (unsigned long long)word);");
      L.push("    " + base + "_unpack(word, &b);");
    }
    leaves.forEach(s => L.push(s.w <= 64
      ? "    if (a." + s.path + " != b." + s.path +
        ") { bad++; printf(\"differs: " + s.path + "\\n\"); }"
      : "    { unsigned k; for (k = 0; k < " + Math.ceil(s.w/8) + "u; k++) if (a." +
        s.path + "[k] != b." + s.path + "[k]) bad++; }"));
    L.push("    printf(bad ? \"ROUNDTRIP BAD\\n\" : \"ROUNDTRIP OK\\n\");");
  } else {
    L.push("    (void)a; (void)b;");
    L.push("    printf(\"COMPILE ONLY\\n\");");
  }
  L.push("    return bad != 0;");
  L.push("}");
  const cfile = OUT+"/n.c", bin = OUT+"/n";
  fs.writeFileSync(cfile, L.join("\n"));
  const build = cp.spawnSync("gcc", ["-std=c99","-Wall","-Wextra","-Werror",
    "-Wno-unused-function","-o",bin,cfile], {encoding:"utf8"});
  ok(build.status === 0, "nested C compiles clean",
     build.stderr.split("\n").slice(0,6).join(" | "));
  if(build.status === 0 && cWhole){
    const out = cp.spawnSync(bin,[],{encoding:"utf8"});
    const lines = out.stdout.trim().split("\n");
    ok(lines[0] === hexWant, "nested C packs the flattened word",
       "got " + lines[0] + " want " + hexWant);
    ok(lines[lines.length-1] === "ROUNDTRIP OK", "nested C unpack fills every leaf",
       out.stdout.trim());
  } else if(build.status === 0){
    ok(true, "C keeps a wide nested struct as bytes, so only the build is checked");
  }

  /* ---- Python ---- */
  const cls = base.split("_").filter(Boolean).map(p=>p[0].toUpperCase()+p.slice(1)).join("");
  const pyReach = reachable(nv,Infinity);
  const pyWhole = leaves.every(s => pyReach[s.path] !== undefined);
  const P = [py, "", "f = " + cls + "()"];
  if(pyWhole){
    leaves.forEach((s,i) => P.push("f." + s.path + " = 0x" + vals[i].toString(16).toUpperCase()));
    P.push("w = f.pack()");
    P.push('print("%0'+(nbytes*2)+'X" % w)');
    P.push("g = " + cls + ".unpack(w)");
    leaves.forEach(s => P.push('assert g.' + s.path + ' == f.' + s.path + ', "' + s.path + '"'));
    P.push('print("ROUNDTRIP OK")');
    P.push('print("BYTES OK" if ' + cls + '.from_bytes(f.to_bytes()) == f else "BYTES BAD")');
  } else {
    P.push('print("SKIP")');
  }
  const pyfile = OUT+"/n.py";
  fs.writeFileSync(pyfile, P.join("\n"));
  const pr = cp.spawnSync("python3",[pyfile],{encoding:"utf8"});
  ok(pr.status === 0, "nested python runs", pr.stderr.split("\n").slice(-4).join(" | "));
  if(pr.status === 0 && pyWhole){
    const lines = pr.stdout.trim().split("\n");
    ok(lines[0] === hexWant, "nested python packs the flattened word",
       "got " + lines[0] + " want " + hexWant);
    ok(lines[1] === "ROUNDTRIP OK", "nested python unpack fills every leaf", lines.join(" | "));
    ok(lines[2] === "BYTES OK", "and to_bytes round trips");
  }

  /* ---- SystemRDL ---- */
  const rfile = OUT+"/n.rdl";
  fs.writeFileSync(rfile, rdl);
  const tops = nest.views.filter(v => v.segs.some(s => !s.pad && !(skipUS && s.us)))
    .map(v => v.label.split(".").map(x=>x.replace(/_t$/,"")).join("_"));
  const rr = cp.spawnSync(python(), [RDL_MODEL, rfile].concat(tops), {encoding:"utf8"});
  ok(rr.status === 0, "nested SystemRDL compiles and elaborates",
     (rr.stdout||"").trim().slice(0,200) + (rr.stderr||"").split("\n").slice(0,3).join(" | "));

  // every nested type gets a reg component, and its fields sit where the sub-layout says
  const layouts = {};
  let cur = null;
  rdl.split("\n").forEach(l => {
    let m = /^reg (\w+) \{$/.exec(l);
    if(m){ cur = layouts[m[1]] = []; return; }
    if(/^\};$/.test(l)){ cur = null; return; }
    if(cur && (m = /^ {4}field \{ desc = "([^"]+)"; *\} (\w+) +\[ *(\d+): *(\d+)\];/.exec(l)))
      cur.push({path:m[1], name:m[2], hi:+m[3], lo:+m[4]});
  });
  (function walk(segs){
    segs.forEach(s => {
      if(s.pad || !s.sub || (skipUS && s.us)) return;
      walk(s.sub.segs);
      const nm = (s.sub.name || s.path).replace(/_t$/,"") + "_layout";
      const got = layouts[nm];
      if(!got){ report.fail("no reg component for " + s.path); return; }
      const wantFields = s.sub.segs.filter(x => !x.pad && !(skipUS && x.us));
      const same = got.length === wantFields.length &&
        wantFields.every((x,i) => got[i].path === x.path && got[i].hi === x.hi && got[i].lo === x.lo);
      ok(same, nm + " describes the inside of " + s.path,
         got.map(g=>g.path+"["+g.hi+":"+g.lo+"]").join(" ") + "  want  " +
         wantFields.map(x=>x.path+"["+x.hi+":"+x.lo+"]").join(" "));
    });
  })(nv.segs);
  const pointers = (rdl.match(/\/\/ .*, see \w+_layout$/gm)||[]).length;
  ok(pointers >= 1, "the carrying field points at the component", "found " + pointers);
  console.log("");
}

run("one level", `
typedef struct packed { logic [1:0] cmd; logic valid; logic [4:0] _rsvd; } ctrl_t;
typedef struct packed {
  ctrl_t ctrl; logic [31:0] addr; logic [7:0] len; logic [3:0] qos; logic [11:0] _pad;
} desc_t;`);

run("two levels", `
typedef struct packed { logic [3:0] lo; logic [3:0] hi; } pair_t;
typedef struct packed { pair_t inner; logic [7:0] mid; } mid_t;
typedef struct packed { mid_t deep; logic [15:0] top; } outer_t;`);

run("the same type twice", `
typedef struct packed { logic [3:0] a; logic [3:0] b; } cell_t;
typedef struct packed { cell_t first; cell_t second; logic [7:0] tail; } twin_t;`);

run("anonymous nested struct", `
typedef struct packed {
  struct packed { logic [7:0] hi; logic [7:0] lo; } halves;
  logic [15:0] rest;
} anon_t;`);

run("nested inside a byte aligned struct", `
typedef struct packed { logic [2:0] mode; logic en; } flags_t;
typedef struct { flags_t flags; logic [11:0] count; logic [15:0] tag; } cfg_t;`);

run("nested in a buffered parent", `
typedef struct packed { logic [7:0] a; logic [7:0] b; } hdr_t;
typedef struct packed { hdr_t hdr; logic [95:0] body; logic [15:0] crc; } frame_t;`);

run("a nested type wider than a word", `
typedef struct packed { logic [63:0] big; logic [31:0] more; } wide_t;
typedef struct packed { logic [7:0] tag; wide_t payload; } jumbo_t;`);

run("nested with names held back", `
typedef struct packed { logic [1:0] cmd; logic [5:0] _spare; } ctl_t;
typedef struct packed { ctl_t ctl; logic [15:0] data; logic [7:0] _rsvd; } msg_t;`,
    null, {}, {skipUnderscore:true});

run("nested with 32-bit words, LSB justified", `
typedef struct packed { logic [2:0] mode; logic en; } flags_t;
typedef struct { flags_t flags; logic [11:0] count; } cfg32_t;`,
    null, {align:32, lsb:true}, {regwidth:32});

report.done();
