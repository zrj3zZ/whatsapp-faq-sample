'use strict';
const el = id => document.getElementById(id);
let input = null, worker = null, downloadUrl = null;
function resetExport() {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null; el('download').hidden = true; el('filelist').hidden = true;
  el('empty').hidden = false; el('rows').textContent = '—'; el('groups').textContent = '—';
}
function busy(value) { el('sample').disabled = value; el('file').disabled = value; el('column').disabled = value || !input; el('split').disabled = value || !input; }
function launch(message) {
  if (worker) worker.terminate();
  worker = new Worker('worker.js'); busy(true);
  worker.onerror = () => { el('status').textContent = 'Processing could not finish. Refresh and try a smaller workbook.'; busy(false); worker.terminate(); };
  worker.onmessage = ({ data }) => {
    if (data.action === 'progress') { el('status').textContent = `Preparing file ${data.done} of ${data.total}…`; return; }
    if (data.action === 'error') { el('status').textContent = data.message; if (message.action === 'inspect') input = null; busy(false); worker.terminate(); return; }
    if (data.action === 'inspected') {
      el('column').replaceChildren(...data.header.map((text, i) => new Option(`${i + 1}. ${text || '(blank heading)'}`, i)));
      el('column').value = String(Math.min(3, data.header.length - 1));
      el('status').textContent = `${data.rows.toLocaleString()} data rows ready. Choose the column to group by.`;
    } else if (data.action === 'done') {
      const m = data.manifest; el('rows').textContent = m.dataRows.toLocaleString(); el('groups').textContent = m.groups.toLocaleString();
      el('files').replaceChildren(...m.files.map(f => { const tr = document.createElement('tr'); for (const v of [f.filename, f.rows.toLocaleString()]) { const td = document.createElement('td'); td.textContent = v; tr.append(td); } return tr; }));
      el('empty').hidden = true; el('filelist').hidden = false;
      downloadUrl = URL.createObjectURL(new Blob([data.bytes], { type: 'application/zip' }));
      el('download').href = downloadUrl; el('download').hidden = false;
      el('status').textContent = `Ready: ${m.dataRows.toLocaleString()} rows across ${m.groups} files. ${m.unassignedRows} rows have a blank customer.`;
    }
    busy(false); worker.terminate();
  };
  worker.postMessage(message);
}
async function selectFile(file) {
  input = null; resetExport(); busy(true);
  if (!file || !/\.xlsx$/i.test(file.name) || file.size > 10 * 1024 * 1024) { el('status').textContent = 'Choose an .xlsx workbook smaller than 10 MB.'; busy(false); return; }
  el('filename').textContent = file.name;
  try { input = await file.arrayBuffer(); el('status').textContent = 'Reading workbook locally…'; launch({ action: 'inspect', buffer: input }); }
  catch (_) { input = null; busy(false); el('status').textContent = 'The selected file could not be read.'; }
}
el('file').addEventListener('change', event => selectFile(event.target.files[0]));
el('column').addEventListener('change', resetExport);
el('split').addEventListener('click', () => { resetExport(); el('status').textContent = 'Splitting workbook locally…'; launch({ action: 'split', buffer: input, column: Number(el('column').value) }); });
el('sample').addEventListener('click', async () => {
  busy(true); el('status').textContent = 'Creating synthetic example…';
  try {
    const book = new ExcelJS.Workbook(), ws = book.addWorksheet('Synthetic orders');
    ws.addRow(['Order ID', 'Product', 'Quantity', 'Customer', 'Amount']);
    for (let n = 0; n < 12000; n++) ws.addRow([`DEMO-${String(n + 1).padStart(5, '0')}`, `Product ${(n % 12) + 1}`, (n % 7) + 1, `Customer ${String((n % 90) + 1).padStart(2, '0')}`, ((n % 997) + 1) / 10]);
    await selectFile(new File([await book.xlsx.writeBuffer()], 'synthetic-12000-orders.xlsx'));
  } catch (_) { busy(false); el('status').textContent = 'The example could not be created. Refresh to retry.'; }
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then(async () => {
  await navigator.serviceWorker.ready; el('offline').textContent = 'Ready for offline use';
}).catch(() => { el('offline').textContent = 'Local processing'; });
