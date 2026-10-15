"""Read-only XLSX inspection; never rewrites a workbook."""
import sys,json,datetime,openpyxl
w=openpyxl.load_workbook(sys.argv[1],read_only=True,data_only=False)
out={}
for s in w:
 if s.title not in ['總表','幣商金幣變化','全平台營收','幣商金幣統計'] and not s.title.endswith(('儲值','留存','留存%','遊戲數據排行')):continue
 cells={};mr=0;mc=0
 for row in s:
  for c in row:
   if c.value is None:continue
   v=c.value
   if isinstance(v,(datetime.datetime,datetime.date)):v=v.strftime('%Y-%m-%d')
   cells[c.coordinate]={'value':v,'format':c.number_format}
   mr=max(mr,c.row);mc=max(mc,c.column)
 out[s.title]={'cells':cells,'maxRow':mr,'maxCol':mc}
with open(sys.argv[2],'w',encoding='utf-8') as f:json.dump(out,f,ensure_ascii=False,allow_nan=False)
