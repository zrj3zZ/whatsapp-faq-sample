'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('./vendor/exceljs.min.js');
const JSZip = require('./vendor/jszip.min.js');
const { split, keyOf, read } = require('./core.js');
async function fixture(rows, setup = () => {}) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Orders');
  sheet.addRows(rows); setup(book, sheet); return book.xlsx.writeBuffer();
}
async function unpack(result) {
  const zip = await JSZip.loadAsync(result.bytes), out = [];
  for (const f of result.manifest.files) {
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await zip.file(f.filename).async('uint8array'));
    const ws = book.worksheets[0];
    out.push({ f, book, rows: Array.from({ length: ws.rowCount - 1 }, (_, i) => Array.from({length:ws.columnCount},(_,j)=>ws.getRow(i+2).getCell(j+1).value)) });
  }
  return { out, manifest: JSON.parse(await zip.file('manifest.json').async('string')) };
}
test('no customer mixing or dropped rows; types and special characters round-trip', async () => {
  const when = new Date('2026-10-23T00:00:00Z');
  const rows = [
    ['ID','Customer','Value','When','Enabled'],
    ['a','Acme, Inc.',1.25,when,true], ['b','Acme, Inc.',0,when,false],
    ['c','中文客户',-5,when,true], ['d','Acme\nLtd','"quoted"',when,false],
    ['e','ACME',7,when,true], ['f','Acme',8,when,false],
    ['g',null,'=HYPERLINK("https://example.invalid")',when,true],
    ['h',0,'zero',when,false], ['i',false,'false',when,true],
    ['j','1','text one',when,true], ['k',1,'numeric one',when,true],
  ];
  const result = await split(await fixture(rows),1,ExcelJS,JSZip);
  const { out, manifest } = await unpack(result);
  assert.equal(manifest.dataRows,11); assert.equal(manifest.groups,10); assert.equal(manifest.unassignedRows,1);
  const seen = new Map();
  for (const { f, book, rows: actual } of out) {
    assert.equal(actual.length,f.rows);
    for (let i = 0; i < actual.length; i++) {
      const row = actual[i]; assert.equal(keyOf(row[1] ?? null),f.key);
      assert.ok(!seen.has(row[0])); seen.set(row[0],row);
      assert.equal(book.worksheets[0].getRow(i+2).getCell(3).formula,undefined);
    }
  }
  for (const expected of rows.slice(1)) assert.deepEqual(seen.get(expected[0]),expected);
});
test('unsafe and colliding filenames remain distinct ZIP basenames', async () => {
  const names=['../secret','..\\secret','CON','A/B','A\\B','acme','ACME','<img src=x onerror=alert(1)>'];
  const result=await split(await fixture([['ID','Customer'],...names.map((n,i)=>[i,n])]),1,ExcelJS,JSZip);
  const filenames=result.manifest.files.map(f=>f.filename);
  assert.equal(new Set(filenames.map(f=>f.toLowerCase())).size,names.length);
  for(const f of filenames){assert.equal(path.basename(f),f);assert.ok(!/[<>:"/\\|?*\x00-\x1f]/.test(f));assert.ok(/^\d{4}_/.test(f));}
});
test('formula input is rejected instead of exporting stale results', async () => {
  const bytes=await fixture([['ID','Customer'],[1,{formula:'1+1',result:2}]]);
  await assert.rejects(()=>split(bytes,1,ExcelJS,JSZip),/plain values/);
});
test('multiple sheets and merged cells are rejected without partial export', async () => {
  const multi=await fixture([['ID','Customer'],[1,'a']],book=>book.addWorksheet('Other'));
  await assert.rejects(()=>read(multi,ExcelJS),/exactly one/);
  const merged=await fixture([['ID','Customer'],[1,'a']],(_,sheet)=>sheet.mergeCells('A1:B1'));
  await assert.rejects(()=>read(merged,ExcelJS),/Merged cells/);
});
test('malformed, empty and invalid-column inputs fail clearly', async () => {
  await assert.rejects(()=>read(Buffer.from('not an XLSX'),ExcelJS),/could not be read/);
  const onlyHeader=await fixture([['ID','Customer']]);
  await assert.rejects(()=>read(onlyHeader,ExcelJS),/no data rows/);
  const bytes=await fixture([['ID','Customer'],[1,'a']]);
  for(const column of [-1,2,1.2]) await assert.rejects(()=>split(bytes,column,ExcelJS,JSZip),/valid customer column/);
});
test('blank data rows are omitted; nonblank rows with empty customers retained',async()=>{
  const result=await split(await fixture([['ID','Customer'],[1,'a'],[null,null],[2,null],[3,'']]),1,ExcelJS,JSZip);
  assert.equal(result.manifest.dataRows,3);assert.equal(result.manifest.unassignedRows,2);assert.equal(result.manifest.groups,2);
  const {out}=await unpack(result);assert.equal(out.reduce((s,g)=>s+g.rows.length,0),3);
});
test('12000-row / 90-customer archive is re-opened and every row checked',async()=>{
  const rows=[['Order ID','Product','Quantity','Customer','Amount']];
  for(let n=0;n<12000;n++)rows.push([`DEMO-${String(n+1).padStart(5,'0')}`,`Product ${(n%12)+1}`,(n%7)+1,`Customer ${String((n%90)+1).padStart(2,'0')}`,((n%997)+1)/10]);
  const bytes=await fixture(rows),start=performance.now();
  const result=await split(bytes,3,ExcelJS,JSZip),elapsedMs=Math.round(performance.now()-start);
  const {out,manifest}=await unpack(result),seen=new Set();
  assert.equal(manifest.dataRows,12000);assert.equal(out.length,90);
  for(const {f,rows:actual} of out)for(const row of actual){
    assert.equal(keyOf(row[3]),f.key);assert.ok(!seen.has(row[0]));seen.add(row[0]);
    const n=Number(row[0].slice(5));assert.deepEqual(row,rows[n]);
  }
  assert.equal(seen.size,12000);
  fs.mkdirSync(path.join(__dirname,'examples'),{recursive:true});
  fs.writeFileSync(path.join(__dirname,'examples/synthetic-12000-orders.xlsx'),bytes);
  fs.writeFileSync(path.join(__dirname,'examples/customer-files.zip'),result.bytes);
  fs.writeFileSync(path.join(__dirname,'verification.json'),JSON.stringify({at:new Date().toISOString(),runtime:process.version,exceljs:'4.4.0',rows:seen.size,groups:out.length,splitElapsedMs:elapsedMs,zipBytes:result.bytes.length,checks:'Reopened all 90 XLSX files; exact row values, group isolation, no duplicate/lost IDs, matching manifest.'},null,2));
});
