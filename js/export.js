/*
 * Minimal, dependency-free writers for multi-image downloads:
 *   HWExport.zip(files)  -> Blob   (store-only ZIP; PNGs are already compressed)
 *   HWExport.pdf(count, getPage) -> Promise<Blob> (one grayscale image per page)
 */
(function (root) {
  'use strict';

  const enc = new TextEncoder();

  // ---- ZIP ----------------------------------------------------------------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // files: [{ name: string, data: Uint8Array }]
  function zip(files) {
    const parts = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint16(8, 0, true); // stored
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(local.buffer, name, f.data);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true);
      cen.setUint16(12, dosTime, true);
      cen.setUint16(14, dosDate, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, size, true);
      cen.setUint32(24, size, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      central.push(cen.buffer, name);

      offset += 30 + name.length + size;
    }

    let cenSize = 0;
    for (const c of central) cenSize += c.byteLength;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }

  // ---- PDF ----------------------------------------------------------------

  async function deflate(bytes) {
    // 'deflate' = zlib-wrapped, which is exactly what PDF /FlateDecode expects.
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /**
   * getPage(i) -> Promise<{ width, height, gray: Uint8Array|Uint8ClampedArray (w*h, 0..255) }>
   * Pages are requested one at a time so only one raw page is in memory.
   * Each page is sized so its long edge is 11in; images are stored losslessly.
   */
  async function pdf(count, getPage) {
    const canFlate = typeof CompressionStream !== 'undefined';
    const chunks = [];
    const offsets = [];
    let pos = 0;
    const push = (x) => {
      const b = typeof x === 'string' ? enc.encode(x) : x;
      chunks.push(b);
      pos += b.length;
    };
    const obj = (id, body, stream) => {
      offsets[id] = pos;
      push(`${id} 0 obj\n${body}`);
      if (stream) { push('\nstream\n'); push(stream); push('\nendstream'); }
      push('\nendobj\n');
    };

    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    // 1: catalog, 2: pages, then per page: page, image, content
    const pageIds = Array.from({ length: count }, (_, i) => 3 + i * 3);
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${pageIds.map((id) => id + ' 0 R').join(' ')}] /Count ${count} >>`);

    for (let i = 0; i < count; i++) {
      const p = await getPage(i);
      const scale = 792 / Math.max(p.width, p.height); // long edge = 11in
      const pw = +(p.width * scale).toFixed(2), ph = +(p.height * scale).toFixed(2);
      const pid = pageIds[i], iid = pid + 1, cid = pid + 2;
      obj(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] ` +
        `/Resources << /XObject << /Im0 ${iid} 0 R >> >> /Contents ${cid} 0 R >>`);

      const raw = p.gray instanceof Uint8Array ? p.gray : new Uint8Array(p.gray.buffer, p.gray.byteOffset, p.gray.length);
      const data = canFlate ? await deflate(raw) : raw;
      obj(iid, `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} ` +
        `/ColorSpace /DeviceGray /BitsPerComponent 8 ${canFlate ? '/Filter /FlateDecode ' : ''}` +
        `/Length ${data.length} >>`, data);

      const content = enc.encode(`q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`);
      obj(cid, `<< /Length ${content.length} >>`, content);
    }

    const objCount = 3 + count * 3;
    const xref = pos;
    let table = `xref\n0 ${objCount}\n0000000000 65535 f \n`;
    for (let id = 1; id < objCount; id++) table += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
    push(table);
    push(`trailer\n<< /Size ${objCount} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: 'application/pdf' });
  }

  root.HWExport = { zip, pdf, crc32 };
})(typeof self !== 'undefined' ? self : this);
