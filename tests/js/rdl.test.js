/* The SystemRDL visualizer, driven in jsdom: the layout it draws for a register
   map, the values it puts in the fields and in the vector, and the readings it
   gives them under each type. No layout, so nothing here needs real geometry.

   The page opens on a fixed pattern, 0x0123456789ABCDEF repeated up the vector,
   which is what the expected values below are worked out from. */
const {JSDOM, VirtualConsole} = require("jsdom");
const {inlineRdlPage, reporter} = require("./support/harness");

const html = inlineRdlPage();
const report = reporter("rdl visualizer");
const ok = report.ok;
const sleep = ms => new Promise(r => setTimeout(r,ms));

(async () => {
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => report.fail("the page ran without error", e.stack||e.message));
  vc.on("error", (...a) => report.fail("the page logged nothing", a.join(" ")));

  const dom = new JSDOM(html, {
    runScripts:"dangerously", pretendToBeVisual:true, virtualConsole:vc
  });
  await sleep(300);
  const w = dom.window, d = w.document;
  const $ = id => d.getElementById(id);
  const q = s => Array.from(d.querySelectorAll(s));
  const txt = s => q(s).map(e => e.textContent.trim());
  const fire = (el,type) => el.dispatchEvent(new w.Event(type,{bubbles:true}));
  const click = el => el.dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
  const hover = el => el.dispatchEvent(new w.MouseEvent("mouseover",{bubbles:true}));
  const press = (seg,v) => click($(seg).querySelector('[data-v="'+v+'"]'));
  const preset = name => click(q("#presets button").filter(b => b.textContent === name)[0]);

  // one row of a field table, as its cells read
  const cells = (body,i) => Array.from(q("#"+body+" tr")[i].children)
    .map(td => (td.querySelector("input") || td).value || td.textContent.trim());
  const field = name => q("#vtbody tr").filter(tr => tr.children[0].textContent.trim() === name)[0];
  const spans = () => q("#vtbody tr").map(tr => tr.children[1].textContent.trim()).join(" ");
  const value = name => field(name).querySelector("input");
  const typeIn = (inp,text) => { inp.value = text; fire(inp,"input"); };

  /* One row of the type table: its controls, and the value in each form. The
     vector's row is the one in the foot. */
  const named = (rows,name) => rows.filter(tr => tr.children[0].textContent.trim() === name)[0];
  const typed = name => {
    const tr = name === null ? d.querySelector("#tfoot tr") : named(q("#ttbody tr"), name);
    return {
      type: tr.children[3].querySelector("select"),
      sign: tr.children[4].querySelector("input"),
      q:    tr.children[5].querySelector("input"),
      val:  tr.children[6].querySelector("input"),
      hex:  tr.children[7].querySelector("input")
    };
  };
  const reads = name => {
    const row = typed(name);
    return [row.type.value, row.sign.checked ? "signed" : "unsigned",
            row.q.value || "-", row.val.value].join(" | ");
  };
  const options = name =>
    Array.from(typed(name).type.options).map(o => o.textContent).join(" | ");
  const readAs = (name,kind) => {
    const sel = typed(name).type;
    sel.value = kind;
    fire(sel,"change");
  };
  const setSign = (name,on) => {
    const box = typed(name).sign;
    box.checked = on;
    fire(box,"change");
  };
  const picker = () => Array.from($("root").options).map(o => o.textContent).join(" | ");
  const pick = name => { $("root").value = name; fire($("root"),"change"); };

  report.section("the default map, fir_ctrl");
  ok($("stampname").textContent === "fir_ctrl", "stamp names the addrmap", $("stampname").textContent);
  ok($("stampw").textContent === "64 bits", "two 32-bit registers", $("stampw").textContent);
  ok($("root").value === "fir_ctrl" && $("stampkind").textContent === "map",
     "the map is what it opens on", $("root").value);
  ok(picker() === "fir_ctrl  (addrmap) | control  (reg @ 0x0) | coeff  (reg @ 0x4)",
     "with its two registers on offer beside it, each at its address", picker());
  ok(q(".drow").length === 2, "one row per register", q(".drow").length);
  ok(txt(".rlab").join(" | ") === "63:32 | 31:0", "row labels", txt(".rlab").join(" | "));
  ok(q(".ticks i").length === 64 && q(".ticks i.b").length === 8, "a tick a bit, longer on the byte",
     q(".ticks i").length + " / " + q(".ticks i.b").length);
  ok($("notes").children.length === 0, "nothing to report", $("notes").textContent);
  ok(!$("rsvd").checked, "the reserved switch starts off");

  const segs = () => q(".fseg").map(e => ({
    ix:Array.from(e.querySelectorAll(".ixs i")).map(i=>i.textContent).join(":"),
    nm:e.querySelector(".nm").textContent,
    vl:e.querySelector(".vl").textContent,
    cls:e.className
  }));
  const drawn = segs();
  console.log(drawn.map(s => "    " + s.ix.padEnd(8) + s.nm.padEnd(10) + s.vl.padEnd(12) + s.cls).join("\n"));
  ok(drawn.length === 10, "ten blocks: seven fields and three reserved runs", drawn.length);
  ok(drawn.map(s => s.ix).join(" ") === "63:48 47:32 31:28 27:20 19:16 15:12 11:4 3 2 1:0",
     "offset 0 is at the bottom, so tap1 is at the top", drawn.map(s => s.ix).join(" "));
  ok(drawn.map(s => s.nm || "-").join(" ") ===
     "tap1 tap0 revision - channel - taps - enable mode",
     "each field is named, and the reserved runs are left unnamed",
     drawn.map(s => s.nm || "-").join(" "));
  ok(drawn.filter(s => /rsvd/.test(s.cls)).length === 3, "reserved runs are drawn grey",
     drawn.filter(s => /rsvd/.test(s.cls)).map(s => s.nm).join(" "));
  ok(new Set(drawn.filter(s => /c\d/.test(s.cls)).map(s => (s.cls.match(/c\d/)||[])[0])).size === 7,
     "seven distinct colours");
  ok(drawn.filter(s => /\bone\b/.test(s.cls)).length === 2, "a single-bit block is marked as one",
     drawn.filter(s => /\bone\b/.test(s.cls)).map(s => s.nm).join(" "));
  ok($("dmeta").textContent.includes("64 bits") && $("dmeta").textContent.includes("8 bytes") &&
     $("dmeta").textContent.includes("7 fields") && $("dmeta").textContent.includes("13 reserved bits") &&
     $("dmeta").textContent.includes("words of 32"), "the summary line", $("dmeta").textContent);

  report.section("the vector opens on a pattern");
  ok($("v-hex").textContent === "0x0123456789ABCDEF", "hex", $("v-hex").textContent);
  ok($("v-dec").textContent === "81985529216486895", "decimal", $("v-dec").textContent);
  ok($("wordin").value === "0x0123456789ABCDEF", "and the box holds it too", $("wordin").value);
  ok($("v-bin").textContent.split(" ").length === 16 &&
     $("v-bin").textContent.startsWith("0000 0001 0010 0011"),
     "binary, in nibbles", $("v-bin").textContent.slice(0,24));
  ok(txt(".rval").join(" | ") === "0x01234567 | 0x89ABCDEF", "each row carries its own word",
     txt(".rval").join(" | "));
  ok(drawn.map(s => s.vl).join(" ") ===
     "0x0123 0x4567 0x8 0x9A 0xB 0xC 0xDE 0x1 0x1 0x3",
     "and each field the bits it owns", drawn.map(s => s.vl).join(" "));

  report.section("the field table");
  ok(q("#vtbody tr").length === 7, "a row per field", q("#vtbody tr").length);
  ok(cells("vtbody",0).join(" | ") === "tap1 | [63:48] | 16 | 0x0123 | 291",
     "hex to type in, decimal to read", cells("vtbody",0).join(" | "));
  ok(cells("vtbody",6).join(" | ") === "mode | [1:0] | 2 | 0x3 | 3", "down to the last field",
     cells("vtbody",6).join(" | "));
  ok(q("#vtbody tr.dim").length === 0, "and nothing dimmed, since no run is listed",
     q("#vtbody tr.dim").length);
  ok(q("#vtbody tr")[0].dataset.seg === q(".fseg")[0].dataset.seg,
     "a row and its block share a key");

  report.section("typing into a field");
  value("mode").focus();
  typeIn(value("mode"), "0b10");
  ok($("v-hex").textContent === "0x0123456789ABCDEE", "binary in, the vector follows",
     $("v-hex").textContent);
  ok(value("mode").value === "0b10", "the box keeps what was typed while it is being typed in",
     value("mode").value);
  value("mode").blur();
  ok(value("mode").value === "0x2", "leaving it puts the value back in hex", value("mode").value);
  typeIn(value("taps"), "255");
  ok($("v-hex").textContent === "0x0123456789ABCFFE", "decimal in", $("v-hex").textContent);
  ok(value("channel").value === "0xB" && $("v-dec").textContent === "81985529216487422",
     "and no other field moved", value("channel").value);
  typeIn(value("taps"), "0x1FF");
  ok($("v-hex").textContent === "0x0123456789ABCFFE",
     "a value too wide is masked to the bits it has", $("v-hex").textContent);
  typeIn(value("taps"), "0");
  ok($("v-hex").textContent === "0x0123456789ABC00E", "a field can be cleared on its own",
     $("v-hex").textContent);
  typeIn(value("taps"), "-1");
  ok($("v-hex").textContent === "0x0123456789ABCFFE",
     "and a negative decimal reads as two's complement", $("v-hex").textContent);
  value("taps").focus();
  typeIn(value("taps"), "nonsense");
  ok(value("taps").classList.contains("bad"), "what it cannot read is flagged");
  ok($("v-hex").textContent === "0x0123456789ABCFFE", "and the vector is left alone",
     $("v-hex").textContent);
  value("taps").blur();
  ok(!value("taps").classList.contains("bad") && value("taps").value === "0xFF",
     "leaving the box clears the flag", value("taps").value);

  report.section("typing into the vector");
  typeIn($("wordin"), "0xDEADBEEF0000000F");
  ok(value("tap1").value === "0xDEAD" && value("tap0").value === "0xBEEF",
     "the top register", value("tap1").value + " " + value("tap0").value);
  ok(value("mode").value === "0x3" && value("enable").value === "0x1" &&
     value("taps").value === "0x00" && value("revision").value === "0x0",
     "and the bottom one", value("mode").value + " " + value("taps").value);
  ok(txt(".rval").join(" | ") === "0xDEADBEEF | 0x0000000F", "the rows agree",
     txt(".rval").join(" | "));

  report.section("filling the whole vector");
  press("fill","zeros");
  ok($("v-hex").textContent === "0x0000000000000000" && $("v-dec").textContent === "0",
     "zeros", $("v-hex").textContent);
  ok(txt(".fseg .vl").every(t => /^0x0+$/.test(t)), "every field with it",
     txt(".fseg .vl").join(" "));
  press("fill","ones");
  ok($("v-hex").textContent === "0xFFFFFFFFFFFFFFFF", "ones", $("v-hex").textContent);
  ok(value("enable").value === "0x1" && value("tap1").value === "0xFFFF", "and the fields with it",
     value("tap1").value);
  press("fill","random");
  ok(/^0x[0-9A-F]{16}$/.test($("v-hex").textContent), "random stays inside the vector",
     $("v-hex").textContent);

  report.section("a type for each field");
  typeIn($("wordin"), "0x0123456789ABCDEF");
  ok(q("#ttbody tr").length === 7 && !!d.querySelector("#tfoot tr"),
     "a row per field, and one for the vector", q("#ttbody tr").length);
  ok(typed("revision").type.value === "int" && typed("revision").sign.checked,
     "a field with nothing said about it opens as a signed integer", reads("revision"));
  ok(typed("revision").q.disabled && typed("revision").q.value === "",
     "with no Q format until one is wanted", reads("revision"));
  ok(txt("#tpanel thead th").join(" | ") ===
     "Field | Bits | Width | Read as | Signed | Q format | Value | Hex",
     "the sign column is the only label the checkbox has",
     txt("#tpanel thead th").join(" | "));
  ok(reads("revision") === "int | signed | - | -8", "a top bit set makes it negative",
     reads("revision"));
  ok(reads(null) === "int | signed | - | 81985529216486895",
     "and the vector is one wide integer", reads(null));
  setSign("revision", false);
  ok(reads("revision") === "int | unsigned | - | 8", "unsigned reads the bits as they are",
     reads("revision"));
  ok(reads("enable") === "int | signed | - | -1", "one field at a time, not all of them",
     reads("enable"));
  setSign("revision", true);

  report.section("fixed point, per field");
  readAs("mode","fix");
  ok(!typed("mode").q.disabled, "the Q format box wakes up for that field alone");
  ok(typed("revision").q.disabled, "and only for that one");
  ok(reads("mode") === "fix | signed | Q0.1 | -0.5",
     "it opens on all the fraction bits the field has", reads("mode"));
  readAs("mode","int");
  readAs("tap1","fix");
  typeIn(typed("tap1").q, "Q0.15");
  ok(reads("tap1") === "fix | signed | Q0.15 | 0.008880615234375",
     "the whole 16 bits as a fraction", reads("tap1"));
  typeIn(typed("tap1").q, "Q1.14");
  ok(reads("tap1") === "fix | signed | Q1.14 | 0.01776123046875",
     "moving the point moves the value", reads("tap1"));
  setSign("tap1", false);
  ok(reads("tap1") === "fix | unsigned | Q2.14 | 0.01776123046875",
     "dropping the sign bit spends it on m, keeping n", reads("tap1"));
  setSign("tap1", true);
  typeIn(typed("tap1").q, "Q7.7");
  ok(typed("tap1").q.classList.contains("bad"),
     "a format whose bits do not add up to the field is marked");
  ok(reads("tap1") === "fix | signed | Q7.7 | 2.2734375",
     "and the value is still read with the n it asked for", reads("tap1"));
  typeIn(typed("tap1").q, "nonsense");
  ok(typed("tap1").q.classList.contains("bad") && reads("tap1").includes("2.2734375"),
     "one it cannot read at all changes nothing", reads("tap1"));
  typeIn(typed("tap1").q, "Q1.14");
  ok(!typed("tap1").q.classList.contains("bad"), "and a good one clears the mark");

  report.section("typing a value in the type it is read as");
  typeIn(typed("tap1").val, "-0.5");
  ok(typed("tap1").hex.value === "0xE000" && value("tap1").value === "0xE000",
     "a fixed point value lands in the bits, in both tables",
     typed("tap1").hex.value + " " + value("tap1").value);
  typeIn(typed("tap1").val, "0.25");
  ok(typed("tap1").hex.value === "0x1000" && $("v-hex").textContent.startsWith("0x1000"),
     "and in the vector", $("v-hex").textContent);
  typeIn(typed("tap1").val, "1.9999");
  ok(typed("tap1").hex.value === "0x7FFE",
     "a value past the top of the field saturates rather than wrapping",
     typed("tap1").hex.value);
  typeIn(typed("tap1").val, "-99");
  ok(typed("tap1").hex.value === "0x8000", "and past the bottom too", typed("tap1").hex.value);
  typeIn(typed("tap1").val, "what");
  ok(typed("tap1").val.classList.contains("bad") && typed("tap1").hex.value === "0x8000",
     "what it cannot read is flagged and changes nothing", typed("tap1").hex.value);
  typeIn(typed("revision").val, "-8");
  ok(typed("revision").hex.value === "0x8", "an integer box takes a whole number",
     typed("revision").hex.value);
  typeIn(typed("revision").val, "1.5");
  ok(typed("revision").val.classList.contains("bad") && typed("revision").hex.value === "0x8",
     "but not a fraction", typed("revision").hex.value);
  typeIn(typed("revision").hex, "0x7");
  ok(typed("revision").val.value === "7" && value("revision").value === "0x7",
     "and the hex box beside it works the other way",
     typed("revision").val.value + " " + value("revision").value);
  readAs("tap1","int");

  report.section("the float formats a width is offered");
  ok(options("taps") === "integer | fixed point | fp8 E4M3 | fp8 E5M2",
     "an 8-bit field is offered the two eight-bit floats", options("taps"));
  ok(options("tap1") === "integer | fixed point | binary16 | bf16",
     "a 16-bit one is offered both formats that wide", options("tap1"));
  ok(options(null) === "integer | fixed point | binary64",
     "and the 64-bit vector the one", options(null));
  readAs("tap1","binary16");
  ok(typed("tap1").sign.disabled && typed("tap1").q.disabled,
     "a float carries its own sign and its own point");
  typeIn(typed("tap1").hex, "0x3C00");
  ok(typed("tap1").val.value === "1", "0x3C00 is one in binary16", typed("tap1").val.value);
  typeIn(typed("tap1").val, "-1.5");
  ok(typed("tap1").hex.value === "0xBE00", "and minus one and a half goes back",
     typed("tap1").hex.value);
  typeIn(typed("tap1").val, "0.1");
  ok(typed("tap1").hex.value === "0x2E66" && typed("tap1").val.value === "0.0999755859375",
     "a tenth rounds to the nearest half and reads back exactly",
     typed("tap1").hex.value + " " + typed("tap1").val.value);
  readAs("tap1","bf16");
  ok(typed("tap1").val.value === "5.2295945351943374e-11",
     "the same bits read as a bf16 are a different number altogether",
     typed("tap1").val.value);
  typeIn(typed("tap1").val, "0.1");
  ok(typed("tap1").hex.value === "0x3DCD" && typed("tap1").val.value === "0.10009765625",
     "which takes a tenth to a word of its own, exactly readable",
     typed("tap1").hex.value + " " + typed("tap1").val.value);
  readAs(null,"binary64");
  typeIn(typed(null).val, "-3.5");
  ok($("v-hex").textContent === "0xC00C000000000000", "the vector takes a double",
     $("v-hex").textContent);
  typeIn($("wordin"), "0x3FF0000000000000");
  ok(typed(null).val.value === "1", "and reads one back", typed(null).val.value);
  typeIn($("wordin"), "0xC00921FB54442D18");
  ok(typed(null).val.value === "-3.1415926535897931",
     "a value too long to write out is printed to what pins a double down",
     typed(null).val.value);
  typeIn(typed(null).val, "-3.1415926535897931");
  ok($("v-hex").textContent === "0xC00921FB54442D18", "which types back to the same bits",
     $("v-hex").textContent);
  typeIn($("wordin"), "0x7FF0000000000000");
  ok(typed(null).val.value === "inf", "infinity", typed(null).val.value);
  typeIn(typed(null).val, "-inf");
  ok($("v-hex").textContent === "0xFFF0000000000000", "which can be typed in as well",
     $("v-hex").textContent);
  typeIn(typed(null).val, "nan");
  ok(typed(null).val.value === "NaN" && $("v-hex").textContent === "0x7FF8000000000000",
     "and so can not a number", $("v-hex").textContent);
  typeIn($("wordin"), "0x8000000000000000");
  ok(typed(null).val.value === "-0", "minus zero keeps its sign", typed(null).val.value);
  typeIn($("wordin"), "0x0000000000000001");
  ok(typed(null).val.value === "4.9406564584124654e-324",
     "the smallest subnormal there is", typed(null).val.value);
  typeIn(typed(null).val, "4.9406564584124654e-324");
  ok($("v-hex").textContent === "0x0000000000000001", "and it too types back",
     $("v-hex").textContent);
  readAs(null,"int");

  report.section("a comment after a field says how to read it");
  preset("ieee 754");
  ok($("stampname").textContent === "dac_cal" && $("stampw").textContent === "64 bits",
     "the example loads", $("stampname").textContent);
  ok(reads("gain").startsWith("binary32 |"),
     "'float' on a 32-bit field takes the IEEE format that fits it", reads("gain"));
  ok(reads("offset_b").startsWith("bf16 |") && reads("offset_a").startsWith("binary16 |"),
     "and a name settles which of two the same width",
     reads("offset_b") + " / " + reads("offset_a"));
  ok(typed("gain").type.title === "the source says float", "the row says where that came from",
     typed("gain").type.title);
  typeIn(value("gain"), "0x3F800000");
  ok(typed("gain").val.value === "1", "a single precision one", typed("gain").val.value);
  typeIn(value("offset_a"), "0x3C00");
  typeIn(value("offset_b"), "0x3F80");
  ok(typed("offset_a").val.value === "1" && typed("offset_b").val.value === "1",
     "one in each of the two 16-bit formats, at different words",
     typed("offset_a").val.value + " / " + typed("offset_b").val.value);

  preset("fp8 and fp4");
  ok($("stampname").textContent === "tensor_cfg" && $("stampw").textContent === "64 bits",
     "the narrow formats example loads", $("stampname").textContent);
  ok(reads("wt3").startsWith("e4m3 |") && reads("wt2").startsWith("e4m3 |") &&
     reads("wt1").startsWith("e2m1 |") && reads("wt0").startsWith("e3m0 |"),
     "FP8 and FP4, each named in its own comment",
     ["wt3","wt2","wt1","wt0"].map(reads).join(" / "));
  ok(reads("scale").startsWith("bf16 |") && reads("exponent").startsWith("e5m2 |"),
     "beside a bf16 and an E5M2", reads("scale") + " / " + reads("exponent"));
  ok(reads("zero_pt").startsWith("int | signed") && reads("mode").startsWith("int | unsigned"),
     "and the two the comments call signed and unsigned",
     reads("zero_pt") + " / " + reads("mode"));
  ok(options("wt1") === "integer | fixed point | fp4 E2M1 | fp4 E3M0",
     "a 4-bit field is offered both four-bit formats", options("wt1"));
  ok(options("wt3") === "integer | fixed point | fp8 E4M3 | fp8 E5M2",
     "and an 8-bit field both eight-bit ones", options("wt3"));

  report.section("the narrow formats convert through the page");
  [["wt3","0x38","1"], ["wt3","0x7E","448"], ["wt3","0x7F","NaN"], ["wt3","0x78","256"],
   ["wt2","0x01","0.001953125"], ["exponent","0x3C","1"], ["exponent","0x7C","inf"],
   ["exponent","0x7B","57344"], ["wt1","0x7","6"], ["wt1","0x1","0.5"],
   ["wt0","0x7","16"], ["wt0","0x1","0.25"], ["scale","0x3F80","1"], ["scale","0x7F80","inf"]
  ].forEach(([name,bits,want]) => {
    typeIn(value(name), bits);
    ok(typed(name).val.value === want, name + " at " + bits + " reads " + want,
       typed(name).val.value);
  });
  [["wt3","1000","0x7E"], ["wt3","-1000","0xFE"], ["wt1","100","0x7"], ["wt0","100","0x7"],
   ["exponent","1e6","0x7C"], ["scale","1e39","0x7F80"], ["wt2","0.001","0x01"]
  ].forEach(([name,text,want]) => {
    typeIn(typed(name).val, text);
    ok(value(name).value === want, name + " takes " + text + " as " + want,
       value(name).value);
  });
  typeIn(typed("wt1").val, "nan");
  ok(typed("wt1").val.classList.contains("bad"),
     "a format with no NaN will not take one");
  typeIn(typed("wt3").val, "inf");
  ok(typed("wt3").val.classList.contains("bad"),
     "nor E4M3 an infinity, which it has not got either");

  report.section("a Q format in a comment");
  preset("q1.14 taps");
  ok(reads("pair_0_odd").startsWith("fix | signed | Q1.14"), "Q1.14 is signed",
     reads("pair_0_odd"));
  ok(reads("pair_0_even").startsWith("fix | unsigned | Q2.14"),
     "and UQ2.14 spends the sign bit on m instead", reads("pair_0_even"));
  ok(!typed("pair_0_odd").q.classList.contains("bad") &&
     !typed("pair_0_even").q.classList.contains("bad"), "both add up to the field");
  typeIn(value("pair_0_odd"), "0x4000");
  ok(typed("pair_0_odd").val.value === "1", "0x4000 is one in Q1.14",
     typed("pair_0_odd").val.value);
  typeIn(value("pair_0_even"), "0x4000");
  ok(typed("pair_0_even").val.value === "1", "as it is in UQ2.14",
     typed("pair_0_even").val.value);
  typeIn(value("pair_0_even"), "0xC000");
  ok(typed("pair_0_even").val.value === "3", "which has no sign bit to read it as -1",
     typed("pair_0_even").val.value);
  ok(reads("pair_1_odd").startsWith("fix | signed | Q1.14"),
     "every copy of an array takes the comment", reads("pair_1_odd"));

  report.section("a comment that says nothing, and one that does not fit");
  preset("fir control");
  ok(reads("tap0").startsWith("fix | signed | Q1.14") &&
     reads("taps").startsWith("int | unsigned"),
     "the default map reads its own comments", reads("tap0") + " / " + reads("taps"));
  ok(typed("enable").type.title === "" && reads("enable").startsWith("int | signed"),
     "a field with no comment is left alone", typed("enable").type.title);
  $("src").value = "addrmap says {\n  default regwidth = 32;\n  reg {\n" +
    '    field {} a [31:16];   // how many beats it takes\n' +
    '    field {} b [15: 8];   // BF16\n' +
    '    field {} c [ 7: 0];   /* Q2.5 */\n' +
    "  } r0 @ 0x0;\n};";
  fire($("src"),"input");
  ok(reads("a").startsWith("int | signed"), "prose beside a field is not read as a type",
     reads("a"));
  ok(reads("b").startsWith("int | signed"), "nor is a format too wide for the field",
     reads("b"));
  ok($("notes").textContent.includes("b is 8 bits, so the bf16"),
     "which is said out loud rather than passed over", $("notes").textContent);
  ok(reads("c").startsWith("fix | signed | Q2.5"), "a block comment carries a type too",
     reads("c"));

  report.section("what a field is read as survives a re-render");
  preset("ieee 754");
  readAs("gain","fix");
  typeIn(typed("gain").q, "Q7.24");
  $("rsvd").checked = true; fire($("rsvd"),"change");
  $("rsvd").checked = false; fire($("rsvd"),"change");
  ok(reads("gain").startsWith("fix | signed | Q7.24"),
     "hiding the reserved runs and bringing them back keeps a hand-made choice",
     reads("gain"));
  ok(typed("offset_a").type.value === "binary16", "and keeps the others too",
     reads("offset_a"));

  report.section("reserved fields");
  preset("fir control");
  ok(!$("rsvd").checked, "the switch is off, as it is when the page opens");
  ok(q("#vtbody tr").length === 7 && q("#ttbody tr").length === 7,
     "so neither table lists the reserved runs", q("#vtbody tr").length);
  ok(q(".fseg").length === 10 && q(".fseg.rsvd").length === 3,
     "though their bits are still drawn, three blocks of them",
     q(".fseg").length + " / " + q(".fseg.rsvd").length);
  ok(txt(".fseg.rsvd .nm").every(t => t === ""), "unnamed", txt(".fseg.rsvd .nm").join("|"));
  ok(txt(".fseg.rsvd .vl").join(" ") === "0x9A 0xC 0x1", "still showing what they hold",
     txt(".fseg.rsvd .vl").join(" "));
  ok($("v-hex").textContent === "0x0123456789ABCDEF", "and covered by the vector value",
     $("v-hex").textContent);
  $("rsvd").checked = true; fire($("rsvd"),"change");
  ok(q("#vtbody tr").length === 10 && q("#ttbody tr").length === 10,
     "switching it on lists them", q("#vtbody tr").length);
  ok(txt(".fseg.rsvd .nm").join(" ") === "_rsvd0 _rsvd1 _rsvd2",
     "and names them in the diagram", txt(".fseg.rsvd .nm").join(" "));
  ok(q("#vtbody tr.dim").length === 3 && q("#ttbody tr.dim").length === 3,
     "dimmed apart from the fields", q("#vtbody tr.dim").length);
  ok(!!field("_rsvd0") && value("_rsvd0").value === "0x9A",
     "with a value box of their own", field("_rsvd0") ? value("_rsvd0").value : "no row");
  $("rsvd").checked = false; fire($("rsvd"),"change");
  ok(q("#vtbody tr").length === 7, "and off again drops them", q("#vtbody tr").length);

  report.section("how wide a word is drawn");
  press("wbits","64");
  ok(q(".drow").length === 1 && txt(".rlab")[0] === "63:0", "one row of 64",
     txt(".rlab").join(" | "));
  ok(txt(".rval").join(" | ") === "0x0123456789ABCDEF", "carrying the whole vector",
     txt(".rval").join(" | "));
  ok(q(".fseg").length === 10, "no field is split now", q(".fseg").length);
  ok($("dmeta").textContent.includes("words of 64"), "the summary follows", $("dmeta").textContent);
  press("wbits","8");
  ok(q(".drow").length === 8 && q(".fseg").length === 14,
     "bytes split the wider fields", q(".drow").length + " rows, " + q(".fseg").length + " blocks");
  ok(txt(".rval").join(" ") === "0x01 0x23 0x45 0x67 0x89 0xAB 0xCD 0xEF", "a byte a row",
     txt(".rval").join(" "));
  ok(q(".fseg.cl").length === 4 && q(".fseg.cr").length === 4,
     "and the four fields wider than a byte are marked where they continue",
     q(".fseg.cl").length + " / " + q(".fseg.cr").length);
  ok(q(".fseg.cl").concat(q(".fseg.cr")).every(e => /0x/.test(e.querySelector(".vl").textContent)),
     "each piece still shows the value of the whole field");
  press("wbits","32");

  report.section("the diagram is tied to the tables");
  const block = q('.fseg[data-seg="6"]')[0];
  hover(block);
  ok(q('[data-seg="6"].hl').length === 3, "hovering lights the block and both rows",
     q('[data-seg="6"].hl').length);
  hover(d.querySelector("h1"));
  ok(q(".hl").length === 0, "and leaving puts them out");
  click(block);
  ok(d.activeElement === value("taps"), "clicking a block goes to its value box",
     d.activeElement.getAttribute("aria-label"));

  report.section("every example draws");
  const names = q("#presets button").map(b => b.textContent);
  ok(names.length === 7, "seven of them", names.join(", "));
  const expected = {
    "fir control":["fir_ctrl","64 bits"], "gpio":["gpio","64 bits"],
    "dma channels":["dma","128 bits"], "uart ports":["uart","64 bits"],
    "ieee 754":["dac_cal","64 bits"], "fp8 and fp4":["tensor_cfg","64 bits"],
    "q1.14 taps":["fir_taps","64 bits"]
  };
  names.forEach(name => {
    preset(name);
    const [who,wide] = expected[name];
    ok($("stampname").textContent === who && $("stampw").textContent === wide &&
       q(".note.alert").length === 0 && q("#gutter .bad").length === 0,
       name + " reads as " + who + ", " + wide,
       $("stampname").textContent + " " + $("stampw").textContent + " " +
       q(".note.alert").map(e => e.textContent).join(" "));
  });

  report.section("the array and the regfile name their fields apart");
  preset("dma channels");
  ok($("root").options.length === 6 && $("root").value === "dma",
     "the named reg and the four elements are on offer, and the addrmap is drawn",
     Array.from($("root").options).map(o => o.value).join(","));
  ok(!!field("chan_0_burst") && !!field("chan_3_active"),
     "four channels, each with its own names",
     q("#vtbody tr").map(tr => tr.children[0].textContent.trim()).join(" "));
  typeIn($("wordin"), "0x0");
  typeIn(value("chan_2_prio"), "0x5");
  ok($("v-hex").textContent === "0x00000000000000500000000000000000",
     "and each lands where its register does", $("v-hex").textContent);
  preset("uart ports");
  ok(!!field("p0_baud_divisor") && !!field("p1_line_stop"), "both ports keep their own fields",
     q("#vtbody tr").map(tr => tr.children[0].textContent.trim()).join(" "));

  report.section("a field given a width rather than a range");
  $("src").value = "addrmap widths {\n" +
                   "    default regwidth = 32;\n\n" +
                   "    reg {\n" +
                   '        field { desc = "low";  } lo  [4];\n' +
                   '        field { desc = "mid";  } mid [8];\n' +
                   '        field { desc = "high"; } hi  [2];\n' +
                   "    } r0 @ 0x0;\n};";
  fire($("src"),"input");
  ok(spans() === "[13:12] [11:4] [3:0]",
     "SystemRDL reads [n] as a width and packs from bit 0, in declaration order", spans());
  ok(!!field("lo") && !!field("mid") && !!field("hi"), "all three are named",
     q("#vtbody tr").map(tr => tr.children[0].textContent.trim()).join(" "));

  report.section("a register drawn on its own");
  preset("fir control");
  pick("coeff");
  ok($("stampkind").textContent === "reg" && $("stampname").textContent === "coeff" &&
     $("stampw").textContent === "32 bits", "the register at 0x4, on its own",
     $("stampkind").textContent + " " + $("stampname").textContent + " " + $("stampw").textContent);
  ok($("dmeta").textContent.includes("at 0x4"), "and the summary says where it sits",
     $("dmeta").textContent);
  ok(spans() === "[31:16] [15:0]", "its fields numbered from its own bit 0, not the map's",
     spans());
  ok(q(".drow").length === 1 && txt(".rlab")[0] === "31:0" &&
     /^0x[0-9A-F]{8}$/.test($("v-hex").textContent),
     "one 32-bit row, and a vector of one word", txt(".rlab").join(" ") + " " +
     $("v-hex").textContent);
  ok(reads("tap1").startsWith("fix | signed | Q1.14"),
     "with the comment beside the field still saying how to read it", reads("tap1"));
  typeIn(value("tap1"), "0x4000");
  ok(typed("tap1").val.value === "1" && $("v-hex").textContent.startsWith("0x4000"),
     "and its value writes into the register's own bits", $("v-hex").textContent);
  pick("control");
  ok($("stampname").textContent === "control" && $("dmeta").textContent.includes("at 0x0"),
     "the register below it starts at zero", $("dmeta").textContent);
  ok(spans() === "[31:28] [19:16] [11:4] [2] [1:0]", "with its own five fields", spans());
  pick("fir_ctrl");
  ok($("stampkind").textContent === "map" && $("stampw").textContent === "64 bits" &&
     spans() === "[63:48] [47:32] [31:28] [19:16] [11:4] [2] [1:0]",
     "and the whole map puts them back end to end", spans());

  report.section("the registers of an array and of a regfile");
  preset("dma channels");
  ok(picker() === "chan_ctrl  (reg) | dma  (addrmap) | chan_0  (reg @ 0x0) | " +
     "chan_1  (reg @ 0x4) | chan_2  (reg @ 0x8) | chan_3  (reg @ 0xC)",
     "every element of the array is offered, at the address its stride puts it", picker());
  ok($("root").value === "dma", "and the map is still what it opens on", $("root").value);
  pick("chan_2");
  ok($("stampw").textContent === "32 bits" && $("dmeta").textContent.includes("at 0x8"),
     "one element draws as one register", $("dmeta").textContent);
  ok(!!field("burst") && !field("chan_2_burst"),
     "under the plain names, since nothing shares them here",
     q("#vtbody tr").map(tr => tr.children[0].textContent.trim()).join(" "));

  preset("uart ports");
  ok(picker() === "port  (regfile) | baud  (reg @ 0x0) | line  (reg @ 0x2) | uart  (addrmap) | " +
     "p0_baud  (reg @ 0x0) | p0_line  (reg @ 0x2) | p1_baud  (reg @ 0x4) | p1_line  (reg @ 0x6)",
     "a regfile placed twice gives every register an address of its own", picker());
  pick("p1_line");
  ok($("stampw").textContent === "16 bits" && $("dmeta").textContent.includes("at 0x6"),
     "and one of them draws sixteen bits", $("dmeta").textContent);
  ok(spans() === "[3] [1:0]" && !!field("stop") && !!field("parity"),
     "holding the two fields that register has, without the port in front of them",
     spans() + " " + q("#vtbody tr").map(tr => tr.children[0].textContent.trim()).join(" "));

  report.section("a component picked by hand");
  preset("dma channels");
  pick("chan_ctrl");
  ok($("stampkind").textContent === "reg" && $("stampname").textContent === "chan_ctrl" &&
     $("stampw").textContent === "32 bits", "the register component the array is made of",
     $("stampname").textContent + " " + $("stampw").textContent);
  ok($("dmeta").textContent.indexOf("at 0x") < 0, "which sits at no address of its own",
     $("dmeta").textContent);
  ok(!!field("burst") && !field("chan_0_burst"), "with the plain field names",
     q("#vtbody tr").map(tr => tr.children[0].textContent.trim()).join(" "));

  report.section("what it cannot read");
  preset("fir control");
  $("src").value = "addrmap empty { };";
  fire($("src"),"input");
  ok(q(".note.alert").length === 1 && $("notes").textContent.includes("Nothing to draw yet"),
     "an addrmap with nothing in it", $("notes").textContent);
  ok($("dpanel").classList.contains("faded") && $("vpanel").classList.contains("faded") &&
     $("tpanel").classList.contains("faded"), "so the three panels below fade out");
  ok($("v-hex").textContent === "—" && $("wordin").value === "" &&
     q("#ttbody tr").length === 0 && !d.querySelector("#tfoot tr"),
     "and the values clear", $("v-hex").textContent + " " + q("#ttbody tr").length);
  $("src").value = "addrmap one {\n  reg { field {} a [3:0]; } r0 @ 0x0;\n};\nnonsense here;";
  fire($("src"),"input");
  ok($("stampw").textContent === "32 bits", "a line it cannot read does not stop the rest",
     $("stampw").textContent);
  ok(q("#gutter .bad").length === 1 && q("#gutter .bad")[0].textContent === "4",
     "and is marked in the line numbers",
     q("#gutter .bad").map(e => e.textContent).join(","));
  ok($("gutter").children.length === 4, "one number a line", $("gutter").children.length);
  $("src").value = "";
  fire($("src"),"input");
  ok($("notes").textContent.includes("Nothing to draw yet"), "nothing at all",
     $("notes").textContent);

  report.section("copying a value");
  preset("fir control");
  let copied = null;
  w.navigator.clipboard = {writeText: t => { copied = t; return Promise.resolve(); }};
  click(q('.copy[data-copy="v-hex"]')[0]);
  await sleep(20);
  ok(copied === "0x0123456789ABCDEF", "the hex", copied);
  click(q('.copy[data-copy="v-bin"]')[0]);
  await sleep(20);
  ok(copied === $("v-bin").textContent, "and the binary as it is shown", copied);

  report.done();
})();
