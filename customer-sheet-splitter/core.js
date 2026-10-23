(function (root) {
  'use strict';
  function fail(message) { throw new Error(message); }
  function scalar(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value instanceof Date && Number.isFinite(value.getTime())) return value;
    fail('Use plain values: formulas, errors, rich text and hyperlinks are not supported. Save a values-only copy first.');
  }
  function safeName(value, index) {
    const text = value === null || value === '' ? 'Unassigned' : value instanceof Date ? value.toISOString() : String(value);
    const base = text.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').slice(0, 70) || 'Customer';
    return String(index + 1).padStart(4, '0') + '_' + base + '.xlsx';
  }
  function keyOf(value) {
    if (value === null || value === '') return 'empty';
    return value instanceof Date ? 'date:' + value.toISOString() : typeof value + ':' + String(value);
  }
  async function read(buffer, ExcelJS) {
    if (!buffer.byteLength || buffer.byteLength > 10 * 1024 * 1024) fail('Choose an .xlsx file smaller than 10 MB.');
    const book = new ExcelJS.Workbook();
    try { await book.xlsx.load(buffer); } catch (_) { fail('This file could not be read as an .xlsx workbook.'); }
    if (book.worksheets.length !== 1) fail('Use a workbook with exactly one sheet. This keeps other sheets from being left out.');
    const sheet = book.worksheets[0];
    if (sheet.rowCount > 50001 || sheet.columnCount > 128) fail('Demo limit: 50,000 data rows and 128 columns.');
    if (sheet.model.merges.length) fail('Merged cells are not supported. Unmerge a copy before splitting.');
    const width = sheet.columnCount;
    if (!width) fail('The sheet is empty.');
    const header = Array.from({ length: width }, (_, i) => scalar(sheet.getRow(1).getCell(i + 1).value));
    if (header.every(v => v === null || v === '')) fail('Put your column headings in row 1.');
    const rows = [];
    for (let n = 2; n <= sheet.rowCount; n++) {
      const row = Array.from({ length: width }, (_, i) => scalar(sheet.getRow(n).getCell(i + 1).value));
      if (row.some(v => v !== null && v !== '')) rows.push(row);
    }
    if (!rows.length) fail('There are headings but no data rows.');
    return { header, rows, sheetName: sheet.name };
  }
  async function split(buffer, column, ExcelJS, JSZip, progress = () => {}) {
    const data = await read(buffer, ExcelJS);
    if (!Number.isInteger(column) || column < 0 || column >= data.header.length) fail('Choose a valid customer column.');
    const groups = new Map();
    let unassigned = 0;
    for (const row of data.rows) {
      const value = row[column];
      const key = keyOf(value);
      if (!groups.has(key)) groups.set(key, { value, rows: [] });
      groups.get(key).rows.push(row);
      if (key === 'empty') unassigned++;
    }
    if (groups.size > 500) fail('Demo limit: 500 groups. Check that you chose the customer column.');
    const zip = new JSZip();
    const files = [];
    let i = 0;
    for (const group of groups.values()) {
      const filename = safeName(group.value, i);
      const out = new ExcelJS.Workbook();
      const ws = out.addWorksheet('Data');
      ws.addRow(data.header);
      ws.addRows(group.rows);
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF155E4B' } };
      ws.columns.forEach((c, n) => { c.width = Math.min(36, Math.max(12, String(data.header[n] || '').length + 3)); });
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: data.header.length } };
      zip.file(filename, await out.xlsx.writeBuffer(), { binary: true });
      files.push({ filename, customer: group.value, key: keyOf(group.value), rows: group.rows.length });
      progress(++i, groups.size);
    }
    const manifest = { schema: 1, inputSheet: data.sheetName, customerColumn: column + 1, dataRows: data.rows.length, groups: files.length, unassignedRows: unassigned, files };
    if (files.reduce((sum, f) => sum + f.rows, 0) !== data.rows.length) fail('Row accounting failed. No export created.');
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    return { manifest, bytes: await zip.generateAsync({ type: 'uint8array', compression: 'STORE' }) };
  }
  const api = { read, split, safeName, keyOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CustomerSplit = api;
})(typeof self !== 'undefined' ? self : globalThis);
