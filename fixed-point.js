/* Shared fixed-point machinery for the Q format pages.
   Plain script, no modules, so the pages also work when opened from disk.

   A format is a plain object {m, n, signed}: m integer bits, n fraction bits,
   plus a sign bit when signed. A stored word is a BigInt holding the signed
   integer, so a value is always word / 2^n. */
"use strict";
var FP = (function(){

  /* ---------- big-integer helpers ---------- */
  const pow2 = k => 1n << BigInt(k);
  const abs = a => a<0n ? -a : a;
  function floorDiv(a,b){ let q=a/b; if(a%b!==0n && (a<0n)!==(b<0n)) q-=1n; return q; }
  function gcd(a,b){ a=abs(a); b=abs(b); while(b){ const t=a%b; a=b; b=t; } return a; }

  /* ---------- exact decimal helpers ---------- */
  // "−0.375", "2.5e-3" → the exact rational {p,q}
  function parseDecimal(s){
    s = String(s).trim().replace(/[_,\s]/g,"");
    if(!s) return null;
    const mm = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
    if(!mm) return null;
    const sg=mm[1], ip=mm[2]||"", fp=mm[3]||"", ex=mm[4];
    if(!ip && !fp) return null;
    let e = -fp.length + (ex ? parseInt(ex,10) : 0);
    if(!isFinite(e) || Math.abs(e) > 6000) return null;
    let p = BigInt(ip+fp || "0");
    if(sg==="-") p = -p;
    let q = 1n;
    if(e>0) p *= 10n**BigInt(e); else if(e<0) q = 10n**BigInt(-e);
    return {p,q};
  }

  /* Round (p/q) * 2^nbits to an integer under the chosen mode:
       trunc  toward zero            floor  toward negative infinity
       near   ties away from zero    even/odd  ties to the neighbour of that parity
     The three nearest modes differ only on an exact tie, where the two candidates
     are consecutive integers and so are one of each parity. */
  function quantize(p,q,nbits,mode){
    if(q < 0n){ p = -p; q = -q; }
    const num = p * pow2(nbits), den = q;
    if(mode==="trunc") return num/den;
    if(mode==="floor") return floorDiv(num,den);
    const neg = num<0n, a = abs(num);
    const down = a/den, rest = 2n*(a%den);
    let up = rest > den;
    if(rest === den) up = mode==="even" ? (down & 1n) === 1n
                        : mode==="odd"  ? (down & 1n) === 0n
                        : true;
    const r = up ? down+1n : down;
    return neg ? -r : r;
  }

  // exact decimal string of F / 2^nbits
  function exactDec(F,nbits){
    if(nbits===0) return F.toString();
    const neg = F<0n, A = abs(F);
    const s = (A * 5n**BigInt(nbits)).toString().padStart(nbits+1,"0");
    const ip = s.slice(0, s.length-nbits);
    const fp = s.slice(s.length-nbits).replace(/0+$/,"");
    return (neg?"-":"") + ip + (fp ? "."+fp : "");
  }

  // num/den as a decimal string with `sig` significant digits
  function ratSci(num,den,sig,trunc){
    if(num===0n) return "0";
    const neg = (num<0n)!==(den<0n);
    let a = abs(num), d = abs(den), e = 0;
    while(a >= d*10n){ d *= 10n; e++; }
    while(a < d){ a *= 10n; e--; }
    const scale = 10n**BigInt(sig-1);
    let digits = trunc ? (a*scale)/d : (2n*a*scale + d)/(2n*d);
    if(digits >= 10n**BigInt(sig)){ digits /= 10n; e++; }
    const ds = digits.toString();
    let out;
    if(e >= -4 && e < sig){
      if(e >= 0){
        const ip = ds.slice(0,e+1), fp = ds.slice(e+1).replace(/0+$/,"");
        out = ip + (fp ? "."+fp : "");
      } else {
        out = "0." + ("0".repeat(-e-1) + ds).replace(/0+$/,"");
      }
    } else {
      const head = ds[0], tail = ds.slice(1).replace(/0+$/,"");
      out = head + (tail ? "."+tail : "") + "e" + (e>=0?"+":"") + e;
    }
    return (neg?"-":"") + out;
  }

  // exact if short, otherwise approximate (truncated toward zero, never overstated)
  function fmtVal(F,nbits,maxLen){
    const ex = exactDec(F,nbits);
    return ex.length <= maxLen ? ex : "≈ " + ratSci(F, pow2(nbits), 12, true);
  }

  // a double is exactly a rational with a power-of-two denominator; recover it
  function dblRat(x){
    if(!isFinite(x)) return null;
    if(x === 0) return {p:0n, q:1n};
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, x);
    const hi = dv.getUint32(0), lo = dv.getUint32(4);
    const neg = (hi >>> 31) === 1;
    const exp = (hi >>> 20) & 0x7FF;
    let mant = (BigInt(hi & 0xFFFFF) << 32n) | BigInt(lo);
    let e;
    if(exp === 0) e = -1074;                       // subnormal
    else { mant |= (1n << 52n); e = exp - 1075; }
    let p = neg ? -mant : mant, q = 1n;
    if(e >= 0) p <<= BigInt(e); else q = 1n << BigInt(-e);
    return {p,q};
  }

  // exact decimal for p/q when it terminates, otherwise null
  function ratExactDec(p,q){
    if(q===0n) return null;
    if(p===0n) return "0";
    const g = gcd(p,q); p/=g; q/=g;
    if(q<0n){ p=-p; q=-q; }
    let i=0, j=0;
    while(q%2n===0n){ q/=2n; i++; }
    while(q%5n===0n){ q/=5n; j++; }
    if(q!==1n) return null;
    const k = Math.max(i,j);
    const num = p * 2n**BigInt(k-i) * 5n**BigInt(k-j);
    if(k===0) return num.toString();
    const neg = num<0n, s = abs(num).toString().padStart(k+1,"0");
    const ip = s.slice(0,s.length-k), fp = s.slice(s.length-k).replace(/0+$/,"");
    return (neg?"-":"") + ip + (fp ? "."+fp : "");
  }

  /* ---------- format helpers ---------- */
  const wOf = f => f.signed ? f.m+f.n+1 : f.m+f.n;
  const fits = f => wOf(f)>=1 && wOf(f)<=64;
  const loOf = f => f.signed ? -pow2(wOf(f)-1) : 0n;
  const hiOf = f => f.signed ? pow2(wOf(f)-1)-1n : pow2(wOf(f))-1n;
  const qStr = f => "Q"+f.m+"."+f.n;
  function clampRaw(v,f){ const lo=loOf(f), hi=hiOf(f); return v<lo?lo:(v>hi?hi:v); }
  function wrapRaw(v,f){
    const w = wOf(f), mod = pow2(w);
    let t = ((v % mod) + mod) % mod;
    if(f.signed && t >= pow2(w-1)) t -= mod;
    return t;
  }

  // smallest format that holds F/2^K exactly
  function minimalFor(F,K,signed){
    let f = F, n = K;
    while(n>0 && f%2n===0n){ f/=2n; n--; }
    if(f<0n) signed = true;
    if(f===0n) return {m:0,n:0,signed};
    let m = 0;
    while(m<=64){
      const fmt = {m,n,signed};
      if(f>=loOf(fmt) && f<=hiOf(fmt)) break;
      m++;
    }
    const out = {m,n,signed};
    if(wOf(out)<1) out.m = 1;
    return out;
  }

  // for division: when full precision will not fit, size m to this quotient and spend the rest on n
  function divFitFor(p,q,signed,maxN){
    const t = abs(p)/abs(q);
    let m = 0;
    while(m<64 && pow2(m) <= t) m++;
    const s = signed?1:0;
    const n = Math.max(0, Math.min(maxN, 64-s-m));
    return {m,n,signed};
  }

  function clampFmt(f){
    let {m,n,signed} = f;
    const s = signed?1:0;
    if(m+n+s > 64){
      n = Math.max(0, 64-s-m);
      if(m+n+s > 64){ m = 64-s; n = 0; }
    }
    return {m,n,signed};
  }

  /* ---------- input parsing ---------- */
  // "Q15", "Q7.8", "q1.30", "8.24" → {m,n}
  function parseQ(text){
    const mm = /^[Qq]?\s*(\d+)(?:\s*\.\s*(\d+))?$/.exec(String(text).trim());
    if(!mm) return null;
    const a = parseInt(mm[1],10), b = mm[2]!==undefined ? parseInt(mm[2],10) : null;
    const m = b===null ? 0 : a, n = b===null ? a : b;
    if(m>64 || n>64) return null;
    return {m,n};
  }

  function clampInt(v){ const x = parseInt(v,10); return isNaN(x)?0:Math.max(0,Math.min(64,x)); }

  // decimal or hex text → stored word, or null when it will not fit the format
  function parseWord(txt,f){
    const t = String(txt).trim().replace(/[_,\s]/g,"");
    let v;
    try{
      if(/^[+-]?0[xX][0-9a-fA-F]+$/.test(t)){
        const neg = t[0]==="-";
        v = BigInt(t.replace(/^[+-]/,""));
        if(neg) v = -v;
      } else if(/^[+-]?\d+$/.test(t)) v = BigInt(t);
      else return null;
    }catch(_){ return null; }
    // a positive value above the signed maximum is read as a two's-complement pattern
    if(f.signed && v > hiOf(f) && v <= pow2(wOf(f))-1n) v -= pow2(wOf(f));
    if(v < loOf(f) || v > hiOf(f)) return null;
    return v;
  }

  /* ---------- output text ---------- */
  function cLine(raw,f){
    const bits = wOf(f)<=8?8:wOf(f)<=16?16:wOf(f)<=32?32:64;
    const ty = (f.signed?"int":"uint") + bits + "_t";
    const lit = bits===64 ? (f.signed?"INT64_C(":"UINT64_C(")+raw.toString()+")" : raw.toString()+(f.signed?"":"u");
    return ty + " x = " + lit + ";  /* " + qStr(f) + " */";
  }
  const groupBits = bits => bits.replace(/(.)(?=(.{4})+$)/g,"$1 ");
  function lsbText(n){
    if(n===0) return "1  (integer only)";
    const ls = fmtVal(1n,n,22);
    return "2^-"+n+" "+(ls[0]==="≈"?ls:"= "+ls);
  }
  const rangeText = f => fmtVal(loOf(f),f.n,18) + "  …  " + fmtVal(hiOf(f),f.n,18);

  /* ---------- bit ruler ---------- */
  const supHTML = k => "2<sup>" + (k<0?"−":"") + Math.abs(k) + "</sup>";

  /* Draw `raw` in format `f` into `el`, in nibble groups with a hex digit under each.
     opts:
       mini     compact variant, no bit weights
       bits     cells are clickable, calls onBit(i, w)
       slots    gaps are clickable, calls onPoint(m, n)
       weights  "none" | "edges" | "nibble" (default: mini ? none : edges)
     Returns {bits, enc, hex}. */
  function drawRuler(el, raw, f, opts){
    opts = opts || {};
    const w = wOf(f), pointAt = w - f.n;
    const enc = raw<0n ? raw + pow2(w) : raw;
    const bits = enc.toString(2).padStart(w,"0");
    const prev = el._prev || "";
    const same = prev.length === bits.length;
    const weights = opts.weights || (opts.mini ? "none" : "edges");
    const frag = document.createDocumentFragment();
    let i = 0, first = true;
    while(i < w){
      const len = first ? ((w % 4) || 4) : 4;
      const grp = document.createElement("div"); grp.className = "grp";
      const row = document.createElement("div"); row.className = "grow";
      if(first) row.appendChild(mkSlot(0,w,pointAt,f,opts));
      for(let k=0;k<len;k++,i++){
        row.appendChild(mkCell(i,bits,pointAt,w,f,opts,weights,same && prev[i]!==bits[i]));
        row.appendChild(mkSlot(i+1,w,pointAt,f,opts));
      }
      grp.appendChild(row);
      const hd = document.createElement("div"); hd.className="hexd";
      hd.textContent = parseInt(bits.slice(i-len,i),2).toString(16).toUpperCase();
      grp.appendChild(hd);
      frag.appendChild(grp);
      first = false;
    }
    el.innerHTML = ""; el.appendChild(frag);
    el._prev = bits;
    return {bits, enc, hex:"0x"+enc.toString(16).toUpperCase().padStart(Math.ceil(w/4),"0")};
  }

  function mkSlot(k,w,pointAt,f,opts){
    const s = document.createElement("button");
    s.type = "button";
    const usable = opts.slots && k >= (f.signed?1:0) && k <= w;
    s.className = "slot" + (k===pointAt?" on":"") + (usable?" act":"");
    s.tabIndex = (usable && k===pointAt) ? 0 : -1;
    if(usable){
      const nn = w-k, mm = w-nn-(f.signed?1:0);
      s.title = "Binary point here → Q"+mm+"."+nn;
      s.setAttribute("aria-label", s.title);
      s.addEventListener("click", () => opts.onPoint(mm,nn));
    } else {
      s.disabled = true;
      s.setAttribute("aria-hidden","true");
    }
    return s;
  }

  function mkCell(i,bits,pointAt,w,f,opts,weights,changed){
    const b = document.createElement("button");
    b.type = "button";
    const isSign = f.signed && i===0, isFrac = i >= pointAt;
    b.className = "cell " + (isSign?"sign":isFrac?"frac":"int") + (bits[i]==="0"?" zero":"") +
                  (changed?" flash":"") + (opts.bits?" act":"");
    const weight = (w-1-i) - f.n;   // power of two this column carries
    b.title = (isSign?"Sign bit, weight −":"Weight ") + "2^" + weight;
    b.setAttribute("aria-label", b.title + ", currently " + bits[i]);
    const bs = document.createElement("span"); bs.className="b"; bs.textContent = bits[i];
    const ws = document.createElement("span"); ws.className="w";
    if(weights !== "none"){
      const edge = i===0 || i===w-1 || i===pointAt-1 || i===pointAt;
      if(edge || (weights==="nibble" && (w-1-i) % 4 === 0))
        ws.innerHTML = (isSign?"−":"") + supHTML(weight);
    }
    b.appendChild(bs); b.appendChild(ws);
    if(opts.bits) b.addEventListener("click", () => opts.onBit(i,w));
    else b.disabled = true;
    return b;
  }

  // toggle bit i (leftmost is 0) of a w-bit word, keeping the signed reading
  function flipBit(raw,i,w,signed){
    let enc = raw<0n ? raw + pow2(w) : raw;
    enc ^= pow2(w-1-i);
    if(signed && enc >= pow2(w-1)) enc -= pow2(w);
    return enc;
  }

  /* ---------- small DOM helpers ---------- */
  function press(seg,btn){ seg.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x===btn))); }

  // wire every .copy button to copy the text of the element named in data-copy
  function initCopyButtons(){
    document.querySelectorAll(".copy").forEach(b => {
      b.addEventListener("click", async () => {
        const txt = document.getElementById(b.dataset.copy).textContent;
        const done = () => { const o=b.textContent; b.textContent="copied"; setTimeout(()=>b.textContent=o,1000); };
        try{ await navigator.clipboard.writeText(txt); done(); }
        catch(_){
          const ta=document.createElement("textarea"); ta.value=txt; document.body.appendChild(ta);
          ta.select(); try{ document.execCommand("copy"); done(); }catch(e){} ta.remove();
        }
      });
    });
  }

  return {
    pow2, abs,
    parseDecimal, quantize, exactDec, ratSci, fmtVal, dblRat, ratExactDec,
    wOf, fits, loOf, hiOf, qStr, clampRaw, wrapRaw, minimalFor, divFitFor, clampFmt,
    parseQ, clampInt, parseWord,
    cLine, groupBits, lsbText, rangeText,
    drawRuler, flipBit, press, initCopyButtons
  };
})();
