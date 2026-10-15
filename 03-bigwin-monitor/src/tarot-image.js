import fs from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { TAROT_DECK, tarotPositionsFor } from './tarot.js';

const escapeXml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' })[c]);

/** Render the exact selected Rider–Waite–Smith faces, in draw order. */
export function renderTarotSpread(session) {
  const positions=tarotPositionsFor(session);
  if(session.picks.length!==positions.length)throw new Error('牌尚未全部翻完');
  const back=fs.readFileSync(new URL('../assets/tarot-card-back-v1.png',import.meta.url)).toString('base64');
  const columns=5,rows=Math.ceil(positions.length/columns);
  const width=1400,height=96+rows*474+36;
  const tiles=session.picks.map((pick,order)=>{
    const card=session.candidates[pick];
    if(!card)throw new Error('牌面資料不完整');
    const deckIndex=TAROT_DECK.indexOf(card.name);
    if(deckIndex<0)throw new Error('找不到對應牌面');
    const file=new URL(`../assets/tarot-rws/${String(deckIndex).padStart(2,'0')}.jpg`,import.meta.url);
    const jpg=fs.readFileSync(file).toString('base64');
    const x=80+(order%columns)*250,y=108+Math.floor(order/columns)*474;
    const cx=x+107,cy=y+176;
    const orientation=card.orientation==='逆位'?'逆位':'正位';
    const image=`<image href="data:image/jpeg;base64,${jpg}" x="${x+4}" y="${y+4}" width="206" height="344" preserveAspectRatio="xMidYMid meet" ${orientation==='逆位'?`transform="rotate(180 ${cx} ${cy})"`:''}/>`;
    return `<g>
      <rect x="${x-8}" y="${y-8}" width="230" height="452" rx="15" fill="#12152a" stroke="#b99550" stroke-width="3"/>
      <rect x="${x}" y="${y}" width="214" height="352" rx="4" fill="#e9ddba"/>
      ${image}
      <text x="${x+107}" y="${y+376}" fill="#f1deb0" text-anchor="middle" font-size="20" font-weight="700">${order+1}. ${escapeXml(positions[order])}</text>
      <text x="${x+107}" y="${y+405}" fill="#d6c9ec" text-anchor="middle" font-size="20">${escapeXml(card.name)}</text>
      <text x="${x+107}" y="${y+432}" fill="${orientation==='逆位'?'#e5a4aa':'#d6c9ec'}" text-anchor="middle" font-size="18">${orientation}</text>
    </g>`;
  }).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs><radialGradient id="bg"><stop stop-color="#34244a"/><stop offset="1" stop-color="#111528"/></radialGradient></defs>
    <rect width="100%" height="100%" fill="url(#bg)"/>
    <image href="data:image/png;base64,${back}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" opacity="0.14"/>
    <rect x="22" y="22" width="${width-44}" height="${height-44}" rx="22" fill="none" stroke="#ad8746" stroke-width="3"/>
    <text x="700" y="69" fill="#e9d2a0" text-anchor="middle" font-size="42" font-weight="700">✦ 小精靈塔羅牌陣 ✦</text>
    ${tiles}
  </svg>`;
  return new Resvg(svg,{fitTo:{mode:'original'},font:{loadSystemFonts:true,defaultFontFamily:'Microsoft JhengHei'}}).render().asPng();
}
