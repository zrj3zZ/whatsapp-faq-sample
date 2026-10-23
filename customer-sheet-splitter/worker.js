importScripts('vendor/exceljs.min.js', 'vendor/jszip.min.js', 'core.js');
self.onmessage = async ({ data }) => {
  try {
    if (data.action === 'inspect') {
      const info = await CustomerSplit.read(data.buffer, ExcelJS);
      self.postMessage({ action: 'inspected', header: info.header.map(v => v === null ? '' : String(v)), rows: info.rows.length });
      return;
    }
    const result = await CustomerSplit.split(data.buffer, data.column, ExcelJS, JSZip,
      (done, total) => self.postMessage({ action: 'progress', done, total }));
    self.postMessage({ action: 'done', manifest: result.manifest, bytes: result.bytes }, [result.bytes.buffer]);
  } catch (error) { self.postMessage({ action: 'error', message: error.message }); }
};
