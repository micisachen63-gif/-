const fs=require('node:fs');
const path=require('node:path');

function parseCsv(text){
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}
    else if(c==='"')quoted=true;
    else if(c===','){row.push(cell);cell='';}
    else if(c==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}
    else cell+=c;
  }
  if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}
  return rows;
}
async function downloadTemplates(context,outDir){
  const page=await context.newPage();
  try{
    const wait=page.waitForEvent('download',{timeout:30000});
    await page.goto('https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/export?format=csv&gid=930631666',{waitUntil:'domcontentloaded'}).catch(()=>{});
    const download=await wait;fs.mkdirSync(outDir,{recursive:true});
    const file=path.join(outDir,'mail-templates.csv');await download.saveAs(file);
    if(await download.failure())throw new Error('信件文案工作表下載失敗。');
    const rows=parseCsv(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
    const starts={songyy:2,qiezi:7,winmalo:22};
    return Object.fromEntries(Object.entries(starts).map(([brand,start])=>{
      const values=[rows[start-1]?.[1],rows[start]?.[1],rows[start+1]?.[1]];
      if(values.some(x=>!x))throw new Error(`${brand} 的信件文案缺漏。`);
      return [brand,{iconTitle:values[0],mailTitle:values[1],body:values[2]}];
    }));
  }finally{await page.close();}
}
module.exports={parseCsv,downloadTemplates};
