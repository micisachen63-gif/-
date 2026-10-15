import pptxgen from 'pptxgenjs';

/** One full-slide picture per slide (16:9). */
export async function writePptx(pngs, out, title) {
  const p = new pptxgen();
  p.layout = 'LAYOUT_WIDE'; // 13.333 x 7.5 in
  p.title = title;
  for (const f of pngs) p.addSlide().addImage({path: f, x: 0, y: 0, w: 13.333, h: 7.5});
  await p.writeFile({fileName: out});
  return out;
}
