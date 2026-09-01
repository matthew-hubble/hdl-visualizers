/* The Source syntax control: reading SystemRDL, writing SystemVerilog, and
   the conversion it performs on the source sitting in the editor. */
const {chromium} = require("playwright");
const {PAGE_URL, reporter, OUT} = require("./support/harness");
const path = require("path");

const shotPath = name => path.join(OUT, "syntax", name + ".png");
require("fs").mkdirSync(path.join(OUT, "syntax"), {recursive:true});
const report = reporter("syntax");
const ok = report.ok;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({viewport:{width:1400,height:1500}, deviceScaleFactor:2});
  const errs=[]; p.on("pageerror",e=>errs.push(e.message));
  /* a web font that did not arrive is logged as an error too, and no check here turns
     on whether the font service was reachable */
  p.on("console", m => {
    if(m.type()==="error" && !/^Failed to load resource/.test(m.text()))
      errs.push("console: " + m.text());
  });
  await p.goto(PAGE_URL);
  await p.waitForTimeout(1200);

  const T = s => p.textContent(s);
  const ranges = () => p.evaluate(() => [...document.querySelectorAll(".fseg")]
    .map(s => [...s.querySelectorAll(".ixs i")].map(i=>i.textContent).join(":")).join(" "));

  console.log("== the control starts on SystemVerilog");
  ok(await p.evaluate(() => document.querySelector('#syntax [data-v="sv"]')
       .getAttribute("aria-pressed")) === "true", "SystemVerilog pressed");
  ok((await T("#tab-rdl")) === "SystemRDL", "the last tab offers SystemRDL", await T("#tab-rdl"));
  ok(/typedef/.test(await T("#srchint")), "the hint lists SV words", await T("#srchint"));
  ok(!(await p.evaluate(() => document.getElementById("regwfield").classList.contains("faded"))),
     "the RDL width control is live");
  const svRanges = await ranges();
  const svStamp = await T("#stampw");

  console.log("== switching to SystemRDL converts the source");
  await p.click('#syntax [data-v="rdl"]');
  await p.waitForTimeout(400);
  const now = await p.evaluate(() => document.getElementById("src").value);
  ok(/^\/\/ Generated from the declarations/.test(now), "the editor holds the generated RDL",
     now.split("\n")[0]);
  ok(/addrmap desc \{/.test(now) && /} desc_0 @ 0x0;/.test(now), "which is a real addrmap");
  ok((await T("#tab-rdl")) === "SystemVerilog", "the tab flips to SystemVerilog");
  ok(/addrmap/.test(await T("#srchint")), "and the hint lists RDL words", await T("#srchint"));
  ok((await T("#srclabel")) === "SystemRDL source", "the box is labelled for it",
     await T("#srclabel"));
  ok(await p.evaluate(() => document.getElementById("regwfield").classList.contains("faded")),
     "the RDL width control goes idle");
  ok((await T("#stampw")) === svStamp, "the width survived", await T("#stampw") + " vs " + svStamp);
  ok((await ranges()) === svRanges, "and every field is still in the same bits",
     (await ranges()) + "\n         " + svRanges);
  ok((await p.evaluate(() => document.getElementById("root").value)) === "desc",
     "the type list picks up the addrmap",
     await p.evaluate(() => [...document.getElementById("root").options].map(o=>o.value).join(",")));
  const tbl = await p.evaluate(() =>
    [...document.querySelectorAll("#ftbody tr")].map(t=>t.textContent).join(" "));
  ok(/ctrl\.cmd/.test(tbl) && /ctrl\._rsvd/.test(tbl),
     "the fields kept their names, nesting and all", tbl.slice(0,120));
  ok(await p.evaluate(() =>
       [...document.querySelectorAll("#root option")].map(o=>o.value).indexOf("ctrl_t") < 0),
     "the subtype is not offered as a map of its own");

  console.log("== the last tab now generates SystemVerilog");
  await p.click("#tab-rdl");
  await p.waitForTimeout(200);
  const sv = await T("#pane-rdl");
  ok(/^\/\/ Generated from the declarations/m.test(sv), "a generated header");
  ok(/typedef struct packed \{/.test(sv) && /\} desc_t;/.test(sv), "a packed typedef",
     (sv.match(/typedef.*|\} \w+;/g)||[]).join(" "));
  ok(/logic \[31:0\] addr; +\/\/ \[55:24\] +32 bits/.test(sv), "addr came back whole",
     (sv.match(/.*addr.*/)||[])[0]);
  ok(/logic \[1:0\] +ctrl_cmd; +\/\/ \[63:62\]/.test(sv),
     "flattened, since the diagram is flattened", (sv.match(/.*ctrl_cmd.*/)||[])[0]);

  console.log("== unflattened, the subtype comes back as a subtype");
  await p.click("#flat");
  await p.waitForTimeout(300);
  const nested = await T("#pane-rdl");
  ok(/^typedef struct packed \{$[\s\S]*?^\} ctrl_t;$/m.test(nested),
     "a ctrl_t typedef", (nested.match(/\} \w+_t;/g)||[]).join(" "));
  ok(nested.indexOf("} ctrl_t;") < nested.indexOf("} desc_t;"), "declared first");
  ok(/ctrl_t {2,}ctrl; +\/\/ \[63:56\] +8 bits/.test(nested), "and held as a member",
     (nested.match(/.*ctrl_t +ctrl;.*/)||[])[0]);
  ok(/logic \[4:0\] _rsvd; +\/\/ \[4:0\]/.test(nested),
     "with the reserved field inside it, numbered from its own zero",
     (nested.match(/.*_rsvd.*/g)||[]).join(" | "));
  await p.click("#flat");
  await p.waitForTimeout(300);
  ok((await T("#copybtn")) === "copy sv", "the copy button follows", await T("#copybtn"));

  console.log("== switching back converts again");
  await p.click('#syntax [data-v="sv"]');
  await p.waitForTimeout(400);
  const back = await p.evaluate(() => document.getElementById("src").value);
  ok(/typedef struct packed \{/.test(back), "the editor holds SystemVerilog now",
     back.split("\n")[0]);
  ok((await T("#stampw")) === svStamp, "still the same width", await T("#stampw"));
  ok((await ranges()) === svRanges, "and the same bits");
  ok((await T("#tab-rdl")) === "SystemRDL", "the tab flips back");
  ok(/addrmap desc/.test(await T("#pane-rdl")), "which generates RDL again");

  console.log("== a round trip is stable");
  for(let i=0;i<3;i++){
    await p.click('#syntax [data-v="rdl"]'); await p.waitForTimeout(250);
    await p.click('#syntax [data-v="sv"]');  await p.waitForTimeout(250);
  }
  ok((await ranges()) === svRanges, "three trips later, the same bits", await ranges());
  ok((await T("#stampw")) === svStamp, "and the same width");

  console.log("== the RDL example");
  await p.click('#presets button:text-is("RDL map")');
  await p.waitForTimeout(400);
  ok(await p.evaluate(() => document.querySelector('#syntax [data-v="rdl"]')
       .getAttribute("aria-pressed")) === "true", "the example switches the syntax for you");
  ok((await T("#stampw")) === "64 bits", "two 32-bit registers", await T("#stampw"));
  ok((await T("#stampname")) === "gpio", "named after the addrmap", await T("#stampname"));
  const rows = await p.evaluate(() => [...document.querySelectorAll("#ftbody tr")]
    .map(t => [...t.children].map(c=>c.textContent.trim()).slice(0,3).join(" ")));
  ok(rows.length === 6, "four fields and two reserved runs", rows.join(" | "));
  ok(rows.some(r => /^direction .*\[31:16\]$/.test(r)), "direction in the low register",
     rows.join(" | "));
  ok(rows.some(r => /^irq_enable .*\[55:40\]$/.test(r)), "irq_enable in the high one",
     rows.join(" | "));
  ok(rows.filter(r => /_rsvd/.test(r)).length === 2, "the gaps became reserved members",
     rows.join(" | "));
  await p.locator(".panel").first().screenshot({path:shotPath("syn-rdl-src")});
  await p.click("#tab-rdl"); await p.waitForTimeout(200);
  await p.locator("#tblwrap").screenshot({path:shotPath("syn-rdl-sv")});
  const gen = await T("#pane-rdl");
  ok(/logic \[15:0\] direction;/.test(gen), "the SV declares direction",
     (gen.match(/.*direction.*/)||[])[0]);
  ok(/logic \[7:0\] +_rsvd\d;/.test(gen) || /_rsvd\d;/.test(gen), "and the reserved runs",
     (gen.match(/.*_rsvd.*/g)||[]).join(" | "));

  console.log("== an SV example brings the syntax back");
  await p.click('#presets button:text-is("IPv4 header")');
  await p.waitForTimeout(400);
  ok(await p.evaluate(() => document.querySelector('#syntax [data-v="sv"]')
       .getAttribute("aria-pressed")) === "true", "back on SystemVerilog");
  ok((await T("#stampw")) === "160 bits", "and it parsed", await T("#stampw"));

  console.log("== rubbish in the wrong language is reported, not crashed on");
  await p.click('#syntax [data-v="rdl"]'); await p.waitForTimeout(250);
  await p.fill("#src", "typedef struct packed { logic [3:0] a; } t;");
  await p.waitForTimeout(300);
  ok(/Nothing to draw|nothing/i.test(await T("#notes")), "SV text in RDL mode says so",
     (await T("#notes")).trim().slice(0,90));
  await p.fill("#src", "addrmap x { reg { field {} a [3:0]; } r @ 0x0; };");
  await p.waitForTimeout(300);
  ok((await T("#stampw")) === "32 bits", "a minimal addrmap takes the default regwidth",
     await T("#stampw"));
  const min = await p.evaluate(() => [...document.querySelectorAll("#ftbody tr")]
    .map(t => [...t.children].map(c=>c.textContent.trim()).slice(0,3).join(" ")));
  ok(min.some(r => /^a .*\[3:0\]$/.test(r)), "with the field where it was asked for",
     min.join(" | "));
  await p.fill("#src", "addrmap x { default regwidth = 8; reg { field {} a [3:0]; } r @ 0x0; };");
  await p.waitForTimeout(300);
  ok((await T("#stampw")) === "8 bits", "and a narrower default is obeyed", await T("#stampw"));

  ok(errs.length === 0, "the page reported no script errors", errs.join(" | "));
  await b.close();
  report.done();
})();
