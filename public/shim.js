/* ตัวเชื่อมแอป Corner Space กับหลังบ้าน Cloudflare (Worker + D1)
   แอปเรียก window.claude.use("db"|"user"|"sample"|"downloads") ไฟล์นี้ทำหน้าที่แทนทั้งหมด
   ล็อกอินทำโดย Cloudflare Access ก่อนเข้าหน้านี้ */
(function () {
  var POLL_MS = 5000;
  var gate = document.createElement("div");
  gate.id = "csGate";
  gate.style.cssText = "position:fixed;inset:0;z-index:99999;background:#0b0b0b;color:#fff;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,sans-serif;text-align:center";
  gate.innerHTML = '<div style="max-width:340px"><div style="font-weight:800;font-size:1.4rem;margin-bottom:8px">Corner Space</div><div id="csMsg" style="opacity:.8">กำลังเข้าสู่ระบบ…</div></div>';
  document.addEventListener("DOMContentLoaded", function () { document.body.appendChild(gate); });
  function say(t, relogin) {
    var el = document.getElementById("csMsg"); if (!el) return;
    el.textContent = t;
    if (relogin) { var a = document.createElement("a"); a.href = "/"; a.textContent = "ลองอีกครั้ง"; a.style.cssText = "display:block;margin-top:14px;color:#f0b93a"; el.appendChild(a); }
  }

  function call(method, path, body) {
    var opt = { method: method, credentials: "same-origin", headers: {} };
    if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers["content-type"] = "application/json"; }
    return fetch(path, opt).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { /* ไม่ใช่ JSON */ }
        if (!r.ok) {
          var code = (j && j.error) || (r.status === 401 || r.status === 403 ? "unauthenticated" : "error");
          if (r.status === 429) code = "rate_limited";
          throw { code: code, status: r.status, message: j && j.message, diag: j && j.jwtHeader !== undefined ? "jwt=" + (j.jwtHeader ? 1 : 0) + " cookie=" + (j.accessCookie ? 1 : 0) + " host=" + j.host : "" };
        }
        return j;
      });
    });
  }

  var ready, resolveReady;
  ready = new Promise(function (r) { resolveReady = r; });
  var me = null;

  call("GET", "/api/me").then(function (m) {
    me = m; gate.style.display = "none"; resolveReady();
  }).catch(function (e) {
    var msg = e && e.message;
    if (e && e.status === 401) msg = "เซสชันหมดอายุ ให้โหลดหน้าใหม่เพื่อเข้าสู่ระบบอีกครั้ง";
    say(msg || "เชื่อมต่อระบบไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่", true);
    if (e && e.diag) { var d = document.createElement("div"); d.textContent = e.diag; d.style.cssText = "margin-top:18px;font-size:.75rem;opacity:.5"; document.getElementById("csMsg").appendChild(d); }
  });

  function isOwner() { return !!(me && me.owner); }

  /* ---- db: ทำท่าทางเหมือน Firestore ที่แอปเรียกใช้ (ข้อมูลอยู่ใน D1 อัปเดตด้วยการเช็คทุก 5 วินาที) ---- */
  var cache = {};        /* coll -> { id: data } */
  var subs = [];         /* { coll|doc, cb, kind } */
  var seq = 0, started = false, loaded = false, loadErr = null;

  function snapDoc(coll, id) { return { id: id, data: function () { return cache[coll][id]; } }; }
  function emit() {
    subs.forEach(function (s) {
      try {
        if (s.kind === "doc") {
          var d = cache[s.coll] && cache[s.coll][s.id];
          s.cb({ exists: d !== undefined, id: s.id, data: function () { return d; } });
        } else {
          var ids = Object.keys(cache[s.coll] || {});
          var docs = ids.map(function (id) { return snapDoc(s.coll, id); });
          if (s.order) {
            docs.sort(function (a, b) {
              var x = a.data()[s.order] || 0, y = b.data()[s.order] || 0;
              return s.dir === "desc" ? y - x : x - y;
            });
          }
          if (s.max) docs = docs.slice(0, s.max);
          s.cb({ docs: docs, size: docs.length, empty: !docs.length });
        }
      } catch (e) { console.error(e); }
    });
  }
  function emitErr(e) { subs.forEach(function (s) { if (s.err) try { s.err(e); } catch (x) { /* ข้าม */ } }); }

  function apply(res) {
    (res.changes || []).forEach(function (c) {
      var m = cache[c.c] || (cache[c.c] = {});
      if (c.data === null) delete m[c.id]; else m[c.id] = c.data;
    });
    seq = res.seq;
  }
  var running = null, again = false;
  function doSync() {
    return call("GET", "/api/sync?since=" + seq).then(function (res) {
      var changed = !loaded || (res.changes && res.changes.length);
      apply(res); loaded = true; loadErr = null;
      if (changed) emit();
    }).catch(function (e) {
      if (!loaded) { loadErr = e; emitErr(e); }
    });
  }
  /* เรียกซ้อนกันได้: ถ้ากำลังดึงอยู่ จะดึงรอบใหม่ต่อท้ายอีกหนึ่งรอบ เพื่อให้เห็นข้อมูลที่เพิ่งบันทึกแน่ๆ */
  function sync() {
    if (running) { again = true; return running; }
    running = doSync().then(function () {
      running = null;
      if (again) { again = false; return sync(); }
    });
    return running;
  }
  function start() {
    if (started) return; started = true;
    sync();
    setInterval(function () { if (!document.hidden) sync(); }, POLL_MS);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) sync(); });
  }
  function subscribe(s) {
    subs.push(s); start();
    if (loaded) setTimeout(emit, 0); else if (loadErr && s.err) setTimeout(function () { s.err(loadErr); }, 0);
    return function () { subs = subs.filter(function (x) { return x !== s; }); };
  }
  function localSet(coll, id, data) { (cache[coll] || (cache[coll] = {}))[id] = JSON.parse(JSON.stringify(data)); emit(); }

  function newId() {
    var a = new Uint8Array(10); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return (b % 36).toString(36); }).join("") + Date.now().toString(36);
  }
  function mapErr(e) { if (e && e.status === 409) throw { code: "taken" }; throw e; }

  function docRef(path) {
    var p = path.split("/"), coll = p[0], id = p[1];
    var ref = {
      id: id, path: path,
      get: function () {
        return call("GET", "/api/d/" + coll + "/" + encodeURIComponent(id)).then(function (r) {
          return { exists: !!r.exists, id: id, data: function () { return r.data || undefined; } };
        });
      },
      set: function (data) {
        return call("PUT", "/api/d/" + coll + "/" + encodeURIComponent(id), data).then(function () {
          /* รูปใหญ่ในใบงานถูกย้ายไปเก็บแยก ดึงค่าจริงจากเซิร์ฟเวอร์ให้แคชตรงกัน */
          return sync();
        }, mapErr);
      },
      update: function (patch) {
        return call("PATCH", "/api/d/" + coll + "/" + encodeURIComponent(id), patch).then(function () { return sync(); }, mapErr);
      },
      delete: function () {
        return call("DELETE", "/api/d/" + coll + "/" + encodeURIComponent(id)).then(function () {
          if (cache[coll]) delete cache[coll][id]; emit();
        });
      },
      onSnapshot: function (cb, err) { return subscribe({ kind: "doc", coll: coll, id: id, cb: cb, err: err }); },
      acquire: function () { return Promise.resolve({ acquired: true }); }   /* กันจองซ้ำทำที่เซิร์ฟเวอร์ */
    };
    return ref;
  }
  function query(coll, st) {
    return {
      orderBy: function (f, d) { return query(coll, { order: f, dir: d || "asc", max: st.max }); },
      limit: function (n) { return query(coll, { order: st.order, dir: st.dir, max: n }); },
      onSnapshot: function (cb, err) { return subscribe({ kind: "col", coll: coll, order: st.order, dir: st.dir, max: st.max, cb: cb, err: err }); },
      doc: function (id) { return docRef(coll + "/" + (id || newId())); }
    };
  }
  var dbApi = {
    collection: function (p) { return query(p, {}); },
    doc: function (p) { return docRef(p); }
  };

  /* ---- sample: อ่านรูปผ่าน Worker (คีย์ AI อยู่ฝั่งเซิร์ฟเวอร์) ---- */
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
        return call("POST", "/api/photo", { prompt: prompt, images: imgs });
      }).then(function (d) {
        if (d && d.json !== undefined && d.json !== null) return d.json;
        throw { code: "invalid_json" };
      }).catch(function (e) { throw e && e.code ? e : { code: "error" }; });
    };
    return f;
  }

  function userShim() {
    return {
      isOwner: isOwner, canEdit: isOwner, can: function () { return true; },
      id: function () { return Promise.resolve(me.email); },
      me: function () { return Promise.resolve({ id: me.email, name: me.email }); }
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
        if (name === "db") return dbApi;
        if (name === "user") return userShim();
        if (name === "sample") return sampleShim();
        if (name === "downloads") return downloadsShim();
        return null;
      });
    }
  };

  /* ---- LINE: ส่งข้อความเข้า LINE ของลูกค้าผ่าน Worker ---- */
  window.csLine = {
    push: function (phone, text) {
      return ready.then(function () { return call("POST", "/api/line/push", { phone: phone, text: text }); });
    }
  };
})();
