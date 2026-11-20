/* อัปเดตข้อมูลฟิล์มกรองแสงในแอปและ KB ให้ตรงเว็บ FilmPro
   ใช้: node tools/sync-tint.cjs [catalog.json]   (ไม่ใส่ไฟล์ = ดึงจาก https://film.karnet.org/api/catalog) */
const fs = require("fs"), path = require("path");
const TM = require("../public/tintmap.js");
const ROOT = path.join(__dirname, "..");
/* รถรุ่นใหม่จากเว็บ: ประเภทล้างรถ / ไซส์ฟิล์มใส ที่ร้านกำหนด (นอกนั้นเดาจากไซส์ฟิล์มกรองแสง) */
const NEW_CARS = {
  "Audi|A6 e-tron": ["SEDAN", "L"], "BYD|Seal 6": ["SEDAN", "L"], "BYD|T3": ["MPV", "XL"], "Honda|Super-ONE": ["SEDAN", "S"],
  "Kia|PV5": ["MPV", "XL"], "Mazda|CX-6e": ["SUV", "XL"], "Toyota|Hilux Travo-e": ["SUV", "XL", 1], "Denza|Z9 GT": ["SUV", "XL"],
  "Suzuki|e Vitara": ["SUV", "M"], "Wuling|Eksion": ["SUV", "L"], "Leapmotor|A10": ["SUV", "M"], "Leapmotor|B03X": ["SUV", "M"],
  "BAW|M8": ["MPV", "XL"], "Forthing|Friday": ["SUV", "L"], "Firefly|Firefly": ["SEDAN", "S"], "Seres|3": ["SUV", "L"],
  "smart|#1": ["SUV", "M"], "smart|#3": ["SUV", "M"], "smart|#5": ["SUV", "L"]
};
const RENAME = { "Mini|Pacman": "Paceman" };
(async () => {
  const cat = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], "utf8")) : await (await fetch("https://film.karnet.org/api/catalog")).json();
  const f = path.join(ROOT, "public/index.html");
  const L = fs.readFileSync(f, "utf8").split("\n");
  const at = (pre) => { const i = L.findIndex((l) => l.startsWith(pre)); if (i < 0) throw new Error("missing " + pre); return i; };
  const val = (i) => JSON.parse(L[i].slice(L[i].indexOf("=") + 1).replace(/;\s*$/, ""));
  const iC = at("var CARS="), iT = at("var TINTDB="), iP = at("var DEFAULT_PRICES=");
  const old = val(iT);
  const cars = val(iC);
  cars.forEach((c) => { const r = RENAME[c.b + "|" + c.m]; if (r) c.m = r; });
  const before = cars.length;
  TM.cars(cat, cars);
  cars.slice(before).forEach((c) => { const n = NEW_CARS[c.b + "|" + c.m]; if (n) { c.w = n[0]; c.p = n[1]; c.k = n[2] || 0; } });
  /* "อื่น ๆ" ไว้ท้ายสุด แล้วเรียงตามยี่ห้อ/รุ่น */
  const other = cars.filter((c) => c.b === "อื่น ๆ"), rest = cars.filter((c) => c.b !== "อื่น ๆ").sort((a, b) => (a.b + " " + a.m).localeCompare(b.b + " " + b.m));
  const all = rest.concat(other);
  const db = TM.tintdb(cat, old);
  const tp = TM.prices(cat, db);
  const P = val(iP); Object.keys(P).forEach((k) => { if (/^tint_/.test(k)) delete P[k]; }); Object.assign(P, tp);
  L[iC] = "var CARS=" + JSON.stringify(all) + ";";
  L[iT] = "var TINTDB=" + JSON.stringify(db) + ";";
  L[iP] = "var DEFAULT_PRICES=" + JSON.stringify(P) + ";";
  fs.writeFileSync(f, L.join("\n"));
  const kf = path.join(ROOT, "src/knowledge.js"), ks = fs.readFileSync(kf, "utf8");
  const m = /export const KB = (".*");\s*$/s.exec(ks);
  const KB = TM.kb(JSON.parse(m[1]), cat, all);
  fs.writeFileSync(kf, ks.slice(0, m.index) + "export const KB = " + JSON.stringify(KB) + ";\n");
  console.log("cars", before, "->", all.length, "| series", db.reduce((a, b) => a + b.s.length, 0), "| tint prices", Object.keys(tp).length, "| ov", all.filter((c) => c.ov).length);
})();
