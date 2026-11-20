/* ฟิล์มกรองแสง: ใช้ไซส์และราคาชุดเดียวกับเว็บ FilmPro (film.karnet.org/api/catalog)
   ไฟล์เดียวใช้ได้ทั้งหน้าแอป (script ธรรมดา) ตัว worker (สร้างข้อมูลให้ AI) และสคริปต์อัปเดตข้อมูล */
(function (G) {
  "use strict";
  var SIZES = ["C", "S|4D", "M", "L", "XL", "XXL", "GIGA"];
  var tk = function (t) { return String(t).replace("|", "_"); };
  var norm = function (s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ""); };
  var same = function (a, b) { return (a === "S" ? "S|4D" : a) === (b === "S" ? "S|4D" : b); };
  /* ชื่อรุ่นบนเว็บที่ต่างจากชื่อเดิมในแอป แต่เป็นรุ่นเดียวกัน (คงรหัสเดิมไว้ให้ใบงานเก่า) */
  var ALIAS = { "avery|ultimaceramicperformance": "avery_1", "llumar|stratos": "llumar_5" };
  var BRAND_NAME = { stek: "Lunaray" };
  /* รถรุ่นใหม่ที่มีบนเว็บแต่ยังไม่มีในแอป: เดาประเภทล้างรถ/ไซส์ฟิล์มใสจากไซส์ฟิล์มกรองแสง */
  var GUESS = { "C": ["SUV", "L", 1], "S|4D": ["SEDAN", "S", 0], "M": ["SEDAN", "M", 0], "L": ["SUV", "L", 0], "XL": ["SUV", "XL", 0], "XXL": ["MPV", "XXL", 0], "GIGA": ["MPV", "XXL", 0] };
  var dash = function (v) { return v && v !== "-" ? String(v) : ""; };
  var num = function (n) { return n == null ? "-" : Number(n).toLocaleString("en-US"); };

  function seriesIds(cat, old) {
    var out = {};
    cat.brands.forEach(function (b) {
      var prev = (old || []).filter(function (x) { return x.id === b.id; })[0];
      var used = {}, next = 0;
      (prev ? prev.s : []).forEach(function (s) { var n = Number(String(s.id).split("_").pop()); if (n >= next) next = n + 1; });
      b.series.forEach(function (s) {
        var id = ALIAS[b.id + "|" + norm(s.name)];
        if (!id && prev) { var hit = prev.s.filter(function (x) { return norm(x.n) === norm(s.name); })[0]; if (hit) id = hit.id; }
        if (!id || used[id]) id = b.id + "_" + (next++);
        used[id] = 1; out[b.id + "|" + s.name] = id;
      });
    });
    return out;
  }

  /* TINTDB แบบที่แอปใช้ (sun = ราคาซันรูฟของไซส์ M, sunBy = แยกตามไซส์) */
  function tintdb(cat, old) {
    var ids = seriesIds(cat, old);
    return cat.brands.map(function (b) {
      return { id: b.id, n: BRAND_NAME[b.id] || b.name, s: b.series.map(function (s) {
        var sunBy = {}; SIZES.forEach(function (z) { sunBy[z] = (s.sun && s.sun[z]) || [null, null, null]; });
        return { id: ids[b.id + "|" + s.name], n: s.name, v: dash(s.vlt), i: dash(s.irr), t: dash(s.tser), u: dash(s.uv), st: null,
          sun: sunBy.M, sunBy: sunBy, ws: "", sh: (s.shades || []).map(function (d) { return d.model; }), metal: !!s.metal, est: !!s.sunEst };
      }) };
    });
  }

  /* ราคาฟิล์มกรองแสงทั้งหมดเป็นคีย์ของแอป tint_<รหัสรุ่น>_<ไซส์> */
  function prices(cat, db) {
    var p = {};
    cat.brands.forEach(function (b, bi) {
      b.series.forEach(function (s, si) {
        var id = db[bi].s[si].id;
        SIZES.forEach(function (z) { var v = s.price && s.price[z]; if (typeof v === "number") p["tint_" + id + "_" + tk(z)] = v; });
      });
    });
    return p;
  }

  /* ปรับไซส์รถในแอปให้ตรงเว็บ + ไซส์เฉพาะยี่ห้อ (Avery / LLumar) + เพิ่มรุ่นที่ยังไม่มี */
  function fixCar(cat, c) {
    var cs = cat.carSizes || {}, bs = cat.brandSizes || {};
    var t = cs[c.b] && cs[c.b][c.m];
    if (t && SIZES.indexOf(t) >= 0) c.t = t;
    var ov = {};
    Object.keys(bs).forEach(function (br) { var v = bs[br][c.b] && bs[br][c.b][c.m]; if (v && SIZES.indexOf(v) >= 0 && !same(v, c.t)) ov[br] = v; });
    if (Object.keys(ov).length) c.ov = ov; else delete c.ov;
    return c;
  }
  function cars(cat, list) {
    var cs = cat.carSizes || {}, bs = cat.brandSizes || {}, have = {};
    list.forEach(function (c) { have[c.b + "|" + c.m] = 1; fixCar(cat, c); });
    Object.keys(cs).forEach(function (b) {
      Object.keys(cs[b]).forEach(function (m) {
        var t = cs[b][m];
        if (have[b + "|" + m] || !GUESS[t]) return;
        var g = GUESS[t], c = { b: b, m: m, t: t, w: g[0], p: g[1], k: g[2], u: 1 };
        Object.keys(bs).forEach(function (br) { var v = bs[br][b] && bs[br][b][m]; if (v && !same(v, t)) { c.ov = c.ov || {}; c.ov[br] = v; } });
        list.push(c);
      });
    });
    return list;
  }

  /* ---------- ข้อมูลให้ AI ตอบแชท (knowledge.js) ---------- */
  var FEATURED = ["blaupunkt", "stek", "wincos", "3m"];
  function priceRow(b, s) {
    var p = SIZES.map(function (z) { return num(s.price[z]); }).join(" / ");
    var sun = s.sun && s.sun.M ? s.sun.M.map(num).join(" / ") : "- / - / -";
    return "| " + (BRAND_NAME[b.id] || b.name) + " " + s.name + " | " + p + " | " + sun + (s.sunEst ? " (ประมาณ)" : "") + " |";
  }
  function tables(cat) {
    var head = "| รุ่น | ราคารอบคันตามไซส์ | ซันรูฟ 1 ช่อง / 2 ช่อง / หลังคาแก้ว (บวกเพิ่ม) |\n|---|---|---|";
    var f = [], o = [];
    FEATURED.forEach(function (id) { cat.brands.forEach(function (b) { if (b.id === id) b.series.forEach(function (s) { f.push(priceRow(b, s)); }); }); });
    cat.brands.forEach(function (b) { if (FEATURED.indexOf(b.id) < 0) b.series.forEach(function (s) { o.push(priceRow(b, s)); }); });
    var own = Object.keys(cat.brandSizes || {}).map(function (id) { var b = cat.brands.filter(function (x) { return x.id === id; })[0]; return b ? (BRAND_NAME[id] || b.name) : id; });
    var note = "ราคาและไซส์ชุดเดียวกับเว็บ FilmPro ของร้าน ซันรูฟที่มีคำว่า (ประมาณ) ให้แจ้งว่าเป็นราคาประมาณ ทีมงานยืนยันอีกครั้ง" +
      (own.length ? "\n" + own.join(" และ ") + " ใช้ตารางไซส์ของยี่ห้อตัวเอง: ถ้าในตารางรุ่นรถมีวงเล็บต่อท้าย เช่น (Avery Dennison L) ให้ใช้ไซส์ในวงเล็บกับยี่ห้อนั้น ยี่ห้ออื่นใช้ไซส์ฟิล์มกรองแสงปกติ" : "");
    return {
      main: "### ตารางราคา (บาท) ราคารอบคันรวมกระจกหน้า แยกตามไซส์ฟิล์ม C / S|4D / M / L / XL / XXL / GIGA\n" + note + "\n" + head + "\n" + f.join("\n") + "\n\n",
      other: "### ตารางยี่ห้ออื่น (ราคารอบคันรวมกระจกหน้า ตามไซส์ C / S|4D / M / L / XL / XXL / GIGA | ซันรูฟ 1 ช่อง / 2 ช่อง / หลังคาแก้ว บวกเพิ่ม)\n" + head + "\n" + o.join("\n") + "\n\n"
    };
  }
  function brandOf(cat, id) { var b = cat.brands.filter(function (x) { return x.id === id; })[0]; return b ? (BRAND_NAME[id] || b.name) : id; }
  function carLine(cat, c) {
    var ov = c.ov ? Object.keys(c.ov).map(function (br) { return brandOf(cat, br) + " " + c.ov[br]; }) : [];
    var w = { SEDAN: "Sedan", SUV: "SUV", MPV: "MPV" }[c.w] || c.w;
    return c.b + " " + c.m + " = " + w + "/" + c.p + "/" + c.t + (ov.length ? " (" + ov.join(", ") + ")" : "");
  }
  /* แทนที่ส่วนราคาฟิล์มกรองแสงและตารางรุ่นรถใน KB; list = รายการรถของแอป (ถ้าไม่ส่งมา จะแก้ไซส์จากบรรทัดเดิม) */
  function kb(K, cat, list) {
    var t = tables(cat);
    var cut = function (s, a, b, rep) { var i = s.indexOf(a); if (i < 0) return s; var j = s.indexOf(b, i + a.length); if (j < 0) return s; return s.slice(0, i) + rep + s.slice(j); };
    K = cut(K, "### ตารางราคา (บาท)", "### Defender", t.main);
    K = cut(K, "### ตารางยี่ห้ออื่น", "## 8)", t.other);
    var have = {}; cat.brands.forEach(function (b) { b.series.forEach(function (s) { have[norm((BRAND_NAME[b.id] || b.name) + s.name)] = 1; }); });
    /* แถวสเปกของรุ่นที่เลิกขายแล้ว (ยกเว้น Defender ที่ร้านเพิ่มเอง) */
    K = K.split("\n").filter(function (l) {
      var m = /^\| (3M|Blaupunkt|Lunaray|WINCOS|Avery Dennison|LLumar|Hi-Kool|Lamina|V-KOOL|Solar Gard|Spectre|Xtra-Cole) ([^|(]+?)(?: \([^)]*\))? \| [0-9-]/.exec(l);
      return !m || have[norm(m[1] + m[2])];
    }).join("\n");
    K = K.replace(/Crystalline, Crystalline Black/g, "Crystalline Black");
    var a = K.indexOf("# ตารางรุ่นรถ → ไซส์"), b = K.indexOf("\n# ", a + 5);
    if (a >= 0 && b > a) {
      var sec = K.slice(a, b).split("\n"), body;
      if (list) body = list.map(function (c) { return carLine(cat, c); });
      else {
        var cs = cat.carSizes || {}, keys = [], byName = {};
        Object.keys(cs).forEach(function (br) { Object.keys(cs[br]).forEach(function (m) { keys.push([br, m]); byName[br + " " + m] = [br, m]; }); });
        var seen = {};
        body = sec.slice(3).filter(function (l) { return / = /.test(l); }).map(function (l) {
          var mm = /^(.+?) = (\w+)\/(\w+)\/([\w|]+)/.exec(l); if (!mm) return l;
          var hit = byName[mm[1]];
          if (!hit) return mm[1] + " = " + mm[2] + "/" + mm[3] + "/" + mm[4];
          seen[mm[1]] = 1;
          var c = fixCar(cat, { b: hit[0], m: hit[1], w: mm[2], p: mm[3], t: mm[4] });
          return carLine(cat, c);
        });
        keys.forEach(function (k) { if (seen[k[0] + " " + k[1]] || !GUESS[cs[k[0]][k[1]]]) return; var c = { b: k[0], m: k[1], t: cs[k[0]][k[1]] }; var g = GUESS[c.t]; c.w = g[0]; c.p = g[1]; fixCar(cat, c); body.push(carLine(cat, c)); });
        body = body.filter(function (l) { return !/^อื่น ๆ/.test(l); }).concat(body.filter(function (l) { return /^อื่น ๆ/.test(l); }));
      }
      var headr = "# ตารางรุ่นรถ → ไซส์ (" + body.length + " รุ่น)\nรูปแบบ: ยี่ห้อ รุ่น = ไซส์ล้าง-ขัด-เคลือบเซรามิค / ไซส์ฟิล์มกันรอย / ไซส์ฟิล์มกรองแสง (วงเล็บท้ายบรรทัด = ไซส์เฉพาะยี่ห้อฟิล์มนั้น)\n" + sec[2];
      K = K.slice(0, a) + headr + "\n" + body.join("\n") + "\n" + K.slice(b);
    }
    return K;
  }

  var api = { SIZES: SIZES, tk: tk, seriesIds: seriesIds, tintdb: tintdb, prices: prices, cars: cars, kb: kb };
  G.TintMap = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
