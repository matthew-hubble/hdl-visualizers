/* SystemVerilog struct reading and bit layout, for the struct visualizer page.
   Plain script, no modules, so the page also works when opened from disk.

   parse(text) reads the typedef, parameter and variable declarations in `text`
   and returns {types, roots, notes}. views(parsed, name, opts) turns one of
   those roots into bit segments the page can draw, most significant first.
   cCode(views) and pyCode(views) emit pack and unpack source for those segments.

   IEEE 1800-2023 7.2: in a packed structure the first member is the most
   significant, so every layout here runs from the top of the vector downwards.
   A plain (unpacked) structure starts each member on a byte boundary instead,
   and the skipped bits come back as pad segments. */
"use strict";
var SV = (function(){

  const MAXBITS = 8192;   // widest vector the page will lay out
  const MAXSEG  = 1024;   // most segments it will draw
  const MAXDEPTH = 48;    // guards mutually recursive typedefs
  const ALIGN_UNITS = [8,16,32,64];   // words an unpacked member can align to

  /* integral built-ins: width and default signedness */
  const INT_T = {
    bit:{w:1,signed:false}, logic:{w:1,signed:false}, reg:{w:1,signed:false},
    byte:{w:8,signed:true}, shortint:{w:16,signed:true}, int:{w:32,signed:true},
    longint:{w:64,signed:true}, integer:{w:32,signed:true}, time:{w:64,signed:false}
  };
  const REAL_T = {real:64, realtime:64, shortreal:32};
  const OPAQUE_T = {string:1, chandle:1, event:1, void:1};

  /* qualifiers that may sit in front of a type */
  const LEAD_KW = {const:1, var:1, static:1, automatic:1, rand:1, randc:1,
                   local:1, protected:1, virtual:1};
  /* keywords that must never be mistaken for a type name */
  const NOT_A_TYPE = {
    typedef:1, parameter:1, localparam:1, package:1, endpackage:1, module:1, endmodule:1,
    interface:1, endinterface:1, program:1, endprogram:1, class:1, endclass:1, function:1,
    endfunction:1, task:1, endtask:1, begin:1, end:1, if:1, else:1, for:1, foreach:1,
    while:1, do:1, case:1, endcase:1, assign:1, always:1, always_comb:1, always_ff:1,
    always_latch:1, initial:1, final:1, generate:1, endgenerate:1, import:1, export:1,
    input:1, output:1, inout:1, ref:1, return:1, timeunit:1, timeprecision:1, default:1,
    packed:1, tagged:1, signed:1, unsigned:1, struct:1, union:1, enum:1, modport:1,
    covergroup:1, endgroup:1, property:1, endproperty:1, sequence:1, endsequence:1
  };
  /* statements this page has no use for; skipped without complaint */
  const SILENT = {
    import:1, export:1, package:1, module:1, interface:1, program:1, class:1, function:1,
    task:1, generate:1, timeunit:1, timeprecision:1, always:1, always_comb:1, always_ff:1,
    always_latch:1, initial:1, final:1, assign:1, modport:1, covergroup:1, property:1,
    sequence:1, default:1, defparam:1, genvar:1
  };
  const DIRECTIVE = /^[ \t]*`(?:include|ifdef|ifndef|elsif|else|endif|undef|timescale|default_nettype|line|resetall|celldefine|endcelldefine|pragma|begin_keywords|end_keywords|unconnected_drive|nounconnected_drive)\b[^\n]*/gm;
  const DEFINE = /^[ \t]*`define[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)[ \t]*([^\n]*)$/gm;

  function LayoutError(msg){ this.message = msg; }
  LayoutError.prototype.toString = function(){ return this.message; };

  /* ---------- lexer ---------- */

  // a SystemVerilog literal: 12, 8'hFF, 'd10, 16'sb1010_0101, 'x
  function number(src,i){
    const n = src.length;
    let size = null;
    const digits = re => {
      let s = "";
      while(i<n && (re.test(src[i]) || src[i]==="_")){ if(src[i]!=="_") s += src[i]; i++; }
      return s;
    };
    if(/[0-9]/.test(src[i])){
      // 0x1F and 0b1010, the way SystemRDL writes an address
      if(src[i]==="0" && /[xXbB]/.test(src[i+1]||"") && /[0-9a-fA-F]/.test(src[i+2]||"")){
        const radix = /[xX]/.test(src[i+1]) ? 16 : 2;
        i += 2;
        const s = digits(radix===16 ? /[0-9a-fA-F]/ : /[01]/);
        const v = parseInt(s,radix);
        return {v:isNaN(v)?0:v, i};
      }
      const d = digits(/[0-9]/);
      if(src[i]==="." && /[0-9]/.test(src[i+1]||"")){          // real literal
        i++; const f = digits(/[0-9]/);
        return {v:parseFloat(d+"."+f), i};
      }
      size = parseInt(d,10);
      if(src[i]!=="'") return {v:isNaN(size)?0:size, i};
    }
    i++;                                                        // the quote
    if(src[i]==="s"||src[i]==="S") i++;
    const b = (src[i]||"").toLowerCase();
    const radix = b==="b"?2 : b==="o"?8 : b==="d"?10 : b==="h"?16 : 0;
    if(radix){
      i++;
      while(i<n && /\s/.test(src[i])) i++;
      const re = radix===2 ? /[01xzXZ?]/ : radix===8 ? /[0-7xzXZ?]/
               : radix===10 ? /[0-9xzXZ?]/ : /[0-9a-fA-FxzXZ?]/;
      const s = digits(re).replace(/[xzXZ?]/g,"0");
      const v = s ? parseInt(s,radix) : 0;
      return {v:isNaN(v)?0:v, i};
    }
    const u = src[i];                                           // unbased: '0 '1 'x 'z
    if(u==="1"){ i++; return {v:1,i}; }
    if(u==="0"||u==="x"||u==="X"||u==="z"||u==="Z"){ i++; return {v:0,i}; }
    return {v:size===null||isNaN(size)?0:size, i};
  }

  const OP3 = {">>>":1,"<<<":1,"===":1,"!==":1};
  const OP2 = {"**":1,"<<":1,">>":1,"::":1,"==":1,"!=":1,"&&":1,"||":1,">=":1,"<=":1,
               "+=":1,"-=":1,"%=":1,"->":1};

  function lex(src){
    const t = [], n = src.length;
    let i = 0, ln = 1;
    while(i<n){
      const c = src[i];
      if(c==="\n"){ ln++; i++; continue; }
      if(c===" "||c==="\t"||c==="\r"||c==="\f"||c==="\v"){ i++; continue; }
      if(c==="/"&&src[i+1]==="/"){ while(i<n && src[i]!=="\n") i++; continue; }
      if(c==="/"&&src[i+1]==="*"){
        let e = src.indexOf("*/", i+2); if(e<0) e = n;
        for(let j=i;j<e;j++) if(src[j]==="\n") ln++;
        i = e+2; continue;
      }
      if(c==='"'){                                   // kept whole: RDL carries desc in one
        let j = i+1, s = "";
        while(j<n && src[j]!=='"'){
          if(src[j]==="\\" && j+1<n){ s += src[j+1]; j += 2; continue; }
          if(src[j]==="\n") ln++;
          s += src[j++];
        }
        t.push({k:"str", v:s, ln});
        i = j+1; continue;
      }
      if(c==="\\"){                                  // \escaped identifier
        let j = i+1;
        while(j<n && !/\s/.test(src[j])) j++;
        t.push({k:"id", v:src.slice(i+1,j), ln}); i = j; continue;
      }
      if(c==="`"){                                   // macro use reads as its name
        let j = i+1;
        while(j<n && /[A-Za-z0-9_$]/.test(src[j])) j++;
        t.push({k:"id", v:src.slice(i+1,j), ln}); i = j; continue;
      }
      if(/[0-9]/.test(c) || (c==="'" && /[01xzXZsSbBoOdDhH]/.test(src[i+1]||""))){
        const r = number(src,i);
        t.push({k:"num", v:r.v, ln}); i = r.i; continue;
      }
      if(/[A-Za-z_$]/.test(c)){
        let j = i;
        while(j<n && /[A-Za-z0-9_$]/.test(src[j])) j++;
        t.push({k:"id", v:src.slice(i,j), ln}); i = j; continue;
      }
      const three = src.substr(i,3), two = src.substr(i,2);
      if(OP3[three]){ t.push({k:"op", v:three, ln}); i += 3; continue; }
      if(OP2[two]){ t.push({k:"op", v:two, ln}); i += 2; continue; }
      t.push({k:"op", v:c, ln}); i++;
    }
    t.push({k:"eof", v:"", ln});
    return t;
  }

  /* ---------- token helpers ---------- */
  const cur   = st => st.T[st.p];
  const isOp  = (st,d,v) => { const t = st.T[st.p+d]; return t.k==="op" && t.v===v; };
  const isId  = (st,d,v) => { const t = st.T[st.p+d]; return t.k==="id" && t.v===v; };
  const eat   = (st,v) => { if(isOp(st,0,v)){ st.p++; return true; } return false; };
  function ident(st){
    const t = cur(st);
    if(t.k!=="id" || NOT_A_TYPE[t.v]) return null;
    st.p++;
    return t.v;
  }
  // walk forward to one of `stops` at nesting depth zero, leaving it unconsumed
  function skipTo(st, stops){
    let d = 0;
    for(;;){
      const t = cur(st);
      if(t.k==="eof") return false;
      if(t.k==="op"){
        if(t.v==="("||t.v==="["||t.v==="{") d++;
        else if(t.v===")"||t.v==="]"||t.v==="}"){ if(d===0 && stops.indexOf(t.v)>=0) return true; d--; }
        else if(d===0 && stops.indexOf(t.v)>=0) return true;
      }
      st.p++;
    }
  }
  function skipStmt(st){ if(skipTo(st,[";"])) st.p++; }

  /* constructs with their own end keyword; if there is none (a prototype, say)
     fall back to reading it as one statement */
  const BLOCK_END = {
    function:"endfunction", task:"endtask", class:"endclass", covergroup:"endgroup",
    property:"endproperty", sequence:"endsequence", generate:"endgenerate",
    clocking:"endclocking", checker:"endchecker", case:"endcase"
  };
  function skipBlock(st,endKw){
    const start = st.p;
    st.p++;
    while(cur(st).k!=="eof"){
      if(cur(st).k==="id" && cur(st).v===endKw){ st.p++; return; }
      st.p++;
    }
    st.p = start;
    skipStmt(st);
  }
  const flag = (st,ln) => { if(st.skipped.indexOf(ln)<0) st.skipped.push(ln); };

  /* ---------- expressions ---------- */
  /* Enough of the language to size a range: literals, parameters, macros,
     the usual arithmetic, $bits and $clog2. Anything else evaluates to null,
     which the caller reports as an unknown width. */
  const bin = (a,b,f) => (a===null||b===null) ? null : f(a,b);

  function expr(st){ return shiftExpr(st); }

  function shiftExpr(st){
    let v = addExpr(st);
    for(;;){
      if(isOp(st,0,"<<")||isOp(st,0,"<<<")){ st.p++; v = bin(v, addExpr(st), (a,b)=>a<<b); }
      else if(isOp(st,0,">>")||isOp(st,0,">>>")){ st.p++; v = bin(v, addExpr(st), (a,b)=>a>>b); }
      else return v;
    }
  }
  function addExpr(st){
    let v = mulExpr(st);
    for(;;){
      if(isOp(st,0,"+")){ st.p++; v = bin(v, mulExpr(st), (a,b)=>a+b); }
      else if(isOp(st,0,"-")){ st.p++; v = bin(v, mulExpr(st), (a,b)=>a-b); }
      else return v;
    }
  }
  function mulExpr(st){
    let v = unaryExpr(st);
    for(;;){
      if(isOp(st,0,"*")){ st.p++; v = bin(v, unaryExpr(st), (a,b)=>a*b); }
      else if(isOp(st,0,"/")){ st.p++; v = bin(v, unaryExpr(st), (a,b)=> b===0?null:Math.trunc(a/b)); }
      else if(isOp(st,0,"%")){ st.p++; v = bin(v, unaryExpr(st), (a,b)=> b===0?null:a%b); }
      else return v;
    }
  }
  function unaryExpr(st){
    if(isOp(st,0,"-")){ st.p++; const v = unaryExpr(st); return v===null?null:-v; }
    if(isOp(st,0,"+")){ st.p++; return unaryExpr(st); }
    if(isOp(st,0,"~")){ st.p++; const v = unaryExpr(st); return v===null?null:~v; }
    return powExpr(st);
  }
  function powExpr(st){
    const v = primaryExpr(st);
    if(isOp(st,0,"**")){ st.p++; return bin(v, unaryExpr(st), (a,b)=>Math.pow(a,b)); }
    return v;
  }
  function primaryExpr(st){
    const t = cur(st);
    if(t.k==="num"){ st.p++; return t.v; }
    if(isOp(st,0,"(")){ st.p++; const v = expr(st); skipTo(st,[")"]); eat(st,")"); return v; }
    if(t.k!=="id") return null;
    if(t.v==="$bits"||t.v==="$clog2"||t.v==="$size"||t.v==="$high"||t.v==="$low"){
      st.p++;
      if(!eat(st,"(")) return null;
      let v = null;
      if(t.v==="$bits"){
        const start = st.p, ty = dataType(st);
        if(ty && isOp(st,0,")")) v = sizeOfSafe(st, ty);
        else st.p = start;
      } else if(t.v==="$clog2"){
        const a = expr(st);
        v = (a===null||a<=1) ? 0 : Math.ceil(Math.log2(a));
      } else {
        v = expr(st);
      }
      skipTo(st,[")"]); eat(st,")");
      return v;
    }
    st.p++;
    let nm = t.v;
    if(isOp(st,0,"::")){ st.p++; const tail = ident(st); if(tail) nm = tail; }
    if(st.params.has(nm)) return st.params.get(nm);
    return null;
  }
  function sizeOfSafe(st,ty){
    try{ return bitsOf({types:st.types, warn:[], memo:new Map(), unit:8}, ty, false, 0); }
    catch(_){ return null; }
  }
  function evalText(st,text){
    const sub = {T:lex(String(text)), p:0, params:st.params, types:st.types, skipped:[]};
    const v = expr(sub);
    return (typeof v === "number" && isFinite(v)) ? v : null;
  }

  /* ---------- types ---------- */
  /* int    {k:"int",   name, w, signed}
     real   {k:"real",  name, w}
     enum   {k:"enum",  base}
     ref    {k:"ref",   name}                     resolved when laid out
     arr    {k:"arr",   n, left, right, elem, unpacked}
     struct {k:"struct",packed, signed, members}   member: {name, type, line, hasUnpacked}
     union  {k:"union", packed, signed, members}                                        */

  function applyDims(base, ds, unpacked){
    let t = base;
    for(let i=ds.length-1;i>=0;i--){                 // innermost dimension binds first
      const d = ds[i];
      t = {k:"arr", n:d.n, left:d.left, right:d.right, elem:t,
           unpacked:!!unpacked, unknown:!!d.unknown};
    }
    return t;
  }

  // [7:0]  [0:7]  [4]  []  — returns one entry per dimension, as written
  function dims(st){
    const out = [];
    while(isOp(st,0,"[")){
      const ln = cur(st).ln;
      st.p++;
      if(eat(st,"]")){ out.push({n:0,left:0,right:0,unknown:true}); flag(st,ln); continue; }
      const a = expr(st);
      let d;
      if(eat(st,":")){
        const b = expr(st);
        d = (a===null||b===null) ? {n:0,left:0,right:0,unknown:true}
                                 : {left:a|0, right:b|0, n:Math.abs((a|0)-(b|0))+1};
      } else {
        d = (a===null) ? {n:0,left:0,right:0,unknown:true}
                       : {left:(a|0)-1, right:0, n:Math.max(0,a|0)};
      }
      if(d.unknown) flag(st,ln);
      skipTo(st,["]"]); eat(st,"]");
      out.push(d);
    }
    return out;
  }

  const signQual = st => {
    if(isId(st,0,"signed")){ st.p++; return true; }
    if(isId(st,0,"unsigned")){ st.p++; return false; }
    return null;
  };

  function dataType(st){
    while(cur(st).k==="id" && LEAD_KW[cur(st).v]) st.p++;
    const t = cur(st);
    if(t.k!=="id") return null;
    if(t.v==="struct"||t.v==="union") return aggregateType(st);
    if(t.v==="enum") return enumType(st);
    if(INT_T[t.v]){
      st.p++;
      const sg = signQual(st);
      const base = {k:"int", name:t.v, w:INT_T[t.v].w,
                    signed: sg===null ? INT_T[t.v].signed : sg};
      return applyDims(base, dims(st));
    }
    if(REAL_T[t.v]){ st.p++; return {k:"real", name:t.v, w:REAL_T[t.v]}; }
    if(OPAQUE_T[t.v]){ st.p++; return {k:"other", name:t.v, w:0}; }
    if(NOT_A_TYPE[t.v]) return null;
    st.p++;                                          // a user-defined type
    let nm = t.v;
    if(isOp(st,0,"::")){ st.p++; const tail = ident(st); if(tail) nm = tail; }
    const sg = signQual(st);
    return applyDims({k:"ref", name:nm, signed:sg}, dims(st));
  }

  function aggregateType(st){
    const line = cur(st).ln;
    const kind = cur(st).v==="union" ? "union" : "struct";
    st.p++;
    let packed = false, signed = null, tagged = false;
    for(;;){
      if(isId(st,0,"packed")){ packed = true; st.p++; continue; }
      if(isId(st,0,"tagged")){ tagged = true; st.p++; continue; }
      const sg = signQual(st);
      if(sg !== null){ signed = sg; continue; }
      break;
    }
    if(!isOp(st,0,"{")) return null;                 // forward declaration
    st.p++;
    const members = [];
    let guard = 0;
    while(!isOp(st,0,"}") && cur(st).k!=="eof"){
      if(++guard > 2048) break;
      const before = st.p;
      const ms = member(st);
      if(ms && ms.length) members.push.apply(members, ms);
      else { flag(st, cur(st).ln); if(skipTo(st,[";","}"]) && isOp(st,0,";")) st.p++; }
      if(st.p === before) st.p++;                    // never spin on one token
    }
    eat(st,"}");
    return applyDims({k:kind, packed, signed, tagged, members, line}, dims(st));
  }

  function enumType(st){
    st.p++;
    const base = isOp(st,0,"{") ? null : dataType(st);
    if(isOp(st,0,"{")){                              // the name list carries no width
      let d = 0;
      do{
        if(cur(st).k==="eof") break;
        if(isOp(st,0,"{")) d++; else if(isOp(st,0,"}")) d--;
        st.p++;
      } while(d>0);
    }
    return applyDims({k:"enum", base}, dims(st));
  }

  function member(st){
    const line = cur(st).ln;
    const ty = dataType(st);
    if(!ty) return null;
    const out = [];
    for(;;){
      const nm = ident(st);
      if(!nm) break;
      const ud = dims(st);
      if(eat(st,"=")) skipTo(st,[",",";"]);
      out.push({name:nm, line, hasUnpacked:ud.length>0,
                type: ud.length ? applyDims(ty,ud,true) : ty});
      if(!eat(st,",")) break;
    }
    eat(st,";");
    return out;
  }

  /* ---------- statements ---------- */
  function statement(st){
    const t = cur(st);
    if(t.k==="op"){ st.p++; return; }
    if(t.k==="num"){ skipStmt(st); return; }
    const v = t.v;
    if(v==="typedef") return typedefStmt(st);
    if(v==="parameter"||v==="localparam") return paramStmt(st);
    if(/^end/.test(v)){ st.p++; return; }            // endmodule and friends: no ;
    if(BLOCK_END[v]) return skipBlock(st, BLOCK_END[v]);
    if(SILENT[v]){ skipStmt(st); return; }
    return declStmt(st);
  }

  function typedefStmt(st){
    const line = cur(st).ln;
    st.p++;
    // typedef struct name_t;  — a forward declaration, nothing to lay out
    if(cur(st).k==="id" && /^(struct|union|enum|class)$/.test(cur(st).v) &&
       st.T[st.p+1].k==="id" && isOp(st,2,";")){ st.p += 3; return; }
    const ty = dataType(st);
    const nm = ty ? ident(st) : null;
    if(!nm){ flag(st,line); skipStmt(st); return; }
    const ud = dims(st);
    const full = ud.length ? applyDims(ty,ud,true) : ty;
    st.types.set(nm, full);
    if(hasAggregate(st,full,0)) st.roots.push({name:nm, type:full, kind:"typedef", line});
    if(!eat(st,";")) skipStmt(st);
  }

  function paramStmt(st){
    st.p++;
    if(!(cur(st).k==="id" && isOp(st,1,"="))) dataType(st);
    for(;;){
      const nm = ident(st);
      if(!nm) break;
      dims(st);
      let val = null;
      if(eat(st,"=")) val = expr(st);
      if(val !== null && isFinite(val)) st.params.set(nm,val);
      else skipTo(st,[",",";"]);
      if(!eat(st,",")) break;
    }
    if(!eat(st,";")) skipStmt(st);
  }

  function declStmt(st){
    const line = cur(st).ln, start = st.p;
    const ty = dataType(st);
    if(!ty){ st.p = start; flag(st,line); skipStmt(st); return; }
    let named = false;
    for(;;){
      const nm = ident(st);
      if(!nm) break;
      const ud = dims(st);
      const full = ud.length ? applyDims(ty,ud,true) : ty;
      if(eat(st,"=")) skipTo(st,[",",";"]);
      if(hasAggregate(st,full,0)) st.roots.push({name:nm, type:full, kind:"var", line});
      named = true;
      if(!eat(st,",")) break;
    }
    if(!named) flag(st,line);
    if(!eat(st,";")) skipStmt(st);
  }

  function hasAggregate(st,t,d){
    if(!t || d>16) return false;
    if(t.k==="struct"||t.k==="union") return true;
    if(t.k==="arr") return hasAggregate(st,t.elem,d+1);
    if(t.k==="ref") return hasAggregate(st, st.types.get(t.name), d+1);
    return false;
  }

  function parse(text){
    const defines = [];
    let src = String(text==null ? "" : text);
    const blank = m => m.replace(/[^\n]/g," ");                  // keep line numbers
    src = src.replace(DIRECTIVE, blank);
    src = src.replace(DEFINE, (m,nm,val) => { defines.push([nm,val]); return blank(m); });

    const st = {T:lex(src), p:0, params:new Map(), types:new Map(),
                roots:[], skipped:[]};
    defines.forEach(([nm,val]) => {
      const v = evalText(st,val);
      if(v !== null) st.params.set(nm,v);
    });
    let guard = 0;
    while(cur(st).k!=="eof"){
      const before = st.p;
      statement(st);
      if(st.p === before) st.p++;
      if(++guard > 200000) break;
    }
    return {types:st.types, params:st.params, roots:st.roots, skipped:st.skipped};
  }

  /* ---------- SystemRDL in ----------
     Enough SystemRDL to read back what this page writes, and hand-written
     register maps in the same shape: addrmap, regfile and reg components, named
     or anonymous, with fields at explicit bit ranges. Registers are laid end to
     end by address with offset 0 lowest, the order they are written out in, and
     the answer is handed on as a packed struct so that everything downstream —
     the diagram, the table, C, Python — works exactly as it does for
     SystemVerilog input. */

  const RDL_COMP = {addrmap:1, regfile:1, reg:1, field:1, mem:1, signal:1,
                    enum:1, constraint:1};
  const RDL_LEAD = {external:1, internal:1, abstract:1, alias:1};
  const RDL_ROOTABLE = {addrmap:1, regfile:1, reg:1};

  function parseRdl(text){
    const st = {T:lex(String(text==null ? "" : text)), p:0, params:new Map(),
                skipped:[], defs:new Map(), tops:[]};
    const scope = {kind:"root", props:{}, defaults:{}, children:[]};
    let guard = 0;
    while(cur(st).k!=="eof"){
      const before = st.p;
      rdlStmt(st,scope);
      if(st.p === before) st.p++;
      if(++guard > 200000) break;
    }
    const types = new Map(), roots = [];
    st.tops.forEach(top => types.set(top.name, null));     // hold the name
    st.tops.forEach(top => {
      const built = rdlStruct(st,top,types);
      if(!built){ types.delete(top.name); return; }
      types.set(top.name, built);
      roots.push({name:top.name, type:built, kind:top.comp.kind, line:top.comp.line});
    });
    return {types, params:st.params, roots, skipped:st.skipped, rdl:true};
  }

  function rdlStmt(st,scope){
    if(eat(st,";")) return;
    if(isOp(st,0,"}")) return;
    const t = cur(st);
    if(t.k!=="id"){ flag(st,t.ln); skipStmt(st); return; }
    if(RDL_LEAD[t.v]){ st.p++; return; }
    if(t.v==="default"){
      st.p++;
      const p = rdlProp(st);
      if(p) scope.defaults[p.k] = p.v;
      return;
    }
    if(RDL_COMP[t.v]) return rdlComp(st,scope);
    if(isOp(st,1,"=")){
      const p = rdlProp(st);
      if(p) scope.props[p.k] = p.v;
      return;
    }
    return rdlInst(st,scope);
  }

  // name = value ;  where value may be a string, a number or a keyword like rw
  function rdlProp(st){
    const key = cur(st).v;
    st.p++;
    if(!eat(st,"=")){ skipStmt(st); return null; }
    const t = cur(st);
    let v = null;
    if(t.k==="str"){ v = t.v; st.p++; }
    else if(t.k==="id"){ v = t.v; st.p++; }
    else v = expr(st);
    skipTo(st,[";"]); eat(st,";");
    return {k:key, v};
  }

  function rdlComp(st,scope){
    const line = cur(st).ln, kind = cur(st).v;
    st.p++;
    let name = null;
    if(cur(st).k==="id" && !RDL_COMP[cur(st).v]){ name = cur(st).v; st.p++; }
    if(isOp(st,0,"#")){ st.p++; skipTo(st,[")"]); eat(st,")"); }   // parameters
    if(!isOp(st,0,"{")){                                          // no body: a forward name
      flag(st,line); skipStmt(st); return;
    }
    st.p++;
    const comp = {kind, name, line, props:{}, children:[],
                  defaults:Object.assign({}, scope.defaults)};
    let guard = 0;
    while(cur(st).k!=="eof" && !isOp(st,0,"}")){
      const before = st.p;
      rdlStmt(st,comp);
      if(st.p === before) st.p++;
      if(++guard > 20000) break;
    }
    eat(st,"}");
    if(name) st.defs.set(name,comp);
    const insts = rdlInstList(st,comp);
    insts.forEach(i => scope.children.push(i));
    if(name && !insts.length && RDL_ROOTABLE[kind]) st.tops.push({name, comp});
    if(!eat(st,";")) skipStmt(st);
  }

  function rdlInst(st,scope){
    const line = cur(st).ln, tname = cur(st).v;
    st.p++;
    const comp = st.defs.get(tname);
    if(!comp){ flag(st,line); skipStmt(st); return; }
    rdlInstList(st,comp).forEach(i => scope.children.push(i));
    if(!eat(st,";")) skipStmt(st);
  }

  /* name [31:0] = reset @ 0x4 += 0x4, more ... ;
     A range on a field is its bits; on anything else it is an array count. */
  function rdlInstList(st,comp){
    const out = [];
    for(;;){
      if(cur(st).k!=="id" || RDL_COMP[cur(st).v]) break;
      const inst = {comp, name:cur(st).v, line:cur(st).ln,
                    count:1, msb:null, lsb:null, addr:null, stride:null};
      st.p++;
      while(isOp(st,0,"[")){
        st.p++;
        const a = expr(st);
        if(eat(st,":")){
          const b = expr(st);
          if(a!==null && b!==null){ inst.msb = Math.max(a,b); inst.lsb = Math.min(a,b); }
        } else if(a!==null){
          if(comp.kind==="field") inst.msb = inst.lsb = a|0;
          else inst.count = Math.max(1, a|0);
        }
        skipTo(st,["]"]); eat(st,"]");
      }
      if(eat(st,"=")) expr(st);                       // reset value, nothing to draw
      if(eat(st,"@")) inst.addr = expr(st);
      if(isOp(st,0,"+=")){ st.p++; inst.stride = expr(st); }
      if(isOp(st,0,"%=")){ st.p++; expr(st); }
      out.push(inst);
      if(!eat(st,",")) break;
    }
    return out;
  }

  const rdlNum = (v,fallback) => {
    const n = typeof v === "string" ? parseInt(v,10) : v;
    return (typeof n === "number" && isFinite(n) && n > 0) ? n : fallback;
  };
  const rdlWidth = (reg,defs) =>
    rdlNum(reg.props.regwidth, rdlNum(defs.regwidth, 32));

  // how many bytes a component covers, so the next one after it knows where to sit
  function rdlBytes(comp,defs,depth){
    if(!comp || depth > 12) return 0;
    if(comp.kind === "reg") return Math.max(1, Math.ceil(rdlWidth(comp,defs) / 8));
    if(comp.kind !== "addrmap" && comp.kind !== "regfile") return 0;
    const d = Object.assign({}, defs, comp.defaults);
    let end = 0, at = 0;
    comp.children.forEach(inst => {
      const size = rdlBytes(inst.comp,d,depth+1);
      const stride = rdlNum(inst.stride, size || 1);
      const base = inst.addr!==null ? inst.addr : at;
      at = base + inst.count*stride;
      end = Math.max(end, at);
    });
    return end;
  }

  /* Walk one root and turn it into a packed struct: every declared field becomes
     a member, and the bits nobody claimed become reserved members, which the page
     already knows to treat quietly because of the leading underscore. */
  function rdlStruct(st,top,types){
    const found = [];
    let end = 0;

    function reg(comp,byteAt,defs,path){
      const rw = rdlWidth(comp,defs);
      const base = byteAt * 8;
      let at = 0;
      comp.children.forEach(inst => {
        if(inst.comp.kind !== "field") return;
        let msb = inst.msb, lsb = inst.lsb;
        if(msb === null){
          lsb = at;
          msb = at + rdlNum(inst.comp.props.fieldwidth, 1) - 1;
        }
        at = msb + 1;
        if(msb >= rw || lsb < 0) return;                       // outside the register
        found.push({hi:base+msb, lo:base+lsb, name:inst.name,
                    desc:typeof inst.comp.props.desc === "string" ? inst.comp.props.desc : null,
                    reg:path});
      });
      end = Math.max(end, base + rw);
    }

    (function walk(comp,byteAt,defs,path,depth){
      if(depth > 12) return;
      const d = Object.assign({}, defs, comp.defaults);
      let at = byteAt;
      comp.children.forEach(inst => {
        const size = rdlBytes(inst.comp,d,0);
        const stride = rdlNum(inst.stride, size || 1);
        const base = (inst.addr!==null ? inst.addr : at - byteAt) + byteAt;
        for(let k=0;k<inst.count && k<1024;k++){
          const nm = path + inst.name + (inst.count>1 ? "_"+k : "");
          const spot = base + k*stride;
          if(inst.comp.kind === "reg") reg(inst.comp,spot,d,nm);
          else if(inst.comp.kind==="addrmap" || inst.comp.kind==="regfile")
            walk(inst.comp,spot,d,nm+"_",depth+1);
        }
        at = base + inst.count*stride;
      });
    })(top.comp, 0, {}, "", 0);

    if(top.comp.kind === "reg") reg(top.comp, 0, top.comp.defaults, "");
    if(!end) return null;
    if(end > MAXBITS) return null;

    found.sort((a,b) => b.hi - a.hi || b.lo - a.lo);

    /* Parts this page split across registers carry their own bit numbers in
       desc, so put them back together. */
    const fields = [];
    for(let i=0;i<found.length;i++){
      const f = found[i];
      const m = /^(.+)\[(\d+):(\d+)\]$/.exec(f.desc || "");
      let lo = f.lo, whole = null;
      if(m){
        let bot = +m[3];
        while(i+1 < found.length){
          const g = found[i+1];
          const m2 = /^(.+)\[(\d+):(\d+)\]$/.exec(g.desc || "");
          if(!m2 || m2[1] !== m[1] || g.hi !== lo-1 || +m2[2] !== bot-1) break;
          lo = g.lo; bot = +m2[3]; i++;
        }
        /* The X[a:b] form is this page's own, so X is a name however it reads.
           It splits into a subtype only if every part of it is an identifier:
           slot[3].hi is one array element, not a struct inside a struct. */
        if(bot === 0) whole = rdlPath(m[1]) || [m[1]];
      }
      fields.push({hi:f.hi, lo, parts: whole || rdlPath(f.desc) || [f.name], reg:f.reg});
    }

    // two fields that would land on one name take their register's name with them
    const seen = {};
    fields.forEach(f => { const k = f.parts.join("."); seen[k] = (seen[k]||0) + 1; });
    fields.forEach(f => {
      if(seen[f.parts.join(".")] > 1 && f.reg)
        f.parts = [f.reg + "_" + f.parts[0]].concat(f.parts.slice(1));
    });

    const members = rdlMembers(fields, end-1, 0, 0, types, top.comp.line);
    return members.length ? {k:"struct", packed:true, signed:null,
                             members, line:top.comp.line} : null;
  }

  /* A desc of name.field says the field came out of a nested struct, and one
     starting with an underscore says it is reserved. Anything else — a sentence,
     say — is documentation, and the instance name stays the name. */
  function rdlPath(desc){
    if(typeof desc !== "string") return null;
    const t = desc.trim();
    if(/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(t)) return t.split(".");
    if(/^_[\w$]*$/.test(t)) return [t];
    return null;
  }

  const rdlLogic = w => w===1 ? {k:"int", name:"logic", w:1, signed:false}
    : applyDims({k:"int", name:"logic", w:1, signed:false}, [{n:w, left:w-1, right:0}]);

  /* Build the members that tile [top:bottom]. A run of fields sharing the next
     name in their path becomes a nested struct of its own, so name.field comes
     back as the subtype it was written as. */
  function rdlMembers(items,top,bottom,depth,types,line){
    const taken = {}, out = [];
    let spare = 0, next = top, i = 0;
    const rsvd = w => out.push({name:safeName("_rsvd"+(spare++),taken,{}),
                                type:rdlLogic(w), line});
    while(i < items.length){
      const it = items[i];
      if(it.hi > next){ i++; continue; }                       // overlapping, already covered
      if(it.hi < next) rsvd(next - it.hi);
      if(it.parts.length > depth + 1){
        const key = it.parts[depth];
        let j = i, lo = it.lo;
        while(j < items.length && items[j].parts.length > depth+1 &&
              items[j].parts[depth] === key){ lo = items[j].lo; j++; }
        const inner = rdlMembers(items.slice(i,j), it.hi, lo, depth+1, types, line);
        let nm = key + "_t", n = 2;
        while(types.has(nm)) nm = key + "_t_" + (n++);
        types.set(nm, {k:"struct", packed:true, signed:null, members:inner, line});
        out.push({name:safeName(key,taken,{}), type:{k:"ref", name:nm}, line});
        next = lo - 1;
        i = j;
      } else {
        out.push({name:safeName(it.parts[depth],taken,{}),
                  type:rdlLogic(it.hi - it.lo + 1), line});
        next = it.lo - 1;
        i++;
      }
    }
    if(next >= bottom) rsvd(next - bottom + 1);
    return out;
  }

  /* ---------- widths ---------- */
  /* env.unit is the word an unpacked member is padded out to, 8 bits unless the
     page says otherwise; env.lsb puts the member at the bottom of that word
     rather than the top. Neither touches a packed structure. */
  const alignUp = (x,u) => (!u || u <= 1) ? x : x + ((u - (x % u)) % u);

  function deref(env,t,depth){
    let guard = 0;
    while(t && t.k==="ref"){
      const r = env.types.get(t.name);
      if(!r) throw new LayoutError("unknown type '"+t.name+"'");
      if(++guard > 64 || depth > MAXDEPTH)
        throw new LayoutError("type '"+t.name+"' is nested too deep — is it defined in terms of itself?");
      t = r;
    }
    return t;
  }

  /* Width of `t` in bits. `byteAlign` is the containing scope's rule: inside a
     plain struct every member, and every element of an unpacked array, takes
     whole bytes. A packed dimension never pads. */
  function bitsOf(env,t,byteAlign,depth){
    if(depth > MAXDEPTH) throw new LayoutError("type nesting is too deep to lay out");
    t = deref(env,t,depth);
    if(!t) return 0;
    if(t.k==="int"||t.k==="real"||t.k==="other") return t.w||0;
    if(t.k==="enum") return t.base ? bitsOf(env,t.base,byteAlign,depth+1) : 32;

    const key = t;
    let hit = env.memo.get(key);
    if(hit && hit[byteAlign?1:0] !== undefined) return hit[byteAlign?1:0];
    if(!hit){ hit = {}; env.memo.set(key,hit); }

    let w = 0;
    if(t.k==="arr"){
      // a packed dimension never pads: only unpacked elements take a whole word
      const elemAlign = byteAlign && !!t.unpacked;
      let e = bitsOf(env,t.elem,byteAlign,depth+1);
      if(elemAlign){ env.unpacked = true; e = alignUp(e,env.unit); }
      w = t.n * e;
    } else if(t.k==="struct"){
      const inner = !t.packed;
      if(inner) env.unpacked = true;
      let at = 0;
      for(const m of t.members){
        const mw = bitsOf(env,m.type,inner,depth+1);
        if(inner) at = alignUp(at,env.unit);
        at += mw;
      }
      w = inner ? alignUp(at,env.unit) : at;
    } else if(t.k==="union"){
      const inner = !t.packed;
      if(inner) env.unpacked = true;
      let mx = 0;
      for(const m of t.members) mx = Math.max(mx, bitsOf(env,m.type,inner,depth+1));
      w = inner ? alignUp(mx,env.unit) : mx;
    }
    if(w > MAXBITS) throw new LayoutError("that comes to "+w+" bits — this page draws up to "+MAXBITS+".");
    hit[byteAlign?1:0] = w;
    return w;
  }

  /* a vector is a packed dimension over single bits: one field, not an array */
  function isVector(env,t,depth){
    if(!t || t.k!=="arr") return false;
    const e = deref(env,t.elem,depth);
    return !!e && e.k==="int" && e.w===1;
  }

  function typeStr(t){
    const ds = [];
    let x = t;
    while(x && x.k==="arr"){ ds.push("["+x.left+":"+x.right+"]"); x = x.elem; }
    let base = "?";
    if(!x) base = "?";
    else if(x.k==="int"||x.k==="real"||x.k==="other") base = x.name;
    else if(x.k==="ref") base = x.name;
    else if(x.k==="enum") base = "enum";
    else base = x.packed ? x.k+" packed" : x.k;
    if(x && x.k==="int" && INT_T[x.name] && x.signed !== INT_T[x.name].signed)
      base += x.signed ? " signed" : " unsigned";
    return base + (ds.length ? " "+ds.join("") : "");
  }

  /* ---------- layout ---------- */
  const warn = (env,msg) => { if(env.warn.indexOf(msg)<0) env.warn.push(msg); };

  function checkMember(env,parent,m,depth){
    if(!parent.packed) return;
    const kind = parent.k==="union" ? "union" : "struct";
    let t;
    try{ t = deref(env,m.type,depth); }catch(_){ return; }
    if(!t) return;
    if(m.hasUnpacked)
      warn(env,"line "+m.line+": '"+m.name+"' has an unpacked dimension, which a packed "+kind+" cannot hold.");
    if(t.k==="real")
      warn(env,"line "+m.line+": '"+m.name+"' is "+t.name+", which a packed "+kind+" cannot hold.");
    else if(t.k==="other")
      warn(env,"line "+m.line+": '"+m.name+"' is "+t.name+", which has no bit width here.");
    else if((t.k==="struct"||t.k==="union") && !t.packed)
      warn(env,"line "+m.line+": '"+m.name+"' is an unpacked "+t.k+", which a packed "+kind+" cannot hold.");
  }

  const padSeg = (off,w,depth) => ({name:"", path:"", type:"pad", w, off, depth, pad:true});

  // walk the cursor up to the next word boundary, leaving pad behind
  function toBoundary(env,cur,out,depth){
    const a = alignUp(cur.at, env.unit);
    if(a > cur.at){ out.push(padSeg(cur.at, a-cur.at, depth)); cur.at = a; }
  }
  /* A member of `w` bits takes a whole word. Sitting it at the least
     significant end means the spare bits come first. */
  function toLowEnd(env,w,cur,out,depth){
    if(!env.lsb) return;
    const slot = alignUp(w, env.unit);
    if(slot > w){ out.push(padSeg(cur.at, slot-w, depth)); cur.at += slot - w; }
  }

  function emit(env,t,byteAlign,name,path,depth,cur,out,opt){
    if(out.length >= MAXSEG)
      throw new LayoutError("more than "+MAXSEG+" fields — turn off 'flatten nested' to see the top level.");
    const shown = typeStr(t);
    const rt = deref(env,t,depth);
    const expand = opt.flatten || depth===0;

    if(rt && rt.k==="struct" && expand && rt.members.length){
      const inner = !rt.packed;
      for(const m of rt.members){
        if(inner){
          toBoundary(env,cur,out,depth+1);
          toLowEnd(env, bitsOf(env,m.type,inner,depth+1), cur, out, depth+1);
        }
        checkMember(env,rt,m,depth+1);
        emit(env, m.type, inner, m.name, path ? path+"."+m.name : m.name,
             depth+1, cur, out, opt);
      }
      if(inner) toBoundary(env,cur,out,depth+1);
      return;
    }

    if(rt && rt.k==="arr" && rt.n>0 && expand && !isVector(env,rt,depth)){
      const step = rt.left<=rt.right ? 1 : -1;
      const elemAlign = byteAlign && !!rt.unpacked;
      const elemW = elemAlign ? bitsOf(env,rt.elem,byteAlign,depth+1) : 0;
      for(let k=0;k<rt.n;k++){
        const ix = "["+(rt.left + step*k)+"]";
        if(elemAlign){
          toBoundary(env,cur,out,depth+1);
          toLowEnd(env,elemW,cur,out,depth+1);
        }
        emit(env, rt.elem, byteAlign, name+ix, path+ix, depth+1, cur, out, opt);
      }
      return;
    }

    const w = bitsOf(env, rt, byteAlign, depth);
    if(rt && rt.k==="union" && rt.members.length)
      warn(env,"'"+(path||name)+"' is a union — its members share these bits, so it is drawn as one block.");
    const seg = {name, path:path||name, type:shown, w, off:cur.at, depth,
                 agg: !!rt && (rt.k==="struct"||rt.k==="union"),
                 zero: w===0};
    if(!expand && w > 0 && rt && rt.k==="struct" && rt.members.length)
      seg.sub = subView(env,t,rt,w,opt);
    out.push(seg);
    if(w===0) warn(env,"'"+(path||name)+"' came out 0 bits wide — the page could not size its type.");
    cur.at += w;
  }

  const underscored = path =>
    String(path).split(".").some(part => part.charAt(0)==="_");

  /* With flatten off a nested struct stays one block in the diagram, but the
     generators still want its inside. Carry it on the segment as a sub-layout:
     the same shape again, numbered from the bottom of the nested type. `key`
     names the type so two members of one type share a single description. */
  function subView(env,t,rt,w,opt){
    if(++env.subDepth > 16){
      env.subDepth--;
      throw new LayoutError("nested types go deeper than this page will describe.");
    }
    const segs = [], cur = {at:0};
    try{ emit(env, t, false, "", "", 0, cur, segs, opt); }
    finally{ env.subDepth--; }
    env.subs += segs.length;
    if(env.subs > MAXSEG)
      throw new LayoutError("too many nested fields to describe — turn 'flatten nested' on.");

    const out = [];
    for(const s of segs){
      if(s.w <= 0) continue;
      s.hi = w - 1 - s.off;
      s.lo = s.hi - s.w + 1;
      s.us = !s.pad && underscored(s.path);
      s.idx = out.length;
      out.push(s);
    }
    const name = t && t.k==="ref" ? t.name : null;
    let key = name ? "t:" + name : null;
    if(!key){
      let id = env.anon.get(rt);
      if(!id){ id = env.anon.size + 1; env.anon.set(rt,id); }
      key = "a:" + id;
    }
    return {key, name, label:name || typeStr(t), width:w, segs:out};
  }

  function oneView(env,type,name,caption,opt,padTo){
    const segs = [], cur = {at:0};
    const rt = deref(env,type,0);
    const byteAlign = !!(rt && rt.k==="arr" && rt.unpacked);
    const own = bitsOf(env,type,byteAlign,0);
    const width = Math.max(own, padTo||0);
    if(width > MAXBITS) throw new LayoutError("that comes to "+width+" bits — this page draws up to "+MAXBITS+".");
    // a union member narrower than the union sits at whichever end is asked for
    if(env.lsb && width > own){ segs.push(padSeg(0, width-own, 1)); cur.at = width - own; }
    emit(env,type,byteAlign,name,"",0,cur,segs,opt);
    if(width > cur.at) segs.push(padSeg(cur.at, width-cur.at, 1));
    const out = [];
    for(const s of segs){
      if(s.w <= 0) continue;
      s.hi = width - 1 - s.off;
      s.lo = s.hi - s.w + 1;
      s.us = !s.pad && underscored(s.path);
      s.idx = out.length;
      out.push(s);
    }
    return {name, caption:caption||"", width, segs:out};
  }

  /* One or more diagrams for the named root. A union yields one per member,
     since its members share the same bits. */
  function views(parsed,rootName,opts){
    const opt = {flatten: !opts || opts.flatten !== false};
    const unit = ALIGN_UNITS.indexOf(opts && opts.align|0) >= 0 ? opts.align|0 : 8;
    const env = {types:parsed.types, warn:[], memo:new Map(),
                 unit, lsb:!!(opts && opts.lsb), unpacked:false,
                 anon:new Map(), subs:0, subDepth:0};
    const root = parsed.roots.filter(r => r.name===rootName)[0] || parsed.roots[0];
    if(!root) return {views:[], warn:[], error:"Nothing to draw yet — add a struct or a typedef."};
    try{
      const rt = deref(env,root.type,0);
      let out;
      if(rt && rt.k==="union" && rt.members.length){
        const total = bitsOf(env,rt,!rt.packed,0);
        out = rt.members.map(m => {
          const v = oneView(env, m.type, m.name,
                            (rt.packed?"packed ":"")+"union member", opt, total);
          v.label = root.name+"."+m.name;
          return v;
        });
        const sizes = out.map(v => v.width);
        if(rt.packed && sizes.some(w => w!==sizes[0]))
          env.warn.push("A packed union needs every member to be the same width; these are "+sizes.join(", ")+" bits.");
      } else {
        out = [oneView(env,root.type,root.name,"",opt)];
        out[0].label = root.name;
      }
      return {views:out, warn:env.warn, error:null, root,
              unpacked:env.unpacked, align:unit, lsb:env.lsb};
    }catch(e){
      if(e instanceof LayoutError)
        return {views:[], warn:env.warn, error:e.message, root, unpacked:env.unpacked};
      throw e;
    }
  }

  /* ---------- emitting pack and unpack code ---------- */
  /* Both emitters read the same segment list the page draws, so the bit
     positions in the generated source are the ones on screen. Pad segments are
     not fields: pack leaves those bits at zero. */

  const C_KW = {auto:1,break:1,case:1,char:1,const:1,continue:1,default:1,do:1,double:1,
    else:1,enum:1,extern:1,float:1,for:1,goto:1,if:1,inline:1,int:1,long:1,register:1,
    restrict:1,return:1,short:1,signed:1,sizeof:1,static:1,struct:1,switch:1,typedef:1,
    union:1,unsigned:1,void:1,volatile:1,while:1,bool:1,true:1,false:1,buf:1,nbytes:1};
  const PY_KW = {False:1,None:1,True:1,and:1,as:1,assert:1,async:1,await:1,break:1,class:1,
    continue:1,def:1,del:1,elif:1,else:1,except:1,finally:1,for:1,from:1,global:1,if:1,
    import:1,in:1,is:1,lambda:1,nonlocal:1,not:1,or:1,pass:1,raise:1,return:1,try:1,
    while:1,with:1,yield:1,self:1,cls:1,
    BITS:1,BYTES:1,pack:1,unpack:1,from_bytes:1,to_bytes:1};
  /* SystemRDL keeps its property names in the same namespace as instance names,
     so anything here has to be spelt differently. */
  const RDL_KW = {abstract:1,accesswidth:1,activehigh:1,activelow:1,addressing:1,addrmap:1,
    alias:1,alignment:1,all:1,arbiter:1,async:1,bigendian:1,bit:1,boolean:1,bothedge:1,
    bridge:1,compact:1,component:1,constraint:1,counter:1,cpuif_reset:1,decr:1,
    decrsaturate:1,decrthreshold:1,decrvalue:1,decrwidth:1,default:1,desc:1,dontcompare:1,
    donttest:1,egress:1,encode:1,enum:1,errextbus:1,external:1,false:1,field:1,
    field_reset:1,fieldwidth:1,fullalign:1,halt:1,haltenable:1,haltmask:1,hdl_path:1,
    hdl_path_gate:1,hdl_path_slice:1,hw:1,hwclr:1,hwenable:1,hwmask:1,hwset:1,incr:1,
    incrsaturate:1,incrthreshold:1,incrvalue:1,incrwidth:1,index:1,ingress:1,internal:1,
    intr:1,level:1,littleendian:1,longint:1,lsb0:1,mask:1,mem:1,mementries:1,memwidth:1,
    msb0:1,na:1,name:1,negedge:1,next:1,nonsticky:1,number:1,overflow:1,parameter:1,
    posedge:1,precedence:1,property:1,r:1,rclr:1,ref:1,reg:1,regalign:1,regfile:1,
    regwidth:1,reset:1,resetsignal:1,rset:1,rsvdset:1,rsvdsetX:1,rw:1,saturate:1,shared:1,
    sharedextbus:1,signal:1,signalwidth:1,singlepulse:1,soft:1,span:1,sticky:1,stickybit:1,
    string:1,sw:1,swacc:1,swmod:1,swwe:1,swwel:1,sync:1,this:1,threshold:1,true:1,
    underflow:1,unsigned:1,w:1,we:1,wel:1,woclr:1,woset:1,wr:1,writeenable:1,xored:1};
  const RDL_WIDTHS = [8,16,32,64];

  const spaces = n => new Array(Math.max(0,n)+1).join(" ");
  const padR = (s,n) => String(s) + spaces(n - String(s).length);
  const padL = (s,n) => spaces(n - String(s).length) + String(s);
  const padZ = (s,n) => new Array(Math.max(0, n - String(s).length)+1).join("0") + String(s);
  const widest = (a,f) => a.reduce((m,x) => Math.max(m, String(f(x)).length), 0);

  const cType = w => w<=8 ? "uint8_t" : w<=16 ? "uint16_t" : w<=32 ? "uint32_t" : "uint64_t";
  const cTypeBits = w => w<=8 ? 8 : w<=16 ? 16 : w<=32 ? 32 : 64;
  const onesHex = w => "0x" + ((1n << BigInt(w)) - 1n).toString(16).toUpperCase();
  const cMask = w => w<=32 ? onesHex(w)+"u" : "UINT64_C("+onesHex(w)+")";
  const rangeStr = s => s.hi===s.lo ? "["+s.hi+"]" : "["+s.hi+":"+s.lo+"]";
  const bitsStr = w => w + (w===1 ? " bit" : " bits");

  // a field path such as slot[3].lo becomes an identifier such as slot_3_lo
  function safeName(path,taken,reserved){
    let s = String(path).replace(/\]/g,"").replace(/[^0-9A-Za-z_]+/g,"_").replace(/_+$/,"");
    if(!s) s = "field";
    if(/^[0-9]/.test(s)) s = "f_" + s;
    if(reserved[s]) s += "_";
    let out = s, n = 2;
    while(taken[out]) out = s + "_" + (n++);
    taken[out] = 1;
    return out;
  }

  const nameBase = label => String(label).split(".")
    .map(p => p.replace(/_t$/,"").replace(/[^0-9A-Za-z_]+/g,"_"))
    .filter(Boolean).join("_") || "s";

  function pyClass(label){
    const s = nameBase(label).split("_").filter(Boolean)
      .map(p => p.charAt(0).toUpperCase() + p.slice(1)).join("");
    return /^[0-9]/.test(s) ? "S" + s : (s || "S");
  }

  /* Pad segments are never fields. Underscore fields join them when the page is
     hiding those names: their bits read back as zero from pack. */
  const emitted = (s,skipUS) => !s.pad && !(skipUS && s.us);

  /* The comment on each field is a table: [msb:lsb] with both indices right
     justified in one column width shared by every field, then the bit count
     right justified, then bit or bits starting at a fixed column. */
  function fieldRows(v,reserved,skipUS){
    const taken = {};
    const fs = v.segs.filter(s => emitted(s,skipUS)).map(s => ({
      name:safeName(s.path,taken,reserved), path:s.path, type:s.type, sub:s.sub,
      w:s.w, hi:s.hi, lo:s.lo, count:String(s.w), unit:s.w===1 ? "bit" : "bits"
    }));
    let ix = 1;
    fs.forEach(f => { ix = Math.max(ix, String(f.hi).length, String(f.lo).length); });
    fs.forEach(f => { f.range = "[" + padL(f.hi,ix) + ":" + padL(f.lo,ix) + "]"; });
    return fs;
  }

  /* Every nested type the emitted fields lean on, deduped by type and deepest
     first, so a definition always precedes the one that uses it. */
  function nestedTypes(views,skipUS,maxWidth){
    const out = [], seen = {};
    (function walk(segs){
      segs.forEach(s => {
        if(!emitted(s,skipUS) || !s.sub) return;
        walk(s.sub.segs);
        if(seen[s.sub.key] || s.sub.width > maxWidth) return;
        seen[s.sub.key] = true;
        out.push({key:s.sub.key, name:s.sub.name, path:s.path, sub:s.sub});
      });
    })(views.reduce((a,v) => a.concat(v.segs), []));
    return out;
  }

  function rangesOf(views,pick){
    const out = [];
    views.forEach(v => v.segs.forEach(s => { if(pick(s)) out.push(rangeStr(s)); }));
    return out;
  }
  const rangeList = r => r.slice(0,10).join(" ") + (r.length>10 ? " ..." : "");

  const C_HELPERS = [
    "/* Bit 0 is the least significant bit of buf[nbytes - 1], so buf[0] carries the",
    "   first member of the struct. Clear rather than quick. */",
    "static uint64_t bits_get(const uint8_t *buf, size_t nbytes, unsigned lo, unsigned width)",
    "{",
    "    uint64_t v = 0;",
    "    unsigned i;",
    "",
    "    for (i = 0; i < width; i++)",
    "        if ((buf[nbytes - 1u - (lo + i) / 8u] >> ((lo + i) % 8u)) & 1u)",
    "            v |= (uint64_t)1 << i;",
    "    return v;",
    "}",
    "",
    "static void bits_set(uint8_t *buf, size_t nbytes, unsigned lo, unsigned width, uint64_t v)",
    "{",
    "    unsigned i;",
    "",
    "    for (i = 0; i < width; i++) {",
    "        uint8_t m = (uint8_t)(1u << ((lo + i) % 8u));",
    "",
    "        if ((v >> i) & 1u) buf[nbytes - 1u - (lo + i) / 8u] |= m;",
    "        else               buf[nbytes - 1u - (lo + i) / 8u] &= (uint8_t)~m;",
    "    }",
    "}"
  ];

  function cCode(views,opts){
    if(!views || !views.length) return "/* Nothing laid out, so nothing to generate. */";
    const skipUS = !!(opts && opts.skipUnderscore);
    const buffered = views.some(v => v.width > 64);
    const pads = rangesOf(views, s => s.pad);
    const held = skipUS ? rangesOf(views, s => !s.pad && s.us) : [];

    // a nested struct becomes its own type, as long as it fits one word
    const nested = nestedTypes(views,skipUS,64), reg = {}, taken = {};
    nested.forEach(n => {
      const b = safeName(nameBase(n.name || n.path), taken, C_KW);
      reg[n.key] = {base:b, ctype:b+"_t"};
    });

    const L = [];
    L.push("/* Generated from the declarations on this page.");
    L.push(" *");
    L.push(" * A field written [hi:lo] holds bit hi down to bit lo of the whole vector,");
    L.push(" * counting from 0 at the least significant end.");
    if(buffered)
      L.push(" * Vectors wider than 64 bits travel as a byte array, most significant byte first.");
    if(nested.length){
      L.push(" * A nested struct keeps its own type with its own pack and unpack, and its");
      L.push(" * bit numbers start again from the bottom of that type.");
    }
    if(pads.length)
      L.push(" * Pad bits are not fields; pack leaves them at zero: " + rangeList(pads));
    if(held.length)
      L.push(" * Underscore fields are left out; pack leaves their bits at zero: " + rangeList(held));
    L.push(" */");
    if(buffered) L.push("#include <stddef.h>");
    L.push("#include <stdint.h>");
    if(buffered) L.push("#include <string.h>");
    L.push("");
    if(buffered){ L.push.apply(L, C_HELPERS); L.push(""); }
    nested.forEach((n,i) => {
      if(i) L.push("");
      L.push.apply(L, cOne(asNestedView(n,reg[n.key].base), skipUS, reg));
    });
    views.forEach((v,i) => {
      if(i || nested.length) L.push("");
      L.push.apply(L, cOne(v,skipUS,reg));
    });
    return L.join("\n") + "\n";
  }

  const asNestedView = (n,cname) => ({
    label: n.name || n.path, caption: "nested", width: n.sub.width,
    segs: n.sub.segs, cname: cname, pyname: cname
  });

  function cOne(v,skipUS,reg){
    reg = reg || {};
    const base = v.cname || nameBase(v.label), ct = base + "_t", CAP = base.toUpperCase();
    const nbytes = Math.ceil(v.width/8), buffered = v.width > 64;
    const fs = fieldRows(v,C_KW,skipUS);
    const sub = f => f.sub && reg[f.sub.key];
    const L = [];

    L.push("/* " + v.label + (v.caption ? " (" + v.caption + ")" : "") +
           " - " + bitsStr(v.width) + ", " + nbytes + (nbytes===1?" byte":" bytes") + " */");
    L.push("#define " + padR(CAP+"_BITS", CAP.length+7) + " " + v.width);
    L.push("#define " + padR(CAP+"_BYTES", CAP.length+7) + " " + nbytes);
    L.push("");

    /* the struct */
    const decl = f => sub(f) ? sub(f).ctype : f.w>64 ? "uint8_t" : cType(f.w);
    const slot = f => f.name + (!sub(f) && f.w>64 ? "["+Math.ceil(f.w/8)+"]" : "") + ";";
    const w1 = widest(fs,decl), w2 = widest(fs,slot), w3 = widest(fs,f=>f.count),
          w4 = widest(fs,f=>f.unit), w5 = widest(fs,f=>f.type);
    L.push("typedef struct {");
    if(!fs.length) L.push("    uint8_t _empty;   /* no fields */");
    fs.forEach(f => L.push("    " + padR(decl(f),w1+1) + padR(slot(f),w2+2) +
      "/* " + f.range + "  " + padL(f.count,w3) + " " + padR(f.unit,w4) +
      "  " + padR(f.type,w5+1) + "*/"));
    L.push("} " + ct + ";");
    L.push("");

    if(buffered){
      L.push("/* fields -> buf */");
      L.push("static void " + base + "_pack(const " + ct + " *f, uint8_t buf[" + CAP + "_BYTES])");
      L.push("{");
      if(!fs.length) L.push("    (void)f;");
      L.push("    memset(buf, 0, " + CAP + "_BYTES);");
      const lw = widest(fs,f=>f.lo), ww = widest(fs,f=>f.w);
      fs.forEach(f => {
        if(!sub(f) && f.w > 64){ L.push.apply(L, cWide(f,CAP,true)); return; }
        const val = sub(f) ? sub(f).base + "_pack(&f->" + f.name + ")" : "f->" + f.name;
        L.push("    bits_set(buf, " + CAP + "_BYTES, " + padL(f.lo,lw) + ", " +
               padL(f.w,ww) + ", " + val + ");");
      });
      L.push("}");
      L.push("");
      L.push("/* buf -> fields */");
      L.push("static void " + base + "_unpack(const uint8_t buf[" + CAP + "_BYTES], " + ct + " *f)");
      L.push("{");
      if(!fs.length) L.push("    (void)buf; (void)f;");
      const nw = widest(fs,f=>sub(f)?"":f.name),
            cw = widest(fs,f=>(sub(f)||f.w>64)?"":"("+cType(f.w)+")");
      fs.forEach(f => {
        if(!sub(f) && f.w > 64){ L.push.apply(L, cWide(f,CAP,false)); return; }
        const get = "bits_get(buf, " + CAP + "_BYTES, " + padL(f.lo,lw) + ", " + padL(f.w,ww) + ")";
        if(sub(f))
          L.push("    " + sub(f).base + "_unpack((" + cType(f.w) + ")" + get + ", &f->" + f.name + ");");
        else
          L.push("    f->" + padR(f.name,nw) + " = " + padR("("+cType(f.w)+")",cw) + get + ";");
      });
      L.push("}");
      return L;
    }

    /* one word wide enough for the lot */
    const wt = cType(v.width);
    L.push("/* fields -> word, first member in the most significant bits */");
    L.push("static " + wt + " " + base + "_pack(const " + ct + " *f)");
    L.push("{");
    if(!fs.length){
      L.push("    (void)f;");
      L.push("    return 0;");
    } else {
      const terms = fs.map(f => {
        if(sub(f)) return "(" + wt + ")" + sub(f).base + "_pack(&f->" + f.name + ")";
        const val = "f->" + f.name;
        return "(" + wt + ")" + (f.w===cTypeBits(f.w) ? val : "(" + val + " & " + cMask(f.w) + ")");
      });
      const tw = widest(terms,t=>t), sw = widest(fs,f=>f.lo);
      const lines = fs.map((f,i) => "(" + (f.lo ? padR(terms[i],tw+1) + "<< " + padL(f.lo,sw)
                                                : terms[i]) + ")");
      lines.forEach((line,i) => L.push(i ? "         | " + line : "    return " + line));
      L[L.length-1] += ";";
    }
    L.push("}");
    L.push("");
    L.push("/* word -> fields */");
    L.push("static void " + base + "_unpack(" + wt + " word, " + ct + " *f)");
    L.push("{");
    if(!fs.length) L.push("    (void)word; (void)f;");
    const nw = widest(fs,f=>sub(f)?"":f.name), cw = widest(fs,f=>sub(f)?"":"("+cType(f.w)+")");
    fs.forEach(f => {
      const shifted = f.lo ? "(word >> " + f.lo + ")" : "word";
      const expr = f.w===cTypeBits(f.w) ? shifted : "(" + shifted + " & " + cMask(f.w) + ")";
      if(sub(f))
        L.push("    " + sub(f).base + "_unpack((" + cType(f.w) + ")" + expr + ", &f->" + f.name + ");");
      else
        L.push("    f->" + padR(f.name,nw) + " = " + padR("("+cType(f.w)+")",cw) + expr + ";");
    });
    L.push("}");
    return L;
  }

  // a field too wide for uint64_t moves a byte at a time, most significant first
  function cWide(f,CAP,packing){
    const n = Math.ceil(f.w/8);
    const L = [];
    L.push("    /* " + f.name + " " + f.range + ", " + bitsStr(f.w) + " */");
    L.push("    {");
    L.push("        unsigned i;");
    L.push("");
    L.push("        for (i = 0; i < " + n + "u; i++) {");
    L.push("            unsigned sh = 8u * (" + (n-1) + "u - i);");
    L.push("            unsigned n  = (" + f.w + "u - sh) < 8u ? (" + f.w + "u - sh) : 8u;");
    L.push("");
    L.push(packing
      ? "            bits_set(buf, " + CAP + "_BYTES, " + f.lo + "u + sh, n, f->" + f.name + "[i]);"
      : "            f->" + f.name + "[i] = (uint8_t)bits_get(buf, " + CAP + "_BYTES, " + f.lo + "u + sh, n);");
    L.push("        }");
    L.push("    }");
    return L;
  }

  function pyCode(views,opts){
    if(!views || !views.length) return "# Nothing laid out, so nothing to generate.";
    const skipUS = !!(opts && opts.skipUnderscore);
    const pads = rangesOf(views, s => s.pad);
    const held = skipUS ? rangesOf(views, s => !s.pad && s.us) : [];

    // python integers have no width limit, so every nested struct can nest
    const nested = nestedTypes(views,skipUS,Infinity), reg = {}, taken = {};
    nested.forEach(n => {
      reg[n.key] = {cls: safeName(pyClass(n.name || n.path), taken, PY_KW)};
    });
    const L = [];
    L.push('"""Generated from the declarations on this page.');
    L.push("");
    L.push("A field written [hi:lo] holds bit hi down to bit lo of the whole vector,");
    L.push("counting from 0 at the least significant end. Python integers have no");
    L.push("width limit, so the same shift and mask works however wide the struct is.");
    if(views.length > 1){
      L.push("");
      L.push("These classes read the same bits: " + views.map(v => pyClass(v.label)).join(", ") +
             " are members of one union.");
    }
    if(nested.length){
      L.push("");
      L.push("A nested struct keeps its own class, and its bit numbers start again from");
      L.push("the bottom of that class: " + nested.map(n => reg[n.key].cls).join(", ") + ".");
    }
    if(pads.length){
      L.push("");
      L.push("Pad bits are not fields; pack leaves them at zero: " + rangeList(pads));
    }
    if(held.length){
      L.push("");
      L.push("Underscore fields are left out; pack leaves their bits at zero: " + rangeList(held));
    }
    L.push('"""');
    L.push("from dataclasses import dataclass" + (nested.length ? ", field" : ""));
    nested.forEach(n => {
      L.push(""); L.push("");
      L.push.apply(L, pyOne(asNestedView(n,reg[n.key].cls), skipUS, reg));
    });
    views.forEach(v => { L.push(""); L.push(""); L.push.apply(L, pyOne(v,skipUS,reg)); });
    return L.join("\n") + "\n";
  }

  function pyOne(v,skipUS,reg){
    reg = reg || {};
    const cls = v.pyname || pyClass(v.label);
    const nbytes = Math.ceil(v.width/8);
    const fs = fieldRows(v,PY_KW,skipUS).map(f => {
      if(/^__/.test(f.name)) f.name = "f" + f.name;      // dodge name mangling
      return f;
    });
    const sub = f => f.sub && reg[f.sub.key];
    const declOf = f => sub(f) ? f.name + ": " + sub(f).cls + " = field(default_factory=" + sub(f).cls + ")"
                               : f.name + ": int = 0";
    const L = [];
    L.push("@dataclass");
    L.push("class " + cls + ":");
    L.push('    """' + v.label + (v.caption ? " (" + v.caption + ")" : "") +
           " - " + bitsStr(v.width) + ", " + nbytes + (nbytes===1?" byte":" bytes") + '."""');
    L.push("");
    L.push("    BITS = " + v.width);
    L.push("    BYTES = " + nbytes);
    L.push("");
    if(!fs.length) L.push("    # no fields");
    const dw = widest(fs,declOf), cw = widest(fs,f=>f.count), uw = widest(fs,f=>f.unit);
    fs.forEach(f => L.push("    " + padR(declOf(f), dw+2) +
      "# " + f.range + "  " + padL(f.count,cw) + " " + padR(f.unit,uw) +
      "  " + f.type));
    L.push("");
    L.push("    @classmethod");
    L.push('    def unpack(cls, word: int) -> "' + cls + '":');
    L.push('        """Read the fields out of one integer holding the whole vector."""');
    if(!fs.length) L.push("        return cls()");
    else {
      L.push("        return cls(");
      fs.forEach(f => {
        const shifted = f.lo ? "(word >> " + f.lo + ")" : "word";
        const val = shifted + " & " + onesHex(f.w);
        L.push("            " + f.name + "=" +
               (sub(f) ? sub(f).cls + ".unpack(" + val + ")" : val) + ",");
      });
      L.push("        )");
    }
    L.push("");
    L.push("    def pack(self) -> int:");
    L.push('        """Put the fields back into one integer."""');
    if(!fs.length) L.push("        return 0");
    else {
      L.push("        return (");
      fs.forEach((f,i) => {
        const val = sub(f) ? "self." + f.name + ".pack()"
                           : "(self." + f.name + " & " + onesHex(f.w) + ")";
        const term = val + (f.lo ? " << " + f.lo : "");
        L.push("            " + (i ? "| " : "  ") + (f.lo ? "(" + term + ")" : term));
      });
      L.push("        )");
    }
    L.push("");
    L.push("    @classmethod");
    L.push('    def from_bytes(cls, data: bytes) -> "' + cls + '":');
    L.push('        """Read the vector from its bytes, most significant byte first."""');
    L.push('        return cls.unpack(int.from_bytes(data, "big"))');
    L.push("");
    L.push("    def to_bytes(self) -> bytes:");
    L.push('        """Write the vector out, most significant byte first."""');
    L.push('        return self.pack().to_bytes(self.BYTES, "big")');
    return L;
  }

  /* ---------- SystemRDL ---------- */
  /* The vector is chopped into registers of `regwidth` bits, listed in address
     order. Offset 0 carries the least significant word, so bit 0 of the struct
     is bit 0 of the first register — the way a register map is read, and the
     opposite end from the diagram, which puts the first member at the top. A
     field crossing a register boundary is split and each part is named after the
     bits of the field it carries. Bits no field claims are left undeclared,
     which SystemRDL reads as reserved. */

  function rdlCode(views,opts){
    if(!views || !views.length) return "// Nothing laid out, so nothing to generate.";
    const skipUS = !!(opts && opts.skipUnderscore);
    const asked = opts && (opts.regwidth|0);
    const rw = RDL_WIDTHS.indexOf(asked) >= 0 ? asked : 32;

    /* SystemRDL fields are leaves, so a nested struct cannot be a field of a
       field. It gets its own reg component instead, describing the layout
       inside the nested type, and the field that carries it points at it. */
    const nested = nestedTypes(views,skipUS,Infinity), reg = {}, taken = {};
    nested.forEach(n => {
      reg[n.key] = {name: safeName(nameBase(n.name || n.path) + "_layout", taken, RDL_KW)};
    });
    const L = [];
    L.push("// Generated from the declarations on this page.");
    L.push("//");
    L.push("// Each type becomes an addrmap of " + rw + "-bit registers, listed in address");
    L.push("// order. Offset 0 carries the least significant word, so bit 0 of the struct is");
    L.push("// bit 0 of that register. The diagram reads the other way, first member at the");
    L.push("// top. A field wider than a register, or one that straddles a boundary, is");
    L.push("// split, and each part is named after the bits of the field it holds.");
    L.push("// Bits that no field claims are left undeclared: reserved.");
    if(views.length > 1)
      L.push("// These addrmaps overlay the same bits — they are the members of one union.");
    if(nested.length){
      L.push("// A field cannot hold fields, so each nested struct is described by its own");
      L.push("// reg component below, numbered from the bottom of the nested type. The field");
      L.push("// that carries one says which.");
    }
    L.push("");
    nested.forEach(n => { L.push.apply(L, rdlNested(n,reg,skipUS)); L.push(""); });
    views.forEach((v,i) => { if(i) L.push(""); L.push.apply(L, rdlOne(v,rw,skipUS,reg)); });
    return L.join("\n") + "\n";
  }

  // the layout inside a nested type, as a reg component nothing instantiates
  function rdlNested(n,reg,skipUS){
    const fs = fieldRows(asNestedView(n,null), RDL_KW, skipUS);
    let width = 8;
    while(width < n.sub.width) width *= 2;
    const dw = widest(fs, f => 'desc = "' + f.path + '";'), nw = widest(fs, f => f.name);
    const L = [];
    L.push("reg " + reg[n.key].name + " {");
    L.push('    desc = "' + (n.name || n.path) + ", the " + bitsStr(n.sub.width) +
           ' inside a nested struct";');
    L.push("");
    L.push("    regwidth = " + width + ";");
    L.push("    default sw = rw;");
    L.push("    default hw = r;");
    L.push("");
    fs.forEach(f => {
      const deeper = f.sub && reg[f.sub.key];
      L.push("    field { " + padR('desc = "' + f.path + '";', dw+1) +
        "} " + padR(f.name, nw+1) + f.range + ";" +
        (deeper ? "  // " + f.type + ", see " + deeper.name : ""));
    });
    L.push("};");
    return L;
  }

  function rdlOne(v,rw,skipUS,regmap){
    regmap = regmap || {};
    const base = nameBase(v.label), fs = fieldRows(v,RDL_KW,skipUS);
    const L = [];
    if(!fs.length){
      L.push("// " + v.label + " has no fields left to map.");
      return L;
    }
    const words = Math.max(1, Math.ceil(v.width / rw)), stride = rw / 8;
    const regs = [];
    for(let k=0;k<words;k++){                       // word 0 is the low one, at offset 0
      const lo = k * rw, hi = Math.min(v.width - 1, lo + rw - 1);
      const taken = {}, parts = [];
      fs.forEach(f => {
        if(f.hi < lo || f.lo > hi) return;
        const chi = Math.min(f.hi,hi), clo = Math.max(f.lo,lo);
        const whole = chi===f.hi && clo===f.lo;
        const fmsb = chi - f.lo, flsb = clo - f.lo;   // which bits of the field these are
        const nest = f.sub && regmap[f.sub.key];
        parts.push({
          name: safeName(whole ? f.name : f.name+"_"+fmsb+"_"+flsb, taken, RDL_KW),
          desc: whole ? f.path : f.path + "[" + fmsb + ":" + flsb + "]",
          note: nest ? f.type + ", see " + nest.name : "",
          msb: chi - lo, lsb: clo - lo
        });
      });
      if(parts.length) regs.push({n:k, hi, lo, addr:k*stride, parts});
    }
    if(!regs.length){
      L.push("// " + v.label + " has no fields left to map.");
      return L;
    }

    const all = regs.reduce((a,r) => a.concat(r.parts), []);
    const dw = widest(all, p => 'desc = "' + p.desc + '";'), nw = widest(all, p => p.name);
    let iw = 1;
    all.forEach(p => { iw = Math.max(iw, String(p.msb).length, String(p.lsb).length); });
    const aw = regs[regs.length-1].addr.toString(16).length;
    const addr = a => "0x" + padZ(a.toString(16).toUpperCase(), aw);

    L.push("addrmap " + base + " {");
    L.push('    name = "' + v.label + '";');
    L.push('    desc = "' + bitsStr(v.width) + " in " + regs.length +
           (regs.length===1 ? " register of " : " registers of ") + rw + '";');
    L.push("");
    L.push("    default regwidth = " + rw + ";");
    L.push("    default sw = rw;");
    L.push("    default hw = r;");
    regs.forEach(r => {
      L.push("");
      L.push("    reg {");
      L.push('        desc = "' + v.label + "[" + r.hi + ":" + r.lo + ']";');
      L.push("");
      r.parts.forEach(p => L.push("        field { " +
        padR('desc = "' + p.desc + '";', dw+1) + "} " + padR(p.name, nw+1) +
        "[" + padL(p.msb,iw) + ":" + padL(p.lsb,iw) + "];" +
        (p.note ? "  // " + p.note : "")));
      L.push("    } " + base + "_" + r.n + " @ " + addr(r.addr) + ";");
    });
    L.push("};");
    return L;
  }

  /* ---------- SystemVerilog out ----------
     The other direction: one packed typedef per view, members most significant
     first, with the bits nobody claimed kept as reserved members so the widths
     still add up to the vector on screen. */
  function svCode(views){
    if(!views || !views.length) return "// Nothing laid out, so nothing to generate.";
    const nested = nestedTypes(views,false,Infinity), reg = {}, taken = {};
    nested.forEach(n => {
      reg[n.key] = {base: safeName(nameBase(n.name || n.path), taken, NOT_A_TYPE)};
    });
    const L = [];
    L.push("// Generated from the declarations on this page.");
    L.push("//");
    L.push("// A packed struct puts its first member in the most significant bits, so a");
    L.push("// member marked [hi:lo] holds bit hi down to bit lo of the whole vector.");
    L.push("// Bits that carried no field come back as reserved members, keeping the");
    L.push("// widths adding up.");
    if(nested.length){
      L.push("// A nested struct keeps its own typedef, declared before the one that holds");
      L.push("// it, and its bits are numbered from the bottom of that type.");
    }
    L.push("");
    nested.forEach((n,i) => {
      if(i) L.push("");
      L.push.apply(L, svOne(asNestedView(n, reg[n.key].base), reg));
    });
    views.forEach((v,i) => {
      if(i || nested.length) L.push("");
      L.push.apply(L, svOne(v,reg));
    });
    return L.join("\n") + "\n";
  }

  function svOne(v,reg){
    reg = reg || {};
    const taken = {};
    let spare = 0;
    const rows = v.segs.map(s => {
      const sub = s.sub && reg[s.sub.key];
      return {
        name: safeName(s.pad ? "_pad" + (++spare) : s.path, taken, NOT_A_TYPE),
        decl: sub ? sub.base + "_t" : s.w===1 ? "logic" : "logic [" + (s.w-1) + ":0]",
        count: String(s.w), unit: s.w===1 ? "bit" : "bits",
        hi:s.hi, lo:s.lo, type:s.type, pad:s.pad, range:""
      };
    });
    let ix = 1;
    rows.forEach(r => { ix = Math.max(ix, String(r.hi).length, String(r.lo).length); });
    rows.forEach(r => { r.range = "[" + padL(r.hi,ix) + ":" + padL(r.lo,ix) + "]"; });
    const w1 = widest(rows,r=>r.decl), w2 = widest(rows,r=>r.name+";"),
          w3 = widest(rows,r=>r.count), w4 = widest(rows,r=>r.unit);
    const L = [];
    L.push("typedef struct packed {");
    if(!rows.length) L.push("  logic _empty;   // nothing to declare");
    rows.forEach(r => L.push(("  " + padR(r.decl,w1+1) + padR(r.name+";",w2+2) +
      "// " + r.range + "  " + padL(r.count,w3) + " " + padR(r.unit,w4) +
      (r.pad || r.type === r.decl ? "" : "  " + r.type)).replace(/\s+$/,"")));
    L.push("} " + (v.cname || nameBase(v.label)) + "_t;");
    return L;
  }

  return {parse, parseRdl, views, typeStr, underscored,
          cCode, pyCode, rdlCode, svCode,
          ALIGN_UNITS, RDL_WIDTHS, MAXBITS, MAXSEG};
})();
