// 生成 manifest.json：列出仓库根目录所有 .txt 文件名
// 用法：node gen-manifest.js
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname)
  .filter(f => /\.txt$/i.test(f) && fs.statSync(path.join(__dirname, f)).isFile())
  .sort();

fs.writeFileSync(path.join(__dirname, 'manifest.json'), JSON.stringify(files, null, 2) + '\n');
console.log('已生成 manifest.json，共', files.length, '本：');
files.forEach(f => console.log('  -', f));
