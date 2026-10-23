'use strict';
const fs=require('node:fs');
const assert=require('node:assert/strict');
const ExcelJS=require('./vendor/exceljs.min.js');
const JSZip=require('./vendor/jszip.min.js');
(async()=>{
 const zip=await JSZip.loadAsync(fs.readFileSync(process.argv[2]));
 const manifest=JSON.parse(await zip.file('manifest.json').async('string'));
 assert.equal(manifest.dataRows,12000);assert.equal(manifest.groups,90);
 const seen=new Set();let total=0;
 for(const file of manifest.files){
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(await zip.file(file.filename).async('uint8array'));
  const ws=wb.worksheets[0];assert.equal(ws.rowCount-1,file.rows);
  for(let r=2;r<=ws.rowCount;r++){
   const cells=Array.from({length:5},(_,c)=>ws.getRow(r).getCell(c+1).value);
   const n=Number(cells[0].slice(5))-1;
   assert.ok(Number.isInteger(n)&&n>=0&&n<12000);assert.ok(!seen.has(n));seen.add(n);
   const customer=`Customer ${String((n%90)+1).padStart(2,'0')}`;
   assert.deepEqual(cells,[`DEMO-${String(n+1).padStart(5,'0')}`,`Product ${(n%12)+1}`,(n%7)+1,customer,((n%997)+1)/10]);
   assert.equal(customer,file.customer);total++;
  }
 }
 assert.equal(total,12000);assert.equal(seen.size,12000);
 console.log(JSON.stringify({verifiedAt:new Date().toISOString(),file:process.argv[2],rows:total,files:manifest.files.length,allValuesMatch:true,noDuplicateIds:true,noMixedCustomers:true}));
})().catch(e=>{console.error(e);process.exitCode=1;});
