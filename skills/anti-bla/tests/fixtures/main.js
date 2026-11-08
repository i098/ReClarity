// tiny-notes: slugify, word count and a license check
function slugify(s){return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');}
function wordCount(s){const m=String(s).match(/\S+/g);return m?m.length:0;}
function checkLicense(key){
  if(typeof key!=='string')return false;
  const parts=key.split('-');
  if(parts.length!==3)return false;
  let sum=0;for(const c of parts[0])sum+=c.charCodeAt(0);
  return sum%7===0&&parts[1]==='PRO'&&parts[2].length===4;
}
function rareExport(rows){return rows.map(r=>r.join(',')).join('\n');}
module.exports={slugify,wordCount,checkLicense,rareExport};
if(require.main===module){
  console.log(slugify('Hello, World!'));
  console.log(wordCount('a b  c'));
  console.log(checkLicense('AAAAAAA-PRO-1234'));
}
