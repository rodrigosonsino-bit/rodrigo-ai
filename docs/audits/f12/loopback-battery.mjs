const naive=u=>{try{const h=new URL(u).hostname;return ["127.0.0.1","localhost","[::1]"].includes(h)}catch{return false}};
const strict=u=>{try{const p=new URL(u);return ["http:","https:"].includes(p.protocol)&&!p.username&&!p.password&&["127.0.0.1","[::1]"].includes(p.hostname)&&!u.includes("\\")&&!/\s/.test(u)}catch{return false}};
import fs from 'fs'; const P=JSON.parse(fs.readFileSync(0,'utf8')).map(r=>r[0]);
console.log(JSON.stringify(P.map(u=>[u,naive(u),strict(u)])));
