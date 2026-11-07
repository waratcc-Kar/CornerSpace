/* ตัวเชื่อมแอป Corner Space กับ Firebase
   แอปเดิมเรียก window.claude.use("db"|"user"|"sample"|"downloads") ไฟล์นี้ทำหน้าที่แทนทั้งหมด
   พร้อมหน้าล็อกอินของพนักงาน */
(function () {
  var cfg = window.CS_CONFIG || {};
  var fb = window.firebase;
  var gate = document.createElement("div");
  gate.id = "csGate";
  gate.style.cssText = "position:fixed;inset:0;z-index:99999;background:#0b0b0b;color:#fff;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,sans-serif";
  gate.innerHTML = '<form id="csLogin" style="width:100%;max-width:340px;display:flex;flex-direction:column;gap:12px">' +
    '<div style="font-weight:800;font-size:1.4rem">Corner Space</div>' +
    '<div style="opacity:.75">เข้าสู่ระบบพนักงาน</div>' +
    '<input id="csEmail" type="email" autocomplete="username" placeholder="อีเมล" style="padding:12px;border-radius:10px;border:0;font-size:1rem">' +
    '<input id="csPass" type="password" autocomplete="current-password" placeholder="รหัสผ่าน" style="padding:12px;border-radius:10px;border:0;font-size:1rem">' +
    '<button style="padding:12px;border-radius:999px;border:0;background:#f0b93a;font-weight:700;font-size:1rem">เข้าสู่ระบบ</button>' +
    '<div id="csErr" style="color:#ff8a80;min-height:1.2em"></div></form>';
  document.addEventListener("DOMContentLoaded", function () { document.body.appendChild(gate); });

  var ready, resolveReady;
  ready = new Promise(function (r) { resolveReady = r; });
  var state = { db: null, user: null, access: { owners: [], staff: [] }, fn: null };

  if (!fb || !cfg.firebase || /ใส่ค่า|YOUR-PROJECT/.test(JSON.stringify(cfg.firebase))) {
    document.addEventListener("DOMContentLoaded", function () {
      gate.innerHTML = '<div style="max-width:340px">ยังไม่ได้ตั้งค่า Firebase ในไฟล์ public/config.js ดูขั้นตอนในคู่มือ SETUP.md</div>';
    });
  } else {
    fb.initializeApp(cfg.firebase);
    var auth = fb.auth(), db = fb.firestore();
    state.db = db;
    state.fn = fb.app().functions(cfg.region || "asia-southeast1");
    auth.onAuthStateChanged(function (u) {
      if (!u) { state.user = null; gate.style.display = "flex"; return; }
      db.doc("config/access").get().then(function (sn) {
        var a = sn.exists ? sn.data() : {};
        var em = String(u.email || "").toLowerCase();
        var lc = function (l) { return (l || []).map(function (x) { return String(x).toLowerCase(); }); };
        state.access = { owners: lc(a.owners), staff: lc(a.staff) };
        if (state.access.owners.indexOf(em) < 0 && state.access.staff.indexOf(em) < 0) {
          document.getElementById("csErr").textContent = "อีเมลนี้ยังไม่ได้รับสิทธิ์ ให้เจ้าของร้านเพิ่มอีเมลในระบบ";
          auth.signOut(); return;
        }
        state.user = u; gate.style.display = "none"; resolveReady();
      }).catch(function () {
        document.getElementById("csErr").textContent = "อ่านสิทธิ์ไม่ได้ ให้เจ้าของร้านตรวจ config/access และ Firestore rules";
        auth.signOut();
      });
    });
    document.addEventListener("submit", function (e) {
      if (e.target.id !== "csLogin") return;
      e.preventDefault();
      var er = document.getElementById("csErr"); er.textContent = "";
      auth.signInWithEmailAndPassword(document.getElementById("csEmail").value.trim(), document.getElementById("csPass").value)
        .catch(function () { er.textContent = "อีเมลหรือรหัสผ่านไม่ถูกต้อง"; });
    });
  }

  function isOwner() {
    return !!(state.user && state.access.owners.indexOf(String(state.user.email || "").toLowerCase()) >= 0);
  }

  /* ---- db: ใช้ Firestore ตรงๆ (หน้าตา API ตรงกับที่แอปเรียก) ---- */
  var dbApi = null;
  function dbShim() {
    if (dbApi) return dbApi;
    var d = state.db;
    dbApi = {
      collection: function (p) { return d.collection(p); },
      doc: function (p) {
        var ref = d.doc(p), keep = ref;
        keep.acquire = function () { return Promise.resolve({ acquired: true }); };
        return keep;
      }
    };
    /* collection().doc() ต้องมี acquire ด้วย (ใช้ตอนจองคิว) */
    var origCol = d.collection.bind(d);
    dbApi.collection = function (p) {
      var c = origCol(p), origDoc = c.doc.bind(c);
      c.doc = function (id) { var r = id ? origDoc(id) : origDoc(); r.acquire = function () { return Promise.resolve({ acquired: true }); }; return r; };
      return c;
    };
    return dbApi;
  }

  /* ---- sample: อ่านรูปผ่าน Cloud Function (คีย์ AI อยู่ฝั่งเซิร์ฟเวอร์) ---- */
  function blobToB64(b) {
    return new Promise(function (ok, no) {
      var r = new FileReader();
      r.onload = function () { ok(String(r.result).split(",")[1]); };
      r.onerror = no; r.readAsDataURL(b);
    });
  }
  function sampleShim() {
    var f = function () { return Promise.reject({ code: "unsupported" }); };
    f.limits = function () { return Promise.resolve({ images: { maxCount: 3 } }); };
    f.json = function (prompt, opts) {
      opts = opts || {};
      return Promise.all((opts.images || []).map(blobToB64)).then(function (imgs) {
        return state.fn.httpsCallable("readPhoto")({ prompt: prompt, images: imgs });
      }).then(function (res) {
        var d = res.data || {};
        if (d.json !== undefined) return d.json;
        throw { code: "invalid_json" };
      }).catch(function (e) {
        if (e && e.code === "functions/resource-exhausted") throw { code: "rate_limited" };
        throw e && e.code ? e : { code: "error" };
      });
    };
    return f;
  }

  function userShim() {
    return {
      isOwner: isOwner, canEdit: isOwner, can: function () { return true; },
      id: function () { return Promise.resolve(state.user.uid); },
      me: function () { return Promise.resolve({ id: state.user.uid, name: state.user.email }); }
    };
  }

  function downloadsShim() {
    return {
      save: function (o) {
        var blob = new Blob([o.data], { type: "text/csv;charset=utf-8" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = o.filename || "export.csv";
        document.body.appendChild(a); a.click(); a.remove();
        return Promise.resolve("saved");
      }
    };
  }

  window.claude = {
    use: function (name) {
      return ready.then(function () {
        if (name === "db") return dbShim();
        if (name === "user") return userShim();
        if (name === "sample") return sampleShim();
        if (name === "downloads") return downloadsShim();
        return null;
      });
    }
  };

  /* ---- LINE: ส่งข้อความเข้า LINE ของลูกค้าผ่าน Cloud Function ---- */
  window.csLine = {
    push: function (phone, text) {
      return ready.then(function () {
        return state.fn.httpsCallable("pushLine")({ phone: phone, text: text });
      }).then(function (r) { return r.data || {}; });
    }
  };
})();
