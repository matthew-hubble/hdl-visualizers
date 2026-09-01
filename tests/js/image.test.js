/* Click the copy-image button, read the PNG back off the clipboard, and check
   it is a real picture of the diagram. */
const {chromium} = require("playwright");
const fs = require("fs");

const {PAGE_URL, reporter, OUT} = require("./support/harness");
const path = require("path");

const shotPath = name => path.join(OUT, "image", name + ".png");
require("fs").mkdirSync(path.join(OUT, "image"), {recursive:true});
const report = reporter("image");
const ok = report.ok;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport:{width:1320,height:1400}, deviceScaleFactor:2});
  await ctx.grantPermissions(["clipboard-read","clipboard-write"]);
  const p = await ctx.newPage();
  const errs=[]; p.on("pageerror",e=>errs.push(e.message));
  /* a web font that did not arrive is logged as an error too, and no check here turns
     on whether the font service was reachable */
  p.on("console", m => {
    if(m.type()==="error" && !/^Failed to load resource/.test(m.text()))
      errs.push("console: " + m.text());
  });
  await p.goto(PAGE_URL);
  await p.waitForTimeout(1200);

  // what the button should be capturing
  const geom = await p.evaluate(() => {
    const d = document.getElementById("diagram").getBoundingClientRect();
    const m = document.getElementById("dmeta").getBoundingClientRect();
    return {w: d.width + 32, h: (Math.max(d.bottom, m.bottom) - d.top) + 32};
  });

  async function grab(name){
    // leave a marker, so the picture the last grab left cannot be read as this one
    await p.evaluate(() => navigator.clipboard.writeText("no picture yet"));
    await p.click("#copyimg");
    const shot = await p.evaluate(async () => {
      /* copyImage paints, encodes and writes without saying when it is done, and how long
         that takes goes with the size of the diagram and the load on the machine. Wait for
         the picture to arrive rather than guessing at it. */
      const deadline = Date.now() + 10000;
      let items, types;
      for(;;){
        items = await navigator.clipboard.read();
        types = [].concat.apply([], items.map(i => i.types));
        if(types.indexOf("image/png") >= 0 || Date.now() > deadline) break;
        await new Promise(r => setTimeout(r,50));
      }
      if(types.indexOf("image/png") < 0) return {types};
      const blob = await items[0].getType("image/png");
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise((res,rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const g = cv.getContext("2d");
      g.drawImage(img,0,0);
      const px = g.getImageData(0,0,cv.width,cv.height).data;
      let nonWhite = 0;
      const colours = {};
      for(let i=0;i<px.length;i+=4){
        const k = px[i]+","+px[i+1]+","+px[i+2];
        if(k !== "255,255,255") nonWhite++;
        colours[k] = (colours[k]||0) + 1;
      }
      const top = Object.keys(colours).sort((a,b)=>colours[b]-colours[a]).slice(0,12);
      URL.revokeObjectURL(url);
      return {types, w:img.naturalWidth, h:img.naturalHeight, bytes:blob.size,
              ink:nonWhite/(px.length/4), palette:top,
              data: cv.toDataURL("image/png").slice(0,40)};
    });
    if(shot.w){
      const raw = await p.evaluate(async () => {
        const items = await navigator.clipboard.read();
        const blob = await items[0].getType("image/png");
        const buf = new Uint8Array(await blob.arrayBuffer());
        return Array.from(buf);
      });
      fs.writeFileSync(shotPath(name), Buffer.from(raw));
    }
    return shot;
  }

  console.log("== the button copies a png of the diagram");
  let s = await grab("copied-desc");
  ok(s.types && s.types.indexOf("image/png") >= 0, "clipboard holds image/png",
     JSON.stringify(s.types));
  ok(s.bytes > 3000, "and it is not an empty file", s.bytes + " bytes");
  ok(Math.abs(s.w - geom.w*3) <= 3, "three times the diagram width",
     s.w + " for " + Math.round(geom.w*3));
  ok(Math.abs(s.h - geom.h*3) <= 3, "and its height", s.h + " for " + Math.round(geom.h*3));
  ok(s.ink > 0.05 && s.ink < 0.95, "the picture has ink on a white ground",
     (s.ink*100).toFixed(1) + "% non-white");
  ok(s.palette[0] === "255,255,255", "mostly white", s.palette[0]);
  const wanted = ["237,233,252","229,237,248","224,240,239","248,240,223"];
  const hits = wanted.filter(c => s.palette.indexOf(c) >= 0);
  ok(hits.length >= 3, "the field tints are in it", hits.join(" "));
  ok(await p.textContent("#copyimg") === "copied" ||
     (await p.waitForTimeout(1200), await p.textContent("#copyimg")) === "copy image",
     "the button says so and settles back");

  console.log("== it follows what is on screen");
  await p.click('#presets button:text-is("IPv4 header")');
  await p.waitForTimeout(300);
  const g5 = await p.evaluate(() => {
    const d = document.getElementById("diagram").getBoundingClientRect();
    const m = document.getElementById("dmeta").getBoundingClientRect();
    return {h: (Math.max(d.bottom, m.bottom) - d.top) + 32, rows: document.querySelectorAll(".drow").length};
  });
  s = await grab("copied-ipv4");
  ok(g5.rows === 5, "five rows on screen", g5.rows);
  ok(Math.abs(s.h - g5.h*3) <= 3, "five rows in the picture", s.h + " for " + Math.round(g5.h*3));
  ok(s.bytes > 6000, "a bigger file than the two row one", s.bytes + " bytes");

  await p.click("#w64");
  await p.waitForTimeout(300);
  const g3 = await p.evaluate(() => {
    const d = document.getElementById("diagram").getBoundingClientRect();
    const m = document.getElementById("dmeta").getBoundingClientRect();
    return {h: (Math.max(d.bottom, m.bottom) - d.top) + 32, rows: document.querySelectorAll(".drow").length};
  });
  s = await grab("copied-ipv4-64");
  ok(g3.rows === 3, "64-bit rows leave three", g3.rows);
  ok(Math.abs(s.h - g3.h*3) <= 3, "and the picture shrinks with them",
     s.h + " for " + Math.round(g3.h*3));
  await p.click("#w64");

  console.log("== pad hatching and held back names come along");
  await p.click('#presets button:text-is("byte aligned")');
  await p.waitForTimeout(300);
  s = await grab("copied-bytealigned");
  ok(s.bytes > 3000, "byte aligned copies", s.bytes + " bytes");
  ok(s.palette.indexOf("241,245,248") >= 0, "the pad ground is in it", s.palette.join(" "));

  console.log("== nothing to copy when the layout fails");
  await p.fill("#src", "typedef struct packed { missing_t x; } oops_t;");
  await p.waitForTimeout(300);
  ok(await p.evaluate(() => document.getElementById("dpanel").classList.contains("faded")),
     "the panel fades out");
  ok(await p.evaluate(() =>
       getComputedStyle(document.getElementById("copyimg")).pointerEvents === "none"),
     "so the button cannot be pressed");
  /* flash() holds the label it is showing until it puts the old one back a second later, and
     ignores anything asked of it meanwhile, so let the last "copied" settle before looking. */
  await p.waitForFunction(() => document.getElementById("copyimg").textContent === "copy image");
  // the guard still holds if it is reached some other way
  const said = await p.evaluate(async () => {
    document.getElementById("copyimg").dispatchEvent(new MouseEvent("click",{bubbles:true}));
    await new Promise(r => setTimeout(r,100));
    return document.getElementById("copyimg").textContent;
  });
  ok(said === "nothing to copy", "and it says nothing to copy if asked anyway", said);

  ok(errs.length === 0, "the page reported no script errors", errs.join(" | "));
  await browser.close();
  report.done();
})();
