// Megadede — plugin SkyStream (port del provider de CloudStream)
// Fuentes: Embed69 (PoW + AES) -> Vidhide / Streamwish / Voe (ALTCHA), cada una en LAT / SUB / ESP.
(function () {
  "use strict";

  const UA =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  // false = load() no baja la página de cada episodio (mucho más rápido en SkyStream).
  const FETCH_EPISODE_METADATA = false;

  // Tiempo máximo (ms) que le damos a resolver Voe por link (ALTCHA en JS puro es lento).
  const VOE_TIMEOUT_MS = 35000;
  // Si loadStreams ya lleva más de esto, no arrancamos otro Voe.
  const VOE_START_LIMIT_MS = 50000;

  const VOE_SEPARATORS = ["@$", "^^", "~@", "%?", "*~", "!!", "#&"];

  function baseUrl() {
    let b = "https://megadede.mobi";
    try {
      if (typeof manifest !== "undefined" && manifest && manifest.baseUrl) b = manifest.baseUrl;
    } catch (e) {}
    return b.replace(/\/+$/, "");
  }

  // ======================================================================
  //  UTILIDADES
  // ======================================================================

  function absoluteUrl(u) {
    const v = String(u || "").trim();
    if (/^https?:\/\//i.test(v)) return v;
    if (v.startsWith("//")) return "https:" + v;
    return v.startsWith("/") ? baseUrl() + v : baseUrl() + "/" + v;
  }

  function originOf(u) {
    const m = /^(https?:\/\/[^\/?#]+)/i.exec(String(u || ""));
    return m ? m[1] : "";
  }

  function cleanHtml(s) {
    return String(s || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&#0*39;|&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  }

  function statusOf(r) {
    const s = Number(r && (r.statusCode || r.status || r.code));
    return isNaN(s) ? 0 : s;
  }
  function isOk(r) {
    const s = statusOf(r);
    return s >= 200 && s < 300;
  }

  function sleep0() {
    return new Promise((res) => {
      try {
        setTimeout(res, 0);
      } catch (e) {
        res();
      }
    });
  }

  function getHeader(headers, name) {
    if (!headers) return undefined;
    const low = name.toLowerCase();
    for (const k of Object.keys(headers)) if (k.toLowerCase() === low) return headers[k];
    return undefined;
  }

  // set-cookie puede venir como lista o como string -> "a=1; b=2"
  function cookieHeaderFrom(headers) {
    let raw = getHeader(headers, "set-cookie");
    if (!raw) return "";
    let parts = Array.isArray(raw) ? raw : String(raw).split(/,(?=\s*[^;,\s]+=)/);
    const jar = {};
    for (const p of parts) {
      const first = String(p).split(";")[0].trim();
      const i = first.indexOf("=");
      if (i > 0) jar[first.slice(0, i)] = first.slice(i + 1);
    }
    return Object.keys(jar)
      .map((k) => k + "=" + jar[k])
      .join("; ");
  }

  // ---------- bytes / utf8 / base64 ----------

  function utf8Encode(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
        const d = str.charCodeAt(i + 1);
        if (d >= 0xdc00 && d < 0xe000) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
        }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return Uint8Array.from(out);
  }

  function utf8Decode(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; ) {
      const b = bytes[i++];
      let c;
      if (b < 0x80) c = b;
      else if (b < 0xe0) c = ((b & 31) << 6) | (bytes[i++] & 63);
      else if (b < 0xf0) {
        c = ((b & 15) << 12) | ((bytes[i] & 63) << 6) | (bytes[i + 1] & 63);
        i += 2;
      } else {
        c =
          ((b & 7) << 18) | ((bytes[i] & 63) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63);
        i += 3;
      }
      if (c >= 0x10000) {
        c -= 0x10000;
        s += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 1023));
      } else s += String.fromCharCode(c);
    }
    return s;
  }

  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const B64_REV = (function () {
    const m = {};
    for (let i = 0; i < 64; i++) m[B64[i]] = i;
    m["-"] = 62;
    m["_"] = 63;
    return m;
  })();

  function b64Decode(str) {
    const s = String(str).replace(/[^A-Za-z0-9+\/\-_]/g, "");
    const out = [];
    let buf = 0,
      bits = 0;
    for (let i = 0; i < s.length; i++) {
      buf = (buf << 6) | B64_REV[s[i]];
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((buf >> bits) & 255);
      }
    }
    return Uint8Array.from(out);
  }

  function b64Encode(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i],
        b = bytes[i + 1],
        c = bytes[i + 2];
      s += B64[a >> 2] + B64[((a & 3) << 4) | ((b || 0) >> 4)];
      s += i + 1 < bytes.length ? B64[((b & 15) << 2) | ((c || 0) >> 6)] : "=";
      s += i + 2 < bytes.length ? B64[c & 63] : "=";
    }
    return s;
  }

  function hexToBytes(h) {
    const out = new Uint8Array(h.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }

  function bytesToHex(b) {
    let s = "";
    for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return s;
  }

  // ======================================================================
  //  SHA-256 / HMAC / PBKDF2 en JS puro (para PoW de Embed69 y ALTCHA de Voe)
  // ======================================================================

  const K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const IV = new Int32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Int32Array(64);

  function compress(S) {
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15],
        y = W[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = S[0],
      b = S[1],
      c = S[2],
      d = S[3],
      e = S[4],
      f = S[5],
      g = S[6],
      h = S[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    S[0] = (S[0] + a) | 0;
    S[1] = (S[1] + b) | 0;
    S[2] = (S[2] + c) | 0;
    S[3] = (S[3] + d) | 0;
    S[4] = (S[4] + e) | 0;
    S[5] = (S[5] + f) | 0;
    S[6] = (S[6] + g) | 0;
    S[7] = (S[7] + h) | 0;
  }

  // Procesa `bytes` (con padding) sobre el estado S. prefixLen = bytes ya consumidos antes (p.ej. 64 del ipad).
  function shaRun(S, bytes, prefixLen) {
    const n = bytes.length;
    const total = Math.ceil((n + 9) / 64) * 64;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[n] = 0x80;
    const bitLen = (prefixLen + n) * 8;
    const hi = Math.floor(bitLen / 4294967296);
    const lo = bitLen >>> 0;
    buf[total - 8] = hi >>> 24;
    buf[total - 7] = (hi >>> 16) & 255;
    buf[total - 6] = (hi >>> 8) & 255;
    buf[total - 5] = hi & 255;
    buf[total - 4] = lo >>> 24;
    buf[total - 3] = (lo >>> 16) & 255;
    buf[total - 2] = (lo >>> 8) & 255;
    buf[total - 1] = lo & 255;
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4;
        W[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
      }
      compress(S);
    }
  }

  function stateToBytes(S) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out[i * 4] = S[i] >>> 24;
      out[i * 4 + 1] = (S[i] >>> 16) & 255;
      out[i * 4 + 2] = (S[i] >>> 8) & 255;
      out[i * 4 + 3] = S[i] & 255;
    }
    return out;
  }

  function sha256(bytes) {
    const S = new Int32Array(IV);
    shaRun(S, bytes, 0);
    return stateToBytes(S);
  }

  // Estados intermedios de HMAC (ipad/opad) para una clave dada.
  function hmacStates(key) {
    if (key.length > 64) key = sha256(key);
    const ip = new Int32Array(IV),
      op = new Int32Array(IV);
    const kb = new Uint8Array(64);
    kb.set(key);
    for (let pass = 0; pass < 2; pass++) {
      const S = pass === 0 ? ip : op;
      const x = pass === 0 ? 0x36 : 0x5c;
      for (let i = 0; i < 16; i++) {
        const j = i * 4;
        W[i] =
          ((kb[j] ^ x) << 24) | ((kb[j + 1] ^ x) << 16) | ((kb[j + 2] ^ x) << 8) | (kb[j + 3] ^ x);
      }
      compress(S);
    }
    return { ip, op };
  }

  function hmacWith(st, msg) {
    const S = new Int32Array(st.ip);
    shaRun(S, msg, 64);
    const inner = stateToBytes(S);
    const S2 = new Int32Array(st.op);
    shaRun(S2, inner, 64);
    return stateToBytes(S2);
  }

  // PBKDF2-HMAC-SHA256 (loop rápido: 2 compresiones por iteración, todo en palabras Int32)
  function pbkdf2Sha256(password, salt, iterations, keyLength) {
    const st = hmacStates(password);
    const blockCount = Math.ceil(keyLength / 32);
    const out = new Uint8Array(blockCount * 32);
    const S = new Int32Array(8);
    const t = new Int32Array(8);
    const u = new Int32Array(8);

    for (let block = 1; block <= blockCount; block++) {
      const msg = new Uint8Array(salt.length + 4);
      msg.set(salt);
      msg[salt.length] = block >>> 24;
      msg[salt.length + 1] = (block >>> 16) & 255;
      msg[salt.length + 2] = (block >>> 8) & 255;
      msg[salt.length + 3] = block & 255;
      const u1 = hmacWith(st, msg);
      for (let i = 0; i < 8; i++) {
        const j = i * 4;
        u[i] = (u1[j] << 24) | (u1[j + 1] << 16) | (u1[j + 2] << 8) | u1[j + 3];
        t[i] = u[i];
      }
      for (let it = 1; it < iterations; it++) {
        // interno
        S.set(st.ip);
        for (let i = 0; i < 8; i++) W[i] = u[i];
        W[8] = 0x80000000 | 0;
        W[9] = W[10] = W[11] = W[12] = W[13] = W[14] = 0;
        W[15] = 768; // (64 + 32) * 8
        compress(S);
        // externo
        for (let i = 0; i < 8; i++) {
          W[i] = S[i];
        }
        W[8] = 0x80000000 | 0;
        W[9] = W[10] = W[11] = W[12] = W[13] = W[14] = 0;
        W[15] = 768;
        S.set(st.op);
        compress(S);
        for (let i = 0; i < 8; i++) {
          u[i] = S[i];
          t[i] ^= S[i];
        }
      }
      const tb = stateToBytes(t);
      out.set(tb, (block - 1) * 32);
    }
    return out.subarray(0, keyLength);
  }

  // ======================================================================
  //  HOME / SEARCH / LOAD
  // ======================================================================

  const RX_ARTICLE = /<article[^>]*class=["'][^"']*mv[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi;

  function typeFromUrl(u) {
    if (u.indexOf("/anime/") >= 0) return "anime";
    if (u.indexOf("/serie/") >= 0) return "series";
    if (u.indexOf("/pelicula/") >= 0) return "movie";
    return null;
  }

  function parseCards(html, mode) {
    const results = [];
    const seen = {};
    let m;
    RX_ARTICLE.lastIndex = 0;
    while ((m = RX_ARTICLE.exec(html)) !== null) {
      const article = m[1];
      let href, title, poster;

      if (mode === "home") {
        const h = /href=["']([^"']+)["']/i.exec(article);
        if (!h) continue;
        href = h[1];
        const hd = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(article);
        if (!hd) continue;
        title = cleanHtml(hd[1]);
        const im = /<img[^>]+(?:src|data-src)=["']([^"']+)["']/i.exec(article);
        poster = im ? im[1] : "";
      } else {
        const h = /href=["']([^"']+)["']/i.exec(article);
        if (!h) continue;
        href = h[1];
        const img = /<img[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*>/i.exec(article);
        poster = img ? img[1] : "";
        const alt = img ? /alt=["']([^"']+)["']/i.exec(img[0]) : null;
        const ttl = img ? /title=["']([^"']+)["']/i.exec(img[0]) : null;
        title = cleanHtml((ttl && ttl[1]) || (alt && alt[1]) || "")
          .replace(/^Ver\s+/i, "")
          .replace(/\s+-\s+Ver online.*$/i, "")
          .replace(/\s+\(\d{4}\)\s+online.*$/i, "")
          .trim();
      }

      const abs = absoluteUrl(href);
      const type = typeFromUrl(abs);
      if (!type || !title || seen[abs]) continue;
      seen[abs] = true;

      results.push(
        new MultimediaItem({
          title: title,
          url: abs,
          posterUrl: poster ? absoluteUrl(poster) : "",
          type: type,
        })
      );
    }
    return results;
  }

  async function fetchPage(url, extraHeaders) {
    const headers = Object.assign({ Referer: baseUrl() + "/" }, extraHeaders || {});
    return await http_get(url, headers);
  }

  async function getHome(cb) {
    try {
      const cats = [
        { name: "Películas", path: "/peliculas", type: "movie" },
        { name: "Series", path: "/series", type: "series" },
        { name: "Animes", path: "/animes", type: "anime" },
      ];
      const requests = [];
      for (const cat of cats) {
        for (let page = 1; page <= 5; page++) requests.push({ cat, url: baseUrl() + cat.path + "?page=" + page });
      }
      const responses = await Promise.all(requests.map((q) => fetchPage(q.url).catch(() => null)));
      const data = { "Películas": [], "Series": [], "Animes": [] };
      const seen = { "Películas": {}, "Series": {}, "Animes": {} };
      for (let i = 0; i < requests.length; i++) {
        const r = responses[i];
        if (!r || !isOk(r)) continue;
        const category = requests[i].cat.name;
        for (const item of parseCards(r.body || "", "home")) {
          if (!item.url || seen[category][item.url]) continue;
          item.type = requests[i].cat.type;
          seen[category][item.url] = true;
          data[category].push(item);
        }
      }
      cb({ success: true, data: data });
    } catch (e) {
      cb({ success: false, errorCode: "HOME_ERROR", message: String((e && e.message) || e) });
    }
  }

  async function search(query, cb) {
    try {
      const r = await fetchPage(baseUrl() + "/search?s=" + encodeURIComponent(query));
      if (!isOk(r)) {
        cb({ success: true, data: [] });
        return;
      }
      cb({ success: true, data: parseCards(r.body || "", "search") });
    } catch (e) {
      cb({ success: false, errorCode: "SEARCH_ERROR", message: String((e && e.message) || e) });
    }
  }

  async function load(url, cb) {
    try {
      url = absoluteUrl(url);
      const r = await fetchPage(url);
      if (!isOk(r)) {
        cb({ success: false, errorCode: "HTTP_" + statusOf(r), message: "HTTP " + statusOf(r) });
        return;
      }
      const html = r.body || "";

      const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
      const title = h1 ? cleanHtml(h1[1]) : "Megadede";
      const og = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html);
      const poster = og ? og[1] : "";
      const ym = /\b(?:19|20)\d{2}\b/.exec(html);
      const year = ym ? parseInt(ym[0], 10) : undefined;

      let description = "";
      const md = /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i.exec(
        html
      );
      if (md) description = cleanHtml(md[1]);
      if (!description) {
        const h2 = /<h2[^>]*class=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i.exec(html);
        if (h2) description = cleanHtml(h2[1]);
      }

      const isAnime = url.indexOf("/anime/") >= 0;
      const isSerie = url.indexOf("/serie/") >= 0;

      if (isAnime || isSerie) {
        const rx = /href\s*=\s*["']([^"']*\/temporada\/(\d+)\/capitulo\/(\d+)[^"']*)["']/gi;
        const seen = {};
        const found = [];
        let m;
        while ((m = rx.exec(html)) !== null) {
          const epUrl = absoluteUrl(m[1]);
          if (seen[epUrl]) continue;
          seen[epUrl] = true;
          found.push({ url: epUrl, season: parseInt(m[2], 10), episode: parseInt(m[3], 10) });
        }
        found.sort((a, b) => a.season - b.season || a.episode - b.episode);

        const fetchMeta = FETCH_EPISODE_METADATA && found.length <= 30;
        const episodes = await Promise.all(
          found.map(async (f) => {
            let epPoster = poster;
            let epDesc = "";
            if (fetchMeta) {
              try {
                const er = await fetchPage(f.url);
                const eh = er.body || "";
                const eo = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(eh);
                if (eo) epPoster = eo[1];
                const ed = /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i.exec(
                  eh
                );
                if (ed) {
                  const t = cleanHtml(ed[1]);
                  if (t && !/^No se encontr[óo] una sinopsis/i.test(t)) epDesc = t;
                }
              } catch (e) {}
            }
            return new Episode({
              name: "Episodio " + f.episode,
              url: f.url,
              season: f.season,
              episode: f.episode,
              posterUrl: epPoster,
              description: epDesc,
            });
          })
        );

        cb({
          success: true,
          data: new MultimediaItem({
            title: title,
            url: url,
            posterUrl: poster,
            type: isAnime ? "anime" : "series",
            year: year,
            description: description,
            episodes: episodes,
          }),
        });
        return;
      }

      // SkyStream deshabilita Play si una película no tiene episodios.
      // La película es un único destino reproducible: usamos su propia URL
      // como episodio sintético para que el launcher invoque loadStreams(url).
      cb({
        success: true,
        data: new MultimediaItem({
          title: title,
          url: url,
          posterUrl: poster,
          type: "movie",
          year: year,
          description: description,
          episodes: [
            new Episode({
              name: "Película",
              url: url,
              season: 1,
              episode: 1,
            }),
          ],
        }),
      });
    } catch (e) {
      cb({ success: false, errorCode: "LOAD_ERROR", message: String((e && e.message) || e) });
    }
  }

  // ======================================================================
  //  EMBED69
  // ======================================================================

  async function extractEmbed69Links(vidUrl) {
    const r = await fetchPage(vidUrl);
    if (!isOk(r)) return [];
    const html = r.body || "";

    const ch = /POW_CHALLENGE\s*=\s*['"]([^'"]+)['"]/i.exec(html);
    const sa = /POW_SALT\s*=\s*['"]([^'"]+)['"]/i.exec(html);
    const di = /POW_DIFFICULTY\s*=\s*(\d+)/i.exec(html);
    const dl = /let\s+dataLink\s*=\s*(\[[\s\S]*?\]);/i.exec(html);
    if (!ch || !sa || !dl) return [];
    const challenge = ch[1];
    const salt = sa[1];
    const difficulty = di ? parseInt(di[1], 10) : 3;

    // PoW: sha256(challenge + nonce) con `difficulty` nibbles hex en cero.
    const chBytes = utf8Encode(challenge);
    let nonce = 0;
    for (;; nonce++) {
      const nb = utf8Encode(String(nonce));
      const msg = new Uint8Array(chBytes.length + nb.length);
      msg.set(chBytes);
      msg.set(nb, chBytes.length);
      const d = sha256(msg);
      let okPow = true;
      for (let i = 0; i < difficulty; i++) {
        const nib = i % 2 === 0 ? d[i >> 1] >>> 4 : d[i >> 1] & 15;
        if (nib !== 0) {
          okPow = false;
          break;
        }
      }
      if (okPow) break;
      if ((nonce & 1023) === 1023) await sleep0();
      if (nonce > 50000000) throw new Error("Embed69 PoW sin solución");
    }

    const key = sha256(utf8Encode(challenge + nonce + salt));
    const keyB64 = b64Encode(key);

    const arr = JSON.parse(dl[1]);
    const results = [];
    const seen = {};
    for (const item of arr) {
      const language = String(item.video_language || "UNK").toUpperCase();
      const embeds = item.sortedEmbeds || [];
      for (const emb of embeds) {
        const serverName = String(emb.servername || "");
        const enc = String(emb.link || "");
        if (!serverName || !enc) continue;
        const k = serverName.toLowerCase() + "|" + language;
        if (seen[k]) continue;
        seen[k] = true;
        try {
          const raw = b64Decode(enc);
          const iv = raw.subarray(0, 16);
          const ct = raw.subarray(16);
          const plain = await crypto.decryptAES(b64Encode(ct), keyB64, b64Encode(iv));
          results.push({ server: serverName, language: language, url: String(plain).trim() });
        } catch (e) {
          console.log("Embed69: no se pudo descifrar " + serverName + "/" + language + ": " + e);
        }
      }
    }
    return results;
  }

  // ======================================================================
  //  P.A.C.K.E.R. (Vidhide / Streamwish)
  // ======================================================================

  function unpackPacker(packed, base, dict) {
    return packed.replace(/\b\w+\b/g, function (token) {
      if (token.length > 1 && token[0] === "0") return token;
      let value = 0;
      for (let i = 0; i < token.length; i++) {
        const ch = token[i];
        let digit;
        if (ch >= "0" && ch <= "9") digit = ch.charCodeAt(0) - 48;
        else if (ch >= "a" && ch <= "z") digit = ch.charCodeAt(0) - 97 + 10;
        else return token;
        if (digit >= base) return token;
        value = value * base + digit;
        if (value >= dict.length) return token;
      }
      const w = dict[value];
      return w ? w : token;
    });
  }

  const RX_PACKED = /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)\)\)/;

  function unpackAll(html) {
    try {
      if (typeof getAndUnpack === "function") {
        const nativeResult = getAndUnpack(html);
        if (nativeResult && String(nativeResult) !== String(html)) return String(nativeResult);
      }
    } catch (e) {}
    const m = RX_PACKED.exec(html);
    if (!m) return null;
    try { return unpackPacker(m[1], parseInt(m[2], 10), m[4].split("|")); }
    catch (e) { return null; }
  }

  function resolveRel(u, pageUrl, fallbackOrigin) {
    u = String(u).replace(/\\\//g, "/").replace(/\\u0026/g, "&");
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith("//")) return "https:" + u;
    return (fallbackOrigin || originOf(pageUrl)) + (u.startsWith("/") ? "" : "/") + u;
  }

  function isMasterUrl(u) {
    const clean = String(u || "").split("#")[0].split("?")[0].toLowerCase();
    const last = clean.split("/").pop() || "";
    return /(?:master|playlist|index|hls)(?:[-_.]?(?:auto|main|source|all|adaptive))?\.(?:m3u8|txt)$/.test(last);
  }

  function hlsCandidates(hay) {
    const out = [];
    const seen = new Set();
    const add = (value) => {
      let u = String(value || "").trim()
        .replace(/\\\//g, "/")
        .replace(/\\u0026/g, "&")
        .replace(/&amp;/g, "&")
        .replace(/^['"]|['"]$/g, "");
      if (!u || !/\.m3u8(?:[?#]|$)|\.txt(?:[?#]|$)/i.test(u)) return;
      if (!/^https?:\/\//i.test(u) && !u.startsWith("//") && !u.startsWith("/")) return;
      if (!seen.has(u)) { seen.add(u); out.push(u); }
    };

    const normalized = String(hay || "").replace(/\\\//g, "/").replace(/\\u0026/g, "&");
    const keyRx = /["'](?:hls4|hls2|hls3|master|playlist|m3u8|hls|file|source|src|url|link|video_url)["']\s*:\s*["']([^"']+)["']/gi;
    let m;
    while ((m = keyRx.exec(normalized)) !== null) add(m[1]);

    const urlRx = /(?:https?:\/\/|\/\/|\/)[^"'\s<>\\]+/gi;
    while ((m = urlRx.exec(normalized)) !== null) add(m[0]);

    const fileRx = /(?:file|src|source|hls|playlist)\s*[:=]\s*["']([^"']+)["']/gi;
    while ((m = fileRx.exec(normalized)) !== null) add(m[1]);
    return out;
  }

  // Devuelve { url, referer } o null. Busca el master aunque no se llame master.m3u8.
  async function extractPackedHls(embedUrl, kind) {
    const r = await http_get(embedUrl, { "User-Agent": UA, Referer: baseUrl() + "/" });
    if (!isOk(r)) {
      console.log(kind + ": HTTP " + statusOf(r));
      return null;
    }
    const body = r.body || "";
    const finalUrl = r.finalUrl || embedUrl;
    const unpacked = unpackAll(body);
    const hay = (unpacked || "") + "\n" + body;
    const fallbackOrigin = kind === "Vidhide" ? "https://morencius.com" : originOf(finalUrl);
    const candidates = hlsCandidates(hay).map((u) => resolveRel(u, finalUrl, fallbackOrigin));
    const urls = candidates.filter((u, i, a) => /^https?:\/\//i.test(u) && a.indexOf(u) === i);
    if (!urls.length) {
      console.log(kind + ": no se encontró HLS");
      return null;
    }

    const ranked = urls.slice().sort((a, b) => {
      const score = (u) => {
        let n = 0;
        if (isMasterUrl(u)) n += 8;
        if (/master|playlist|index|hls|auto|adaptive/i.test(u)) n += 4;
        if (/1080|720|480|360|\d{3,4}p/i.test(u)) n -= 5;
        if (/\.txt(?:\?|$)/i.test(u)) n -= 1;
        return n;
      };
      return score(b) - score(a);
    });

    // Verifica si algún candidato es una playlist master real, aunque tenga nombre aleatorio.
    for (const candidate of ranked.slice(0, 5)) {
      try {
        const pr = await http_get(candidate, { "User-Agent": UA, Referer: finalUrl });
        const text = String(pr && pr.body || "");
        if (isOk(pr) && /#EXTM3U/i.test(text) && /#EXT-X-STREAM-INF/i.test(text)) {
          return { url: candidate, referer: finalUrl };
        }
      } catch (e) {}
    }

    return { url: ranked[0], referer: finalUrl };
  }

  // ======================================================================
  //  VOE
  // ======================================================================

  function rot13(s) {
    return s.replace(/[a-zA-Z]/g, function (c) {
      const b = c <= "Z" ? 65 : 97;
      return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
    });
  }

  function decodeVoeConfig(encoded) {
    try {
      let v = rot13(encoded);
      for (const sep of VOE_SEPARATORS) v = v.split(sep).join("_");
      v = v.split("_").join("");
      const bytes = b64Decode(v);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (bytes[i] - 3) & 255;
      bytes.reverse();
      const inner = utf8Decode(bytes);
      return utf8Decode(b64Decode(inner));
    } catch (e) {
      console.log("Voe decode ERROR: " + e);
      return null;
    }
  }

  let voeChain = Promise.resolve();
  function voeSerial(fn) {
    const p = voeChain.then(fn, fn);
    voeChain = p.catch(() => {});
    return p;
  }

  async function solveAltcha(ch, deadline) {
    const saltBytes = hexToBytes(ch.salt);
    const nonceBytes = hexToBytes(ch.nonce);
    const password = new Uint8Array(nonceBytes.length + 4);
    password.set(nonceBytes);
    const off = nonceBytes.length;
    const t0 = Date.now();
    for (let counter = 0; counter < 1000000; counter++) {
      password[off] = (counter >>> 24) & 255;
      password[off + 1] = (counter >>> 16) & 255;
      password[off + 2] = (counter >>> 8) & 255;
      password[off + 3] = counter & 255;
      const derived = pbkdf2Sha256(password, saltBytes, ch.cost, ch.keyLength);
      const hex = bytesToHex(derived);
      if (hex.startsWith(ch.keyPrefix.toLowerCase())) {
        return { counter: counter, derivedKey: hex, time: Date.now() - t0 };
      }
      if (counter % 4 === 3) {
        if (Date.now() > deadline) return null;
        await sleep0();
      }
    }
    return null;
  }

  async function extractVoeLink(embedUrl) {
    const deadline = Date.now() + VOE_TIMEOUT_MS;
    const uaH = { "User-Agent": UA };
    const first = await http_get(embedUrl, uaH);
    if (!isOk(first)) return null;

    const rd = /window\.location\.href\s*=\s*['"]([^'"]+\/e\/[^'"]+)['"]/.exec(first.body || "");
    const realUrl = rd ? rd[1] : embedUrl;
    const page = realUrl !== embedUrl ? await http_get(realUrl, uaH) : first;

    let html = page.body || "";
    let enc = /<script[^>]+type=["']application\/json["'][^>]*>\s*(?:\[\s*)?["']([^"']+)["']/.exec(html);
    let encoded = enc ? enc[1] : null;

    if (!encoded) {
      const csrf = /name=["']_token["'][^>]+value=["']([^"']+)["']/.exec(html);
      const chUrl = /<altcha-widget[^>]+challenge=["']([^"']+)["']/.exec(html);
      if (!csrf || !chUrl) {
        console.log("Voe: no se encontró CSRF o challenge");
        return null;
      }
      const chRes = await http_get(chUrl[1].replace(/&amp;/g, "&"), {
        "User-Agent": UA,
        Referer: realUrl,
      });
      if (!isOk(chRes)) return null;
      const challengeText = (chRes.body || "").trim();
      const ch = JSON.parse(challengeText);
      if (!/^PBKDF2\/SHA-256$/i.test(String(ch.algorithm || ""))) {
        console.log("Voe ALTCHA: algoritmo no soportado " + ch.algorithm);
        return null;
      }

      const sol = await voeSerial(() => solveAltcha(ch, deadline));
      if (!sol) {
        console.log("Voe ALTCHA: PoW no resuelto a tiempo");
        return null;
      }
      const payload =
        '{"challenge":' +
        challengeText +
        ',"solution":{"counter":' +
        sol.counter +
        ',"derivedKey":"' +
        sol.derivedKey +
        '","time":' +
        sol.time +
        "}}";
      const payloadB64 = b64Encode(utf8Encode(payload));

      const cookie = cookieHeaderFrom(page.headers);
      const body =
        "_token=" +
        encodeURIComponent(csrf[1]) +
        "&access=0&altcha=" +
        encodeURIComponent(payloadB64);
      const headers = {
        "User-Agent": UA,
        Referer: realUrl,
        Origin: originOf(realUrl),
        "Content-Type": "application/x-www-form-urlencoded",
      };
      if (cookie) headers["Cookie"] = cookie;
      const post = await http_post(realUrl, headers, body);
      if (!isOk(post)) {
        console.log("Voe ALTCHA POST HTTP " + statusOf(post));
        return null;
      }
      html = post.body || "";
      const e2 = /<script[^>]+type=["']application\/json["'][^>]*>\s*\[\s*["']([^"']+)["']\s*\]\s*<\/script>/.exec(
        html
      );
      encoded = e2 ? e2[1] : null;
    }

    if (!encoded) {
      console.log("Voe: config JSON no encontrada");
      return null;
    }
    const decoded = decodeVoeConfig(encoded);
    if (!decoded) return null;
    const sm = /"source"\s*:\s*"([^"]+)"/.exec(decoded);
    if (!sm) return null;
    return { url: sm[1].replace(/\\\//g, "/").replace(/\\u0026/g, "&"), referer: realUrl };
  }

  // ======================================================================
  //  LOAD STREAMS
  // ======================================================================

  const LANG_LABEL = { LAT: "lat", SUB: "sub", ESP: "esp" };
  const LANG_ORDER = { LAT: 0, SUB: 1, ESP: 2 };

  function displayNameOf(server) {
    const s = server.toLowerCase();
    if (s === "vidhide") return "Vidhide";
    if (s === "streamwish") return "Streamwish";
    if (s === "voe") return "Voe";
    return server;
  }

  function makeStream(res, label) {
    return new StreamResult({
      url: res.url,
      source: label,
      quality: /\.m3u8|\.txt(\?|$)/i.test(res.url) ? "Auto" : 0,
      headers: { Referer: res.referer || "", "User-Agent": UA },
    });
  }

  // Resuelve un link de servidor concreto -> StreamResult | null
  async function resolveServer(serverName, language, realUrl, startedAt) {
    if (!realUrl) return null;
    const lang = LANG_LABEL[language] || String(language || "").toLowerCase();
    const display = displayNameOf(serverName);
    const label = display + (lang ? " " + lang : "");
    const low = String(serverName || "").toLowerCase();

    try {
      let res = null;
      if (/vidhide|filelions/i.test(low)) {
        res = await extractPackedHls(realUrl, "Vidhide");
      } else if (/^voe$|voe\.sx|voe\.to|voe-unblock/i.test(low)) {
        if (Date.now() - startedAt <= VOE_START_LIMIT_MS) res = await extractVoeLink(realUrl);
      } else if (/streamwish|strwish|awish/i.test(low)) {
        res = await extractPackedHls(realUrl, "Streamwish");
      }

      if (!res && typeof loadExtractor === "function") {
        try {
          const links = await loadExtractor(realUrl, baseUrl());
          if (links && links.length) {
            const pick = links.find((l) => isMasterUrl(l.url)) || links[0];
            res = { url: pick.url, referer: pick.referer || realUrl };
          }
        } catch (e) {}
      }
      return res ? makeStream(res, label) : null;
    } catch (e) {
      console.log("resolveServer " + label + ": " + e);
      return null;
    }
  }

  async function loadStreams(url, cb) {
    try {
      const startedAt = Date.now();
      const pageUrl = absoluteUrl(url);
      const r = await fetchPage(pageUrl);
      if (!isOk(r)) {
        cb({ success: false, errorCode: "HTTP_" + statusOf(r), message: "HTTP " + statusOf(r) });
        return;
      }
      const html = r.body || "";

      const servers = [];
      const addServer = (value) => {
        const raw = String(value || "").trim().replace(/&amp;/g, "&");
        if (!raw || /^(?:about:blank|javascript:|#)$/i.test(raw)) return;
        const u = absoluteUrl(raw);
        if (!/^https?:\/\//i.test(u)) return;
        if (!servers.includes(u)) servers.push(u);
      };
      const rx = /changeServer\(\s*['"]([^'"]+)['"]/gi;
      let m;
      while ((m = rx.exec(html)) !== null) addServer(m[1]);
      const iframeRx = /<(?:iframe|embed)\b[^>]*(?:src|data-src)\s*=\s*["']([^"']+)["'][^>]*>/gi;
      while ((m = iframeRx.exec(html)) !== null) addServer(m[1]);
      const dataUrlRx = /(?:data-src|data-embed|data-link)\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
      while ((m = dataUrlRx.exec(html)) !== null) addServer(m[1]);
      const directRx = /https?:\\?\/\\?\/[^\s"'<>\\]+/gi;
      while ((m = directRx.exec(html)) !== null) {
        const u = m[0].replace(/\\\//g, "/").replace(/&amp;/g, "&");
        if (/vidhide|filelions|streamwish|strwish|awish|voe\.sx|voe\.to|voe-unblock|\/vidurl\//i.test(u)) addServer(u);
      }

      const tasks = servers.map(async (server) => {
        if (/\/vidurl\//i.test(server)) {
          let links = [];
          try { links = await extractEmbed69Links(server); }
          catch (e) { console.log("Embed69 ERROR: " + e); }
          links.sort((a, b) => (LANG_ORDER[a.language] ?? 9) - (LANG_ORDER[b.language] ?? 9));
          const out = await Promise.all(links.map((l) => resolveServer(l.server, l.language, l.url, startedAt)));
          return out.filter(Boolean);
        }
        const lower = server.toLowerCase();
        let hostName = "";
        if (/vidhide|filelions/i.test(lower)) hostName = "Vidhide";
        else if (/streamwish|strwish|awish/i.test(lower)) hostName = "Streamwish";
        else if (/voe\.sx|voe\.to|voe-unblock/i.test(lower)) hostName = "Voe";
        if (hostName) {
          const resolved = await resolveServer(hostName, "", server, startedAt);
          if (resolved) return [resolved];
        }
        if (typeof loadExtractor === "function") {
          try {
            const links = await loadExtractor(server, pageUrl);
            return (links || []).map((l) => new StreamResult({
              url: l.url, source: l.name || l.source || "Servidor",
              quality: l.quality || "Auto",
              headers: Object.assign({ "User-Agent": UA }, l.referer ? { Referer: l.referer } : {}, l.headers || {}),
            }));
          } catch (e) { console.log("Extractor directo falló: " + e); }
        }
        return [];
      });

      const nested = await Promise.all(tasks);
      const streams = [];
      for (const group of nested) for (const s of group) streams.push(s);

      // Orden: LAT, SUB, ESP (conserva el orden de servidores dentro de cada idioma)
      const rank = (s) => {
        const mm = /\s(lat|sub|esp)$/.exec(s.source || "");
        return mm ? LANG_ORDER[mm[1].toUpperCase()] : 9;
      };
      streams.sort((a, b) => rank(a) - rank(b));

      cb({ success: true, data: streams });
    } catch (e) {
      cb({ success: false, errorCode: "STREAMS_ERROR", message: String((e && e.message) || e) });
    }
  }

  globalThis.getHome = getHome;
  globalThis.search = search;
  globalThis.load = load;
  globalThis.loadStreams = loadStreams;

  // Para tests en Node (en la app `module` no existe)
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      sha256,
      pbkdf2Sha256,
      decodeVoeConfig,
      unpackPacker,
      unpackAll,
      b64Decode,
      b64Encode,
      utf8Encode,
      utf8Decode,
      parseCards,
      extractEmbed69Links,
      extractVoeLink,
      extractPackedHls,
      hexToBytes,
      bytesToHex,
    };
  }
})();
