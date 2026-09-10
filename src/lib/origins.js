/*
 * Quick Edit — what will we touch?
 *
 * One place decides which documents Quick Edit is willing to edit, because the
 * answer is a security boundary and a correctness boundary at the same time,
 * and it needs to read the same in the service worker and in the popup.
 *
 * TWO KINDS
 * ---------
 *   'file'  a file:// document. The original bytes are on disk.
 *   'lan'   an http(s):// document served from this machine or this private
 *           network. The original bytes are whatever the server sends back.
 *
 * WHY ONLY PRIVATE ADDRESSES
 * --------------------------
 * Not squeamishness — the model genuinely stops working on the open web.
 *
 * Quick Edit's promise rests on re-fetching the document and getting back
 * exactly the bytes the browser parsed into the page you are looking at. That
 * holds for a static file server. It does not hold for anything that renders
 * per request: a second fetch returns a different document, the offsets
 * describe text that is not on screen, and the map is quietly wrong. (It fails
 * safe — mapping.js verifies every span against its node and simply refuses to
 * make unverified text editable — but a page where nothing is editable and no
 * one can say why is a bad experience.)
 *
 * Private addresses are where documents-served-as-files actually live: a NAS,
 * a `python -m http.server`, a static Express mount, a docs preview. Public
 * origins are overwhelmingly applications, not documents. Restricting to
 * private space also means the extension never needs standing host access to
 * anything on the internet, which keeps the permission story honest: activeTab
 * and nothing more.
 *
 * The path must still end in .html/.htm/.xhtml. An extensionless route is far
 * more likely to be an application than a document.
 */
(function (root) {
  'use strict';

  var HTML_PATH = /\.x?html?$/i;

  /*
   * Loopback, RFC1918 private space, link-local, IPv6 unique-local, mDNS .local
   * names — and the 100.64.0.0/10 shared-address range, which is where
   * Tailscale and other WireGuard meshes put their nodes. A machine reachable
   * over a private mesh is the same kind of machine as one on the LAN.
   */
  function isPrivateHost(hostname) {
    var h = (hostname || '').toLowerCase();

    // IPv6 arrives from URL.hostname wrapped in brackets.
    if (h.charAt(0) === '[') h = h.slice(1, -1);

    if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
    if (/\.localhost$/.test(h)) return true;
    if (/\.local$/.test(h)) return true;

    // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;

    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (!m) return false;
    var a = +m[1], b = +m[2], c = +m[3], d = +m[4];
    if (a > 255 || b > 255 || c > 255 || d > 255) return false;

    if (a === 127) return true;                        // loopback
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16
    if (a === 169 && b === 254) return true;           // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10, meshes
    return false;
  }

  /*
   * classify(url) -> { kind, host } | { kind: null, reason }
   *
   * `reason` is a code the popup turns into a sentence, so that "no" always
   * comes with a "because".
   */
  function classify(url) {
    var u;
    try { u = new URL(url); } catch (e) { return { kind: null, reason: 'unparseable' }; }

    if (u.protocol === 'file:') {
      if (!HTML_PATH.test(u.pathname)) return { kind: null, reason: 'not-html' };
      return { kind: 'file', host: '' };
    }

    if (u.protocol === 'http:' || u.protocol === 'https:') {
      if (!isPrivateHost(u.hostname)) return { kind: null, reason: 'public-origin' };
      if (!HTML_PATH.test(u.pathname)) return { kind: null, reason: 'not-html' };
      return { kind: 'lan', host: u.host };
    }

    return { kind: null, reason: 'unsupported-scheme' };
  }

  function isEditable(url) { return classify(url).kind !== null; }

  /*
   * Does an OPTIONS response say this resource implements PUT?
   *
   * `headers` is anything with a .get(name) — a fetch Response's Headers, or a
   * plain stand-in in a test.
   *
   * ONLY the Allow header counts. Access-Control-Allow-Methods is deliberately
   * ignored, and the distinction is the whole reason this function exists:
   *
   *   Allow                        RFC 9110 10.2.1 — the methods this resource
   *                                actually implements. A capability.
   *   Access-Control-Allow-Methods  which methods a CROSS-ORIGIN caller is
   *                                permitted to attempt. A policy, and one that
   *                                says nothing about whether they will work.
   *
   * The widely used `cors` middleware answers every OPTIONS with
   * "GET,HEAD,PUT,PATCH,POST,DELETE" by default. Reading that as a capability
   * makes every ordinary static file server look like it accepts write-backs,
   * and the first save 404s.
   */
  function acceptsWriteBack(headers) {
    if (!headers || typeof headers.get !== 'function') return false;
    return /(^|,)\s*PUT\s*(,|$)/i.test(headers.get('Allow') || '');
  }

  root.QuickEditOrigins = {
    classify: classify,
    isEditable: isEditable,
    isPrivateHost: isPrivateHost,
    acceptsWriteBack: acceptsWriteBack,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.QuickEditOrigins;
})(typeof self !== 'undefined' ? self : globalThis);
