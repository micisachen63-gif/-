// The existing Windows task passes --daily-only for historical reasons.
// Once weeklyEnabled is verified, scheduled Monday runs include the full week.
export function includeWeekly(d,{scheduled=false,dailyOnly=false,weeklyEnabled=false}={}){
 return d.monday&&(!dailyOnly||(scheduled&&weeklyEnabled));
}
