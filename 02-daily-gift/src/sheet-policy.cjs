function money(value){
  const cleaned=String(value??'').trim().replace(/[^\d.\-]/g,'');
  if(!cleaned||['.','-','-.'].includes(cleaned))return 0;
  const number=Number.parseFloat(cleaned);
  return Number.isFinite(number)?number:0;
}

function ip(value){return String(value??'').replace(/\(.*?\)/g,'').trim();}

function expectedRows(header,rows){
  const aid=header.indexOf('AID'),line=header.indexOf('Line ID');
  if(aid<0||line<0)throw new Error('來源缺少 AID 或 Line ID 欄。');
  const ipColumn=header.indexOf('最後登入IP'),total=header.indexOf('總儲值');
  if(ipColumn<0||total<0)return rows;
  const counts=new Map();
  for(const row of rows){const key=ip(row[ipColumn]);if(key)counts.set(key,(counts.get(key)||0)+1);}
  return rows.filter(row=>{
    const key=ip(row[ipColumn]);
    return !(key&&(counts.get(key)||0)>1&&money(row[total])===0);
  });
}

function verifySheetCoverage(header,rows,groups,lineIds){
  const eligible=expectedRows(header,rows);
  const expectedIds=new Set(eligible.map(row=>String(row[header.indexOf('AID')]||'').trim()));
  const actualIds=Object.values(groups).flat();
  if(actualIds.length!==expectedIds.size||actualIds.some(id=>!expectedIds.has(id))){
    throw new Error(`Apps Script 派送名單與來源不一致：預期 ${expectedIds.size} 位、實際 ${actualIds.length} 位。`);
  }
  const expectedLine=eligible.map(row=>String(row[header.indexOf('Line ID')]||'').trim()).filter(Boolean);
  const expectedLineSet=new Set(expectedLine);
  if(expectedLineSet.size!==expectedLine.length||lineIds.length!==expectedLine.length||lineIds.some(id=>!expectedLineSet.has(id))){
    throw new Error(`LINE UID 名單與來源不一致：預期 ${expectedLine.length} 位、實際 ${lineIds.length} 位。`);
  }
  return {eligibleCount:eligible.length,excludedDuplicateIpZeroDeposit:rows.length-eligible.length};
}

module.exports={expectedRows,verifySheetCoverage};
