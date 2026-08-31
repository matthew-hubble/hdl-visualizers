/* Line numbers beside the source: one per line, aligned with it, scrolling
   with it, and marking the lines the parser had something to say about. */
const {chromium} = require("playwright");
const {PAGE_URL, reporter, OUT} = require("./support/harness");
const path = require("path");

const shotPath = name => path.join(OUT, "gutter", name + ".png");
require("fs").mkdirSync(path.join(OUT, "gutter"), {recursive:true});
const report = reporter("gutter");
const ok = report.ok;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({viewport:{width:1320,height:1100}, deviceScaleFactor:2});
  const errs=[]; p.on("pageerror",e=>errs.push(e.message));
  p.on("console", m => { if(m.type()==="error") errs.push("console: "+m.text()); });
  await p.goto(PAGE_URL);
  await p.waitForTimeout(1200);

  console.log("== the gutter numbers every line");
  let g = await p.evaluate(() => {
    const src = document.getElementById("src"), gut = document.getElementById("gutter");
    const rows = [...gut.children].map(d => d.textContent);
    return {lines: src.value.split("\n").length, rows,
            first: rows[0], last: rows[rows.length-1]};
  });
  ok(g.rows.length === g.lines, "one number per line", g.rows.length + " of " + g.lines);
  ok(g.first === "1" && g.last === String(g.lines), "counting from one",
     g.first + ".." + g.last);

  console.log("== numbers sit on their lines");
  const align = await p.evaluate(() => {
    const src = document.getElementById("src"), gut = document.getElementById("gutter");
    const cs = getComputedStyle(src), gs = getComputedStyle(gut);
    const out = [];
    for(const i of [0,1,5,10]){
      const d = gut.children[i];
      if(d) out.push(d.getBoundingClientRect().top - gut.getBoundingClientRect().top);
    }
    return {lh: cs.lineHeight, glh: gs.lineHeight, padTop: cs.paddingTop, gpadTop: gs.paddingTop,
            fontSize: cs.fontSize, gfontSize: gs.fontSize, tops: out,
            gutRight: gut.getBoundingClientRect().right - src.getBoundingClientRect().left,
            padLeft: parseFloat(cs.paddingLeft)};
  });
  ok(align.lh === align.glh, "same line height", align.lh + " vs " + align.glh);
  ok(align.padTop === align.gpadTop, "same top padding", align.padTop+" vs "+align.gpadTop);
  ok(align.fontSize === align.gfontSize, "same font size");
  const step = align.tops[1] - align.tops[0];
  ok(Math.abs(step - parseFloat(align.lh)) < 0.2, "each number one line lower", step);
  ok(Math.abs((align.tops[3] - align.tops[0]) - step*10) < 0.5, "still true ten lines down");
  ok(align.padLeft > align.gutRight, "the text starts clear of the gutter",
     align.padLeft + " > " + align.gutRight.toFixed(1));

  console.log("== typing keeps up");
  await p.click("#src");
  await p.evaluate(() => { const s = document.getElementById("src");
    s.setSelectionRange(s.value.length, s.value.length); });
  await p.keyboard.type("\ntypedef struct packed { logic a; } extra_t;\n");
  await p.waitForTimeout(300);
  g = await p.evaluate(() => ({
    lines: document.getElementById("src").value.split("\n").length,
    rows: document.getElementById("gutter").children.length,
    roots: [...document.getElementById("root").options].map(o => o.value)
  }));
  ok(g.rows === g.lines, "two more lines, two more numbers", g.rows + " of " + g.lines);
  ok(g.roots.indexOf("extra_t") >= 0, "and the page reparsed", g.roots.join(","));

  console.log("== the gutter widens for three digits");
  const before = await p.evaluate(() =>
    getComputedStyle(document.getElementById("gutter")).width);
  await p.fill("#src", Array.from({length:120},(_,i)=>"// line "+(i+1)).join("\n") +
                       "\ntypedef struct packed { logic [7:0] a; } wide_t;");
  await p.waitForTimeout(300);
  const after = await p.evaluate(() => ({
    w: getComputedStyle(document.getElementById("gutter")).width,
    dg: getComputedStyle(document.getElementById("editor")).getPropertyValue("--dg").trim(),
    rows: document.getElementById("gutter").children.length,
    padLeft: parseFloat(getComputedStyle(document.getElementById("src")).paddingLeft),
    gutRight: document.getElementById("gutter").getBoundingClientRect().right -
              document.getElementById("src").getBoundingClientRect().left
  }));
  ok(after.dg === "3", "three digits now", after.dg);
  ok(parseFloat(after.w) > parseFloat(before), "so the gutter is wider",
     before + " -> " + after.w);
  ok(after.rows === 121, "121 numbers", after.rows);
  ok(after.padLeft > after.gutRight, "and the text still clears it");

  console.log("== it scrolls with the source");
  const scrolled = await p.evaluate(async () => {
    const src = document.getElementById("src"), gut = document.getElementById("gutter");
    src.scrollTop = 400;
    src.dispatchEvent(new Event("scroll"));
    await new Promise(r => setTimeout(r,50));
    const a = gut.scrollTop;
    src.scrollTop = 0;
    src.dispatchEvent(new Event("scroll"));
    await new Promise(r => setTimeout(r,50));
    return {at400: a, back: gut.scrollTop, tall: gut.scrollHeight > gut.clientHeight};
  });
  ok(scrolled.tall, "the gutter has more numbers than fit");
  ok(scrolled.at400 === 400, "it follows the source down", scrolled.at400);
  ok(scrolled.back === 0, "and back up", scrolled.back);
  await p.fill("#src", "typedef struct packed { logic [3:0] a; } t;   " +
    "// a comment long enough to push the box sideways ".repeat(4));
  await p.waitForTimeout(250);
  const hscroll = await p.evaluate(() => {
    const src = document.getElementById("src"), gut = document.getElementById("gutter");
    src.scrollLeft = 200; src.dispatchEvent(new Event("scroll"));
    return {gutLeft: gut.scrollLeft, srcLeft: src.scrollLeft,
            wide: src.scrollWidth > src.clientWidth};
  });
  ok(hscroll.wide && hscroll.srcLeft > 0 && hscroll.gutLeft === 0,
     "sideways scrolling leaves it alone", JSON.stringify(hscroll));

  console.log("== lines the page could not read are marked");
  await p.fill("#src", "typedef struct packed { logic [3:0] a; } t;\nreturn x;\nassign y = 1;");
  await p.waitForTimeout(300);
  let marks = await p.evaluate(() => ({
    bad: [...document.getElementById("gutter").querySelectorAll(".bad")].map(d=>d.textContent),
    note: document.getElementById("notes").textContent
  }));
  ok(marks.bad.indexOf("2") >= 0, "line 2 is flagged", marks.bad.join(","));
  ok(/line 2/.test(marks.note), "and the note names it", marks.note.trim().slice(0,80));

  await p.fill("#src", "typedef struct packed {\n  real gain;\n  logic [7:0] ok;\n} bad_t;");
  await p.waitForTimeout(300);
  marks = await p.evaluate(() => ({
    bad: [...document.getElementById("gutter").querySelectorAll(".bad")].map(d=>d.textContent),
    colour: (() => { const d = document.getElementById("gutter").querySelector(".bad");
                     return d ? getComputedStyle(d).color : ""; })()
  }));
  ok(marks.bad.join(",") === "2", "a warning marks its line too", marks.bad.join(","));
  ok(marks.colour === "rgb(138, 100, 16)", "in the same amber as the note", marks.colour);

  await p.fill("#src", "typedef struct packed { logic [3:0] a; } t;");
  await p.waitForTimeout(300);
  ok(await p.evaluate(() =>
       document.getElementById("gutter").querySelectorAll(".bad").length === 0),
     "clean source, no marks");

  console.log("== presets reset the view");
  await p.evaluate(() => { document.getElementById("src").scrollTop = 300; });
  await p.click('#presets button:text-is("IPv4 header")');
  await p.waitForTimeout(300);
  const reset = await p.evaluate(() => ({
    top: document.getElementById("src").scrollTop,
    gut: document.getElementById("gutter").scrollTop,
    rows: document.getElementById("gutter").children.length,
    lines: document.getElementById("src").value.split("\n").length
  }));
  ok(reset.top === 0 && reset.gut === 0, "back to the first line", JSON.stringify(reset));
  ok(reset.rows === reset.lines, "numbered for the new source", reset.rows+" of "+reset.lines);

  console.log("== resizing the box does not stretch it");
  const sized = await p.evaluate(() => {
    const src = document.getElementById("src"), ed = document.getElementById("editor");
    const gut = document.getElementById("gutter");
    const before = {ed: ed.getBoundingClientRect().height, gut: gut.getBoundingClientRect().height};
    src.style.height = "460px";
    const after = {ed: ed.getBoundingClientRect().height, gut: gut.getBoundingClientRect().height};
    src.style.height = "";
    return {before, after};
  });
  ok(Math.abs(sized.before.gut - sized.before.ed) < 3, "the gutter matches the box height",
     JSON.stringify(sized.before));
  ok(Math.abs(sized.after.gut - 460) < 4 && Math.abs(sized.after.ed - 460) < 4,
     "and follows it when resized", JSON.stringify(sized.after));

  await p.click('#presets button:text-is("descriptor")');
  await p.waitForTimeout(300);
  await p.locator(".panel").first().screenshot({path:shotPath("gutter")});
  await p.fill("#src", "typedef struct packed {\n  real gain;\n  logic [7:0] ok;\n} bad_t;");
  await p.waitForTimeout(300);
  await p.locator("#editor").screenshot({path:shotPath("gutter-flag")});

  ok(errs.length === 0, "the page reported no script errors", errs.join(" | "));
  await b.close();
  report.done();
})();
