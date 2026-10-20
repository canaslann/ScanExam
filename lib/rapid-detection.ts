import type { CropBox } from "./paper-regions.ts";

export type Ruling = { y: number; slope: number; left: number; right: number; coverage: number };

/** Validate the visible score grid without requiring seven straight header rows. */
export function rapidScoreGrid(lines: Ruling[], dark: Uint8Array | undefined,
  width: number, height: number, count: number): CropBox | null {
  if (!dark || !Number.isInteger(count) || count < 1 || count > 30) return null;
  const candidates = lines.filter(l => l.y > height*.25 && l.left < width*.2
    && l.right-l.left > width*.3 && l.right-l.left < width*.9 && l.coverage>.9);
  for (const end of [...new Set(candidates.map(l=>Math.round(l.right/8)*8))]) {
    const family = candidates.filter(l=>Math.abs(l.right-end)<18)
      .sort((a,b)=>(b.right-b.left)*b.coverage-(a.right-a.left)*a.coverage);
    const rows: Ruling[]=[];
    for (const line of family) if (!rows.some(l=>Math.abs(l.y-line.y)<12)) rows.push(line);
    rows.sort((a,b)=>a.y-b.y);
    for(let i=0;i<=rows.length-4;i++) {
      const grid=rows.slice(i,i+4), left=Math.min(...grid.map(l=>l.left)), right=Math.max(...grid.map(l=>l.right));
      const span=right-left, gaps=grid.slice(1).map((l,j)=>l.y-grid[j].y);
      if(Math.max(...gaps)/Math.min(...gaps)>1.5 || grid[3].y-grid[0].y>height*.3
        || !lines.some(l=>l.y<grid[0].y-20 && l.right-l.left>width*.74)) continue;
      const columns:number[]=[];
      let start=-1, last=-1;
      const finish=()=>{if(start>=0)columns.push((start+last)/2);start=-1;};
      for(let x=Math.max(1,left-4);x<=Math.min(width-2,right+4);x++) {
        const top=Math.ceil(grid[0].y+grid[0].slope*(x-width/2)+3);
        const bottom=Math.floor(grid[1].y+grid[1].slope*(x-width/2)-3);
        let hits=0;
        for(let y=Math.max(0,top);y<=Math.min(height-1,bottom);y++) {
          let ink=false;
          for(let dx=-2;dx<=2;dx++) if(x+dx>=0&&x+dx<width&&dark[y*width+x+dx])ink=true;
          if(ink)hits++;
        }
        if(bottom>top && hits/(bottom-top+1)>.85){if(start<0)start=x;last=x;}else finish();
      }
      finish();
      const first=columns.find(x=>Math.abs(x-left)<9), final=columns.slice().reverse().find(x=>Math.abs(x-right)<9);
      if(first===undefined||final===undefined)continue;
      const divider=columns.find(x=>{
        if(x<first+span*.08||x>first+span*.35)return false;
        const step=(final-x)/count;
        return step>8 && columns.filter(actual=>actual>=x-2&&actual<=final+2).length<=count+2
          && Array.from({length:count+1},(_,j)=>x+j*step)
          .every(target=>columns.some(actual=>Math.abs(actual-target)<=Math.max(2,step*.07)));
      });
      if(divider===undefined)continue;
      const top=Math.max(0,Math.floor(Math.min(...[left,right].map(x=>grid[0].y+grid[0].slope*(x-width/2)))-5));
      const bottom=Math.min(height,Math.ceil(Math.max(...[left,right].map(x=>grid[3].y+grid[3].slope*(x-width/2)))+5));
      return {left:Math.max(0,left-3),top,width:Math.min(width,right+3)-Math.max(0,left-3),height:bottom-top};
    }
  }
  return null;
}
