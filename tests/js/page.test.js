/* The page itself, driven in jsdom: controls, tabs, table, notes and the tie
   between the diagram and the field table. No layout, so anything that needs
   real geometry lives in the browser suites instead. */
const {JSDOM, VirtualConsole} = require("jsdom");
const {inlinePage} = require("./support/harness");

const html = inlinePage();

let fails = 0;
function ok(cond, what, extra){
  if(!cond){ fails++; console.log("  FAIL " + what + (extra!==undefined ? "  got: "+extra : "")); }
  else console.log("  ok   " + what);
}
const sleep = ms => new Promise(r => setTimeout(r,ms));

(async () => {
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => { fails++; console.log("  PAGE ERROR: " + (e.stack||e.message)); });
  vc.on("error", (...a) => { fails++; console.log("  console.error: " + a.join(" ")); });

  const dom = new JSDOM(html, {
    runScripts:"dangerously", pretendToBeVisual:true, virtualConsole:vc
  });
  await sleep(300);
  const w = dom.window, d = w.document;
  const $ = id => d.getElementById(id);
  const q = s => Array.from(d.querySelectorAll(s));
  const txt = s => q(s).map(e => e.textContent.trim());
  const segInfo = () => q(".fseg").map(e => ({
    cls:e.className,
    ix:Array.from(e.querySelectorAll(".ixs i")).map(i=>i.textContent).join(":"),
    nm:e.querySelector(".nm").textContent,
    gc:e.style.gridColumn,
    key:e.dataset.seg
  }));
  const fire = (el,type) => el.dispatchEvent(new w.Event(type,{bubbles:true}));

  console.log("== default: desc_t, 64 bits, rows of 32");
  ok($("stampname").textContent === "desc_t", "stamp name", $("stampname").textContent);
  ok($("stampw").textContent === "64 bits", "stamp width", $("stampw").textContent);
  ok(q(".drow").length === 2, "two rows", q(".drow").length);
  ok(txt(".rlab").join(" | ") === "63:32 | 31:0", "row labels", txt(".rlab").join(" | "));
  ok(q(".drow")[0].querySelectorAll(".ticks i").length === 32, "32 ticks in row 1");
  ok(q(".drow")[0].querySelectorAll(".ticks i.b").length === 4, "4 byte ticks in row 1",
     q(".drow")[0].querySelectorAll(".ticks i.b").length);
  ok($("root").options.length === 2 && $("root").value === "desc_t", "type picker", $("root").value);

  const segs = segInfo();
  console.log(segs.map(s => "    " + s.ix.padEnd(8) + s.nm.padEnd(8) + s.gc.padEnd(14) + s.cls).join("\n"));
  ok(segs.length === 8, "8 drawn segments (addr is split)", segs.length);
  ok(segs[0].ix === "63:62" && segs[0].nm === "cmd", "first field is cmd [63:62]");
  ok(segs[1].ix === "61" && segs[1].cls.includes("one"), "valid is a single bit");
  ok(segs[3].ix === "55:32" && segs[3].cls.includes("cr"), "addr top piece continues below", segs[3].ix+" "+segs[3].cls);
  ok(segs[4].ix === "31:24" && segs[4].cls.includes("cl"), "addr lower piece continues above", segs[4].ix+" "+segs[4].cls);
  ok(segs[3].key === segs[4].key, "both addr pieces share one key");
  ok(segs[0].gc === "1 / span 2", "cmd grid column", segs[0].gc);
  ok(segs[7].gc === "21 / span 12", "_pad grid column", segs[7].gc);
  ok(new Set(segs.filter(s=>!s.cls.includes("pad")).map(s=>(s.cls.match(/c\d/)||[])[0])).size === 7,
     "seven distinct colours");

  const rows = q("#ftbody tr");
  ok(rows.length === 7, "7 table rows", rows.length);
  ok(rows[0].children[0].textContent.trim() === "ctrl.cmd", "dotted path in table", rows[0].children[0].textContent.trim());
  ok(rows[0].children[1].textContent === "logic [1:0]", "type column", rows[0].children[1].textContent);
  ok(rows[3].children[2].textContent === "[55:24]", "addr range in table", rows[3].children[2].textContent);
  ok(rows[3].children[4].textContent === "0x00FFFFFFFF000000", "addr mask", rows[3].children[4].textContent);
  ok($("dmeta").textContent.includes("64 bits") && $("dmeta").textContent.includes("8 bytes") &&
     $("dmeta").textContent.includes("7 fields") && $("dmeta").textContent.includes("rows of 32"),
     "meta line", $("dmeta").textContent);
  ok($("notes").children.length === 0, "no notes", $("notes").textContent);

  console.log("== the source editor is numbered");
  const original = $("src").value;
  ok(!!$("gutter") && $("gutter").parentNode === $("editor"), "there is a gutter in the editor");
  ok($("src").parentNode === $("editor"), "sharing the box with the textarea");
  ok($("gutter").getAttribute("aria-hidden") === "true", "and hidden from a reader");
  ok($("gutter").children.length === $("src").value.split("\n").length,
     "one number per line", $("gutter").children.length);
  ok(txt("#gutter div")[0] === "1", "starting at one");
  ok($("editor").style.getPropertyValue("--dg") === "2", "two digits for 17 lines",
     $("editor").style.getPropertyValue("--dg"));
  $("src").value = "typedef struct packed { logic [3:0] a; } t;\nreturn x;";
  fire($("src"),"input");
  ok($("gutter").children.length === 2, "shrinks with the source",
     $("gutter").children.length);
  ok(q("#gutter .bad").length === 1 && q("#gutter .bad")[0].textContent === "2",
     "the line it could not read is marked",
     q("#gutter .bad").map(e => e.textContent).join(","));
  $("src").value = "typedef struct packed { logic [3:0] a; } t;";
  fire($("src"),"input");
  ok(q("#gutter .bad").length === 0, "and the mark clears");
  $("src").value = original;
  fire($("src"),"input");

  console.log("== the bit layout panel offers an image");
  ok(!!$("copyimg"), "there is a copy image button");
  ok($("copyimg").textContent === "copy image", "labelled plainly", $("copyimg").textContent);
  ok($("copyimg").closest(".legendline") === d.querySelector("#dpanel .legendline"),
     "sitting on the bit layout legend line");
  ok($("copyimg").classList.contains("copy"), "styled like the other copy buttons");

  console.log("== hover links diagram and table");
  const target = q('.fseg[data-seg="0-3"]')[0];
  target.dispatchEvent(new w.MouseEvent("mouseover",{bubbles:true}));
  ok(q('[data-seg="0-3"].hl').length === 3, "hover highlights both pieces and the row",
     q('[data-seg="0-3"].hl').length);
  d.querySelector("h1").dispatchEvent(new w.MouseEvent("mouseover",{bubbles:true}));
  ok(q(".hl").length === 0, "leaving clears the highlight");

  console.log("== switch to 64-bit rows");
  $("w64").checked = true; fire($("w64"),"change");
  ok(q(".drow").length === 1, "one row", q(".drow").length);
  ok(txt(".rlab")[0] === "63:0", "row label", txt(".rlab")[0]);
  ok($("w64lbl").textContent === "64 bits", "checkbox label follows", $("w64lbl").textContent);
  ok(q(".fseg").length === 7, "no field is split now", q(".fseg").length);
  ok(q(".ticks i").length === 64, "64 ticks", q(".ticks i").length);
  ok($("dmeta").textContent.includes("rows of 64"), "meta says rows of 64");

  console.log("== hide underscore names");
  $("us").checked = false; fire($("us"),"change");
  const mute = q(".fseg.mute");
  ok(mute.length === 2, "two withheld fields", mute.length);
  ok(mute.every(e => e.querySelector(".nm").textContent === ""), "their names are blank");
  ok(mute.every(e => e.querySelector(".ixs").textContent !== ""), "their bit indices stay");
  ok(q(".fseg").length === 7 && $("stampw").textContent === "64 bits", "the layout did not move");
  ok(q("#ftbody tr.dim").length === 2, "table dims those rows", q("#ftbody tr.dim").length);
  ok($("dmeta").textContent.includes("2 names withheld"), "meta counts them", $("dmeta").textContent);
  $("us").checked = true; fire($("us"),"change");
  $("w64").checked = false; fire($("w64"),"change");

  console.log("== collapse nested types");
  $("flat").checked = false; fire($("flat"),"change");
  ok(q("#ftbody tr").length === 5, "ctrl collapses to one row", q("#ftbody tr").length);
  ok(q("#ftbody tr")[0].children[1].textContent === "ctrl_t", "shows the typedef name",
     q("#ftbody tr")[0].children[1].textContent);
  $("flat").checked = true; fire($("flat"),"change");

  const preset = name => {
    const b = q("#presets button").filter(x => x.textContent === name)[0];
    b.dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  };

  console.log("== byte aligned example");
  preset("byte aligned");
  ok($("stampw").textContent === "48 bits", "48 bits", $("stampw").textContent);
  ok(q(".fseg.pad").length === 3, "three pad blocks", q(".fseg.pad").length);
  ok(txt(".fseg.pad .nm").every(t => t === "pad"), "pads are labelled");
  ok($("dmeta").textContent.includes("16 pad bits"), "meta counts pad bits", $("dmeta").textContent);
  ok(segInfo().map(s=>s.ix).join(" ") === "47:45 44:40 39:32 31:28 27:24 23 22:16 15:0",
     "byte aligned ranges (count is split at 32)", segInfo().map(s=>s.ix).join(" "));

  console.log("== ipv4 example");
  preset("IPv4 header");
  ok($("stampw").textContent === "160 bits", "160 bits", $("stampw").textContent);
  ok(q(".drow").length === 5, "five rows", q(".drow").length);
  ok(q("#ftbody tr").length === 12, "12 fields", q("#ftbody tr").length);
  ok($("mkhead").style.display === "none", "mask column hidden past 128 bits", $("mkhead").style.display);

  console.log("== nested array example");
  preset("nested array");
  ok($("stampw").textContent === "80 bits", "80 bits", $("stampw").textContent);
  ok(q("#ftbody tr").length === 10, "tag + 8 slot halves + spare", q("#ftbody tr").length);
  ok(q("#ftbody tr")[1].children[0].textContent.trim() === "slot[3].lo", "indexed path",
     q("#ftbody tr")[1].children[0].textContent.trim());

  console.log("== union example");
  preset("union");
  ok(q(".view").length === 3, "three variants", q(".view").length);
  ok(txt(".dcap")[0].startsWith("word_t.raw"), "variant caption", txt(".dcap")[0]);
  ok(q(".view")[2].querySelectorAll(".fseg").length === 4, "bytes variant has four fields");
  ok($("stampname").textContent === "word_t", "stamp shows the union", $("stampname").textContent);
  ok(q("#ftbody tr")[1].children[0].textContent.trim() === "halves.hi", "table names the variant",
     q("#ftbody tr")[1].children[0].textContent.trim());

  console.log("== reserved fields example + LRM example");
  preset("reserved fields");
  ok($("stampw").textContent === "64 bits", "64 bits", $("stampw").textContent);
  preset("LRM 7.2");
  ok($("root").value === "pack1" && $("stampw").textContent === "64 bits", "pack1 variable root",
     $("root").value + " " + $("stampw").textContent);
  ok(txt(".fseg .nm").join(" ") === "a b c d", "four members", txt(".fseg .nm").join(" "));

  console.log("== errors and warnings");
  $("src").value = "typedef struct packed { missing_t x; logic y; } oops_t;";
  fire($("src"),"input");
  ok($("notes").querySelectorAll(".note.alert").length === 1, "unknown type is an alert");
  ok($("notes").textContent.includes("unknown type 'missing_t'"), "message", $("notes").textContent);
  ok($("dpanel").classList.contains("faded"), "diagram fades out");

  $("src").value = "typedef struct packed { real g; logic [7:0] ok; } bad_t;";
  fire($("src"),"input");
  ok($("notes").querySelectorAll(".note.warn").length === 1, "real member warns",
     $("notes").textContent);
  ok(!$("dpanel").classList.contains("faded"), "but it is still drawn");

  $("src").value = "always_comb begin\n  x = 1;\nend\ntypedef struct packed { logic [3:0] a; } t;";
  fire($("src"),"input");
  ok($("stampw").textContent === "4 bits", "declarations after noise still parse", $("stampw").textContent);

  $("src").value = "";
  fire($("src"),"input");
  ok($("notes").textContent.includes("Nothing to draw yet"), "empty input", $("notes").textContent);

  console.log("== copy a bit range");
  preset("descriptor");
  let copied = null;
  w.navigator.clipboard = {writeText: t => { copied = t; return Promise.resolve(); }};
  q('.fseg[data-seg="0-1"]')[0].dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  await sleep(20);
  ok(copied === "[61]", "single bit copies as [61]", copied);
  q('.fseg[data-seg="0-3"]')[0].dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  await sleep(20);
  ok(copied === "[55:24]", "split field copies its full range", copied);
  $("copybtn").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  await sleep(20);
  ok(copied.split("\n").length === 8 && copied.includes("ctrl.cmd"), "copy table", JSON.stringify(copied.slice(0,60)));

  console.log("== tabs");
  await sleep(1100);            // let the copy button label settle
  preset("descriptor");
  ok($("tabs").querySelectorAll("button").length === 4, "four tabs");
  ok($("tab-fields").getAttribute("aria-selected") === "true", "fields selected first");
  ok($("pane-fields").hidden === false && $("pane-c").hidden && $("pane-py").hidden,
     "only the fields pane shows");
  ok($("copybtn").textContent === "copy table", "copy button names the tab", $("copybtn").textContent);

  $("tab-c").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  ok($("pane-c").hidden === false && $("pane-fields").hidden, "C tab swaps the pane");
  ok($("tab-c").getAttribute("aria-selected") === "true" &&
     $("tab-fields").getAttribute("aria-selected") === "false", "aria-selected moves");
  ok($("copybtn").textContent === "copy C", "copy button follows", $("copybtn").textContent);
  const ctext = $("pane-c").textContent;
  ok(/#include <stdint\.h>/.test(ctext), "C includes stdint");
  ok(/typedef struct \{/.test(ctext) && /\} desc_t;/.test(ctext), "C emits the struct");
  ok(/static uint64_t desc_pack\(const desc_t \*f\)/.test(ctext), "C pack signature",
     (ctext.match(/static.*pack.*/)||[])[0]);
  ok(/static void desc_unpack\(uint64_t word, desc_t \*f\)/.test(ctext), "C unpack signature");
  ok(/uint8_t  ctrl_cmd; +\/\* \[63:62\]/.test(ctext), "dotted path became ctrl_cmd",
     (ctext.match(/.*ctrl_cmd.*/)||[])[0]);
  ok(/\[61:61\] +1 bit /.test(ctext), "a single bit still prints both indices",
     (ctext.match(/.*ctrl_valid.*/)||[])[0]);
  ok(/\[11: 0\] +12 bits /.test(ctext), "and a one-digit lsb is right justified",
     (ctext.match(/.*_pad.*\*\//)||[])[0]);
  ok(/# \[61:61\] +1 bit +logic$/m.test($("pane-py").textContent), "python matches",
     ($("pane-py").textContent.match(/.*ctrl_valid.*/)||[])[0]);
  ok(/<< 62\)/.test($("pane-c").textContent), "shift into place");
  ok(/&lt;stdint\.h&gt;/.test($("pane-c").innerHTML), "angle brackets are escaped for display");
  ok($("pane-c").querySelectorAll(".cm").length > 0, "comments are dimmed",
     $("pane-c").querySelectorAll(".cm").length);

  $("tab-py").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  const ptext = $("pane-py").textContent;
  ok($("pane-py").hidden === false, "python pane shows");
  ok(/from dataclasses import dataclass/.test(ptext), "python imports dataclass");
  ok(/@dataclass\nclass Desc:/.test(ptext), "class name from the type", (ptext.match(/class .*/)||[])[0]);
  ok(/ctrl_cmd: int = 0/.test(ptext), "annotated field");
  ok(/def unpack\(cls, word: int\) -> "Desc":/.test(ptext), "unpack classmethod");
  ok(/def pack\(self\) -> int:/.test(ptext), "pack method");
  ok(/def to_bytes\(self\) -> bytes:/.test(ptext), "to_bytes helper");
  ok($("copybtn").textContent === "copy python", "copy button names python");

  copied = null;
  $("copybtn").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  await sleep(20);
  ok(copied === ptext, "copy button copies the python source",
     copied === null ? "nothing copied" : "len " + copied.length);
  $("tab-c").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  copied = null;
  $("copybtn").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  await sleep(20);
  ok(copied === ctext, "and the C source");

  console.log("== tabs keep up with edits");
  $("src").value = "typedef struct packed { logic [11:0] alpha; logic [3:0] beta; } two_t;";
  fire($("src"),"input");
  ok($("pane-c").hidden === false, "the C tab stays open across a re-render");
  ok(/\} two_t;/.test($("pane-c").textContent) && /class Two:/.test($("pane-py").textContent),
     "both panes regenerated");
  ok(!/desc_t/.test($("pane-c").textContent), "old source is gone");

  $("w64").checked = true; fire($("w64"),"change");
  ok(/\} two_t;/.test($("pane-c").textContent), "row width does not change the code");
  $("w64").checked = false; fire($("w64"),"change");

  preset("IPv4 header");
  ok(/bits_get\(const uint8_t \*buf/.test($("pane-c").textContent),
     "past 64 bits the C uses a byte buffer");
  ok(/ipv4_hdr_pack\(const ipv4_hdr_t \*f, uint8_t buf\[IPV4_HDR_BYTES\]\)/.test($("pane-c").textContent),
     "buffer pack signature");
  ok(/BYTES = 20/.test($("pane-py").textContent), "python knows the byte count");

  preset("union");
  ok(/\} word_raw_t;/.test($("pane-c").textContent) && /\} word_halves_t;/.test($("pane-c").textContent),
     "a union emits one struct per member");
  ok(/class WordRaw:/.test($("pane-py").textContent) && /class WordBytes:/.test($("pane-py").textContent),
     "and one dataclass per member");

  preset("byte aligned");
  ok(/pack leaves them at zero: \[44:40\]/.test($("pane-c").textContent),
     "pad ranges are called out", (($("pane-c").textContent.match(/.*pack leaves.*/))||[])[0]);
  ok(!/_empty/.test($("pane-c").textContent), "no placeholder member");

  console.log("== arrow keys move between tabs");
  $("tab-c").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  const kev = k => $("tabs").dispatchEvent(new w.KeyboardEvent("keydown",{key:k,bubbles:true}));
  kev("ArrowRight");
  ok($("tab-py").getAttribute("aria-selected") === "true", "right moves on");
  kev("ArrowRight");
  ok($("tab-rdl").getAttribute("aria-selected") === "true", "on to the last tab");
  kev("ArrowRight");
  ok($("tab-fields").getAttribute("aria-selected") === "true", "and wraps round");
  kev("ArrowLeft");
  ok($("tab-rdl").getAttribute("aria-selected") === "true", "left wraps back");
  $("tab-fields").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));

  console.log("== the underscore switch reaches the code tabs");
  preset("descriptor");
  $("tab-c").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  ok(/ctrl__rsvd/.test($("pane-c").textContent) && /_pad/.test($("pane-c").textContent),
     "with names shown, both underscore fields are in the C");
  ok(/ctrl__rsvd/.test($("pane-py").textContent), "and in the python");
  ok(!/left out/.test($("pane-c").textContent), "and nothing is said about leaving them out");

  $("us").checked = false; fire($("us"),"change");
  const cOut = $("pane-c").textContent, pOut = $("pane-py").textContent;
  ok(!/ctrl__rsvd/.test(cOut) && !/_pad/.test(cOut), "unchecked drops them from the C");
  ok(!/ctrl__rsvd/.test(pOut) && !/_pad/.test(pOut), "and from the python");
  ok(/Underscore fields are left out; pack leaves their bits at zero: \[60:56\] \[11:0\]/.test(cOut),
     "the C comment records the holes", (cOut.match(/.*left out.*/)||[])[0]);
  ok(/Underscore fields are left out; pack leaves their bits at zero: \[60:56\] \[11:0\]/.test(pOut),
     "the python docstring too");
  ok(/uint8_t  ctrl_cmd;/.test(cOut) && /uint32_t addr;/.test(cOut), "the rest is untouched");
  ok((cOut.match(/f->\w+ +=/g)||[]).length === 5, "unpack writes five fields",
     (cOut.match(/f->\w+ +=/g)||[]).length);
  ok(/<< 12\);/.test(cOut), "the last pack term still closes the statement");
  ok((pOut.match(/: int = 0/g)||[]).length === 5, "five dataclass fields",
     (pOut.match(/: int = 0/g)||[]).length);
  ok(q("#ftbody tr").length === 7, "the field table still lists all seven",
     q("#ftbody tr").length);
  ok($("stampw").textContent === "64 bits" && q(".fseg").length === 8,
     "and the diagram is unchanged");

  $("us").checked = true; fire($("us"),"change");
  ok(/ctrl__rsvd/.test($("pane-c").textContent), "checking it again brings them back");

  console.log("== held back, byte aligned and wide");
  preset("byte aligned");
  $("src").value = "typedef struct {\n  logic [2:0] mode;\n  logic [11:0] _spare;\n  logic [15:0] tag;\n} cfg_t;";
  fire($("src"),"input");
  $("us").checked = false; fire($("us"),"change");
  ok(!/_spare/.test($("pane-c").textContent), "byte aligned: the field goes");
  ok(/Pad bits/.test($("pane-c").textContent) && /Underscore fields/.test($("pane-c").textContent),
     "pad and held-back ranges are listed apart",
     $("pane-c").textContent.split("\n").filter(l=>/zero/.test(l)).join(" // "));

  $("src").value = "typedef struct packed {\n  logic [15:0] head;\n  logic [63:0] _reserved;\n  logic [31:0] tail;\n} frame_t;";
  fire($("src"),"input");
  ok(!/_reserved/.test($("pane-c").textContent), "past 64 bits the field goes too");
  ok(/bits_set\(buf, FRAME_BYTES, 96, 16, f->head\);/.test($("pane-c").textContent),
     "the surviving fields keep their bit offsets",
     ($("pane-c").textContent.match(/ {4}bits_set.*/)||[])[0]);
  ok(/bits_set\(buf, FRAME_BYTES,  0, 32, f->tail\);/.test($("pane-c").textContent),
     "including the one below the hole");
  const calls = () => (($("pane-c").textContent.match(/bits_set\(buf,/g))||[]).length;
  ok(calls() === 2, "two fields packed, not three", calls());
  $("us").checked = true; fire($("us"),"change");
  ok(calls() === 3, "all three when shown", calls());

  console.log("== alignment word width and justification");
  preset("byte aligned");
  const unitBtn = v => $("unit").querySelector('[data-v="'+v+'"]');
  const justBtn = v => $("just").querySelector('[data-v="'+v+'"]');
  const ranges = () => segInfo().map(s => s.ix).join(" ");

  ok($("unit").querySelectorAll("button").length === 4, "four word widths");
  ok(unitBtn("8").getAttribute("aria-pressed") === "true", "8 bits to start");
  ok(justBtn("msb").getAttribute("aria-pressed") === "true", "MSB to start");
  ok($("stampw").textContent === "48 bits", "byte aligned is 48 bits", $("stampw").textContent);
  ok(/an 8-bit word, field at the top/.test($("alignhint").textContent),
     "the hint reads the controls", $("alignhint").textContent);

  unitBtn("32").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  ok(unitBtn("32").getAttribute("aria-pressed") === "true" &&
     unitBtn("8").getAttribute("aria-pressed") === "false", "pressing moves the highlight");
  ok($("stampw").textContent === "128 bits", "four 32-bit words", $("stampw").textContent);
  ok(ranges() === "127:125 124:96 95:84 83:64 63 62:32 31:16 15:0",
     "members take the top of each word", ranges());
  ok(/a 32-bit word, field at the top/.test($("alignhint").textContent), "hint follows");
  ok($("dmeta").textContent.includes("96 pad bits"), "pad count grew", $("dmeta").textContent);

  justBtn("lsb").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  ok($("stampw").textContent === "128 bits", "same width, LSB justified");
  ok(ranges() === "127:99 98:96 95:76 75:64 63:33 32 31:16 15:0",
     "members take the bottom of each word", ranges());
  ok(/field at the bottom/.test($("alignhint").textContent), "hint says bottom");
  const lows = q("#ftbody tr").filter(tr => !/^—/.test(tr.textContent))
    .map(tr => tr.children[2].textContent)
    .map(t => +(t.match(/:(\d+)\]/) ? RegExp.$1 : t.match(/\[(\d+)\]/)[1]));
  ok(lows.every(l => l % 32 === 0), "every field's low bit is on a boundary", lows.join(","));

  unitBtn("16").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  ok($("stampw").textContent === "64 bits", "16-bit words", $("stampw").textContent);
  ok(ranges() === "63:51 50:48 47:44 43:32 31:17 16 15:0", "16-bit LSB layout", ranges());
  unitBtn("64").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  ok($("stampw").textContent === "256 bits", "64-bit words", $("stampw").textContent);

  console.log("== the code tabs follow the alignment");
  unitBtn("32").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  $("tab-c").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  const ct = $("pane-c").textContent;
  ok(/#define CFG_BITS +128/.test(ct), "the C knows the new width",
     (ct.match(/.*CFG_BITS.*/)||[])[0]);
  ok(/uint8_t  mode; +\/\* \[98:96\]/.test(ct), "and the new field position",
     (ct.match(/.*mode.*/)||[])[0]);
  ok(/bits_set\(buf, CFG_BYTES, 96, +3, f->mode\);/.test(ct), "pack uses the shifted offset",
     (ct.match(/ {4}bits_set.*mode.*/)||[])[0]);
  ok(/zero: \[127:99\] \[95:76\] \[63:33\] \[31:16\]/.test(ct), "pad ranges listed",
     (ct.match(/.*zero:.*/)||[])[0]);
  ok(/BYTES = 16/.test($("pane-py").textContent), "python too");
  $("tab-fields").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));

  console.log("== packed types are untouched by either control");
  preset("descriptor");
  ok(/idle/.test($("alignhint").textContent), "the hint says so",
     $("alignhint").textContent);
  const packedRanges = ranges();
  [["8","msb"],["16","lsb"],["32","msb"],["64","lsb"]].forEach(([u,j]) => {
    unitBtn(u).dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
    justBtn(j).dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
    ok(ranges() === packedRanges && $("stampw").textContent === "64 bits",
       "unit " + u + "/" + j + " leaves desc_t alone", ranges());
  });

  console.log("== a plain struct nested in the mix");
  $("src").value = "typedef struct packed { logic [3:0] lo; logic [3:0] hi; } byte_t;\n" +
                   "typedef struct { logic [2:0] head; byte_t body; logic tail; } mix_t;";
  fire($("src"),"input");
  unitBtn("32").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  justBtn("msb").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  ok($("stampw").textContent === "96 bits", "three words", $("stampw").textContent);
  ok(ranges() === "95:93 92:64 63:60 59:56 55:32 31 30:0",
     "the packed member abuts inside its word", ranges());
  ok(!/idle/.test($("alignhint").textContent), "the controls apply here",
     $("alignhint").textContent);
  unitBtn("8").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));

  console.log("== the SystemRDL tab");
  preset("descriptor");
  ok($("tabs").querySelectorAll("button").length === 4, "four tabs now");
  const regwBtn = v => $("regw").querySelector('[data-v="'+v+'"]');
  ok(regwBtn("32").getAttribute("aria-pressed") === "true", "32-bit registers to start");
  $("tab-rdl").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  ok($("pane-rdl").hidden === false && $("pane-py").hidden && $("pane-fields").hidden,
     "the RDL pane shows on its own");
  ok($("copybtn").textContent === "copy rdl", "the copy button names it",
     $("copybtn").textContent);

  let rdl = $("pane-rdl").textContent;
  ok(/^addrmap desc \{$/m.test(rdl), "an addrmap named after the type",
     (rdl.match(/addrmap.*\{/)||[])[0]);
  ok(/name = "desc_t";/.test(rdl), "keeping the original type name");
  ok(/desc = "64 bits in 2 registers of 32";/.test(rdl), "and saying how it was split",
     (rdl.match(/.*registers of.*/)||[])[0]);
  ok(/ {4}default regwidth = 32;/.test(rdl), "regwidth default");
  ok(/ {4}default sw = rw;/.test(rdl) && / {4}default hw = r;/.test(rdl), "access defaults");
  ok((rdl.match(/^ {4}reg \{$/gm)||[]).length === 2, "two registers",
     (rdl.match(/^ {4}reg \{$/gm)||[]).length);
  ok(/\} desc_0 @ 0x0;/.test(rdl) && /\} desc_1 @ 0x4;/.test(rdl), "addresses stride by 4",
     (rdl.match(/\} desc_\d @ .*/g)||[]).join(" "));
  ok(rdl.indexOf('desc = "desc_t[31:0]"') < rdl.indexOf('desc = "desc_t[63:32]"'),
     "the low word is listed first",
     (rdl.match(/desc = "desc_t\[[\d:]+\]"/g)||[]).join(" "));
  ok(/desc = "desc_t\[31:0\]";[\s\S]*?\} desc_0 @ 0x0;/.test(rdl),
     "and offset 0 holds the least significant bits");
  ok(/desc = "desc_t\[63:32\]";[\s\S]*?\} desc_1 @ 0x4;/.test(rdl),
     "with the top of the struct at the higher address");
  ok(rdl.indexOf("addr_7_0") < rdl.indexOf("addr_31_8"),
     "so the low part of a split field comes first");
  ok(/desc = "desc_t\[31:0\]";[\s\S]*?addr_7_0[\s\S]*?\} desc_0/.test(rdl),
     "in the register at offset 0");
  ok(/field \{ desc = "ctrl.cmd"; +\} ctrl_cmd +\[31:30\];/.test(rdl),
     "a whole field keeps its name and lands at the top of the word",
     (rdl.match(/.*ctrl_cmd.*/)||[])[0]);
  ok(/field \{ desc = "addr\[31:8\]"; +\} addr_31_8 +\[23: 0\];/.test(rdl) &&
     /field \{ desc = "addr\[7:0\]"; +\} addr_7_0 +\[31:24\];/.test(rdl),
     "the straddling field is split and named after its own bits",
     (rdl.match(/.*addr_.*/g)||[]).join(" | "));
  ok(!/pad/.test(rdl.replace(/^\/\/.*$/gm,"").replace(/_pad/g,"")),
     "no reserved bits are declared");
  ok(/^};$/m.test(rdl), "the addrmap closes");

  console.log("== the register width control");
  regwBtn("16").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  rdl = $("pane-rdl").textContent;
  ok(regwBtn("16").getAttribute("aria-pressed") === "true" &&
     regwBtn("32").getAttribute("aria-pressed") === "false", "the press moves");
  ok(/default regwidth = 16;/.test(rdl), "16-bit registers");
  ok((rdl.match(/^ {4}reg \{$/gm)||[]).length === 4, "64 bits needs four of them",
     (rdl.match(/^ {4}reg \{$/gm)||[]).length);
  ok(/\} desc_3 @ 0x6;/.test(rdl), "addresses stride by 2",
     (rdl.match(/\} desc_\d @ .*/g)||[]).join(" "));
  ok(/desc = "desc_t\[15:0\]";[\s\S]*?\} desc_0 @ 0x0;/.test(rdl),
     "16-bit registers start at the bottom too",
     (rdl.match(/desc = "desc_t\[[\d:]+\]"/g)||[]).join(" "));
  ok(/addr_31_24|addr_23_8|addr_7_0/.test(rdl), "addr splits three ways",
     (rdl.match(/addr_\d+_\d+/g)||[]).join(" "));

  regwBtn("8").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  rdl = $("pane-rdl").textContent;
  ok(/default regwidth = 8;/.test(rdl) && (rdl.match(/^ {4}reg \{$/gm)||[]).length === 8,
     "eight byte registers", (rdl.match(/^ {4}reg \{$/gm)||[]).length);
  ok((rdl.match(/\[ *\d+: *\d+\];/g)||[]).every(s => +/\[ *(\d+)/.exec(s)[1] <= 7),
     "no field reaches past the register width");
  regwBtn("64").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  rdl = $("pane-rdl").textContent;
  ok((rdl.match(/^ {4}reg \{$/gm)||[]).length === 1, "one 64-bit register holds it all");
  ok(!/addr_\d+_\d+/.test(rdl) && /\} addr +\[55:24\];/.test(rdl),
     "and nothing needs splitting", (rdl.match(/.*addr.*/)||[])[0]);
  regwBtn("32").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));

  console.log("== RDL and the other switches");
  ok(/ctrl__rsvd/.test($("pane-rdl").textContent), "underscore fields are mapped by default");
  $("us").checked = false; fire($("us"),"change");
  rdl = $("pane-rdl").textContent;
  ok(!/ctrl__rsvd/.test(rdl) && !/_pad/.test(rdl), "held back fields get no register field");
  ok((rdl.match(/^ {4}reg \{$/gm)||[]).length === 2, "the registers stay put");
  $("us").checked = true; fire($("us"),"change");

  $("flat").checked = false; fire($("flat"),"change");
  ok(/desc = "ctrl";/.test($("pane-rdl").textContent), "collapsed nesting maps one field",
     ($("pane-rdl").textContent.match(/.*"ctrl".*/)||[])[0]);
  $("flat").checked = true; fire($("flat"),"change");

  console.log("== collapsed nesting keeps the nested type");
  preset("descriptor");
  $("flat").checked = false; fire($("flat"),"change");
  const nc = () => $("pane-c").textContent, np = () => $("pane-py").textContent,
        nr = () => $("pane-rdl").textContent;
  ok(/^typedef struct \{$[\s\S]*?^\} ctrl_t;$/m.test(nc()), "C defines ctrl_t");
  ok(nc().indexOf("} ctrl_t;") < nc().indexOf("} desc_t;"), "before the type that uses it");
  ok(/static uint8_t ctrl_pack\(const ctrl_t \*f\)/.test(nc()), "with its own pack");
  ok(/ {4}ctrl_t {3}ctrl; +\/\* \[63:56\] +8 bits +ctrl_t/.test(nc()),
     "and the outer struct holds one", (nc().match(/.*ctrl_t +ctrl;.*/)||[])[0]);
  ok(/\(uint64_t\)ctrl_pack\(&f->ctrl\) +<< 56\)/.test(nc()), "outer pack calls it",
     (nc().match(/.*ctrl_pack.*<<.*/)||[])[0]);
  ok(/ctrl_unpack\(\(uint8_t\)\(word >> 56\), &f->ctrl\);/.test(nc()), "outer unpack too",
     (nc().match(/.*ctrl_unpack\(.*/g)||[]).slice(-1)[0]);
  ok(/\[7:6\]/.test(nc()) && /\[4:0\]/.test(nc()),
     "the nested bits start again from its own zero");

  ok(/from dataclasses import dataclass, field/.test(np()), "python imports field");
  ok(/^class Ctrl:$/m.test(np()) && np().indexOf("class Ctrl:") < np().indexOf("class Desc:"),
     "Ctrl comes before Desc");
  ok(/ctrl: Ctrl = field\(default_factory=Ctrl\)/.test(np()), "held by a factory default",
     (np().match(/.*default_factory.*/)||[])[0]);
  ok(/ctrl=Ctrl\.unpack\(\(word >> 56\) & 0xFF\),/.test(np()), "python unpack recurses",
     (np().match(/.*Ctrl\.unpack.*/)||[])[0]);
  ok(/\(self\.ctrl\.pack\(\) << 56\)/.test(np()), "python pack recurses",
     (np().match(/.*ctrl\.pack.*/)||[])[0]);

  ok(/^reg ctrl_layout \{$/m.test(nr()), "RDL describes the nested type as a reg component");
  ok(/ {4}regwidth = 8;/.test(nr()), "sized to the nested type",
     (nr().match(/.*regwidth = 8.*/)||[])[0]);
  ok(/field \{ desc = "cmd"; +\} cmd +\[7:6\];/.test(nr()), "with the inside bit numbers",
     (nr().match(/.*\} cmd .*/)||[])[0]);
  ok(nr().indexOf("reg ctrl_layout") < nr().indexOf("addrmap desc"), "before the addrmap");
  ok(/\} ctrl +\[31:24\]; +\/\/ ctrl_t, see ctrl_layout/.test(nr()),
     "and the carrying field points at it", (nr().match(/.*see ctrl_layout.*/)||[])[0]);

  $("flat").checked = true; fire($("flat"),"change");
  ok(!/ctrl_pack/.test(nc()) && !/class Ctrl/.test(np()) && !/ctrl_layout/.test(nr()),
     "flattening again drops the nested types");
  ok(/f->ctrl_cmd/.test(nc()), "and goes back to one flat struct");

  console.log("== two levels deep");
  $("src").value = "typedef struct packed { logic [3:0] lo; logic [3:0] hi; } pair_t; " +
                   "typedef struct packed { pair_t inner; logic [7:0] mid; } mid_t; " +
                   "typedef struct packed { mid_t deep; logic [15:0] top; } outer_t;";
  fire($("src"),"input");
  $("flat").checked = false; fire($("flat"),"change");
  ok(nc().indexOf("} pair_t;") < nc().indexOf("} mid_t;") &&
     nc().indexOf("} mid_t;") < nc().indexOf("} outer_t;"),
     "C defines the deepest type first");
  ok(/ {4}pair_t +inner;/.test(nc()) && / {4}mid_t +deep;/.test(nc()),
     "each level holds the one below");
  ok((np().match(/^@dataclass$/gm)||[]).length === 3, "three dataclasses",
     (np().match(/^@dataclass$/gm)||[]).length);
  ok((nr().match(/^reg \w+_layout \{$/gm)||[]).length === 2, "two reg components",
     (nr().match(/^reg \w+_layout \{$/gm)||[]).join(" "));
  ok(/\} inner +\[15: 8\]; +\/\/ pair_t, see pair_layout/.test(nr()),
     "the inner pointer sits inside the outer component",
     (nr().match(/.*see pair_layout.*/)||[])[0]);
  $("flat").checked = true; fire($("flat"),"change");
  preset("descriptor");

  preset("union");
  rdl = $("pane-rdl").textContent;
  ok((rdl.match(/^addrmap \w+ \{$/gm)||[]).length === 3, "a union maps each member",
     (rdl.match(/^addrmap \w+ \{$/gm)||[]).join(" "));
  ok(/overlay the same bits/.test(rdl), "with a note that they overlay");

  preset("byte aligned");
  unitBtn("32").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  justBtn("lsb").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  rdl = $("pane-rdl").textContent;
  ok((rdl.match(/^ {4}reg \{$/gm)||[]).length === 4 && !/_\d+_\d+ /.test(rdl),
     "32-bit words in 32-bit registers give one whole field each",
     (rdl.match(/^ {4}reg \{$/gm)||[]).length);
  ok(/\} mode +\[ 2: 0\];/.test(rdl) && /\} tag +\[15: 0\];/.test(rdl),
     "each sitting at the bottom of its own register",
     (rdl.match(/.*\} (mode|tag) .*/g)||[]).join(" | "));
  unitBtn("8").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  justBtn("msb").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));

  console.log("== arrow keys still walk the tabs");
  $("tab-rdl").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  $("tabs").dispatchEvent(new w.KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));
  ok($("tab-fields").getAttribute("aria-selected") === "true", "right wraps past the new tab");
  $("tabs").dispatchEvent(new w.KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}));
  ok($("tab-rdl").getAttribute("aria-selected") === "true", "left comes back to it");

  copied = null;
  $("copybtn").dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  await sleep(20);
  ok(copied === $("pane-rdl").textContent, "the copy button hands over the RDL",
     copied === null ? "nothing copied" : "len " + copied.length);

  console.log(fails ? "\n" + fails + " FAILURES" : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})();
