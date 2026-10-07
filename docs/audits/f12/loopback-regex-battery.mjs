import fs from 'fs';
const R=/^http:\/\/(127\.0\.0\.1|\[::1\]):\d{1,5}$/;
const P=JSON.parse(fs.readFileSync('t1b.py.json','utf8')).map(r=>r[0]);
console.log(JSON.stringify(P.map(p=>[p,R.test(p)])));
