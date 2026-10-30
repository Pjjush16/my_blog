const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const INDEX_FILE = path.join(ROOT, 'content', 'index.json');

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return {};
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  m[1].split(/\r?\n/).forEach(line => {
    const i = line.indexOf(':');
    if (i === -1) return;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    fm[k] = v;
  });
  return fm;
}

if (!fs.existsSync(POSTS_DIR)) {
  console.error('缺少目录：' + POSTS_DIR);
  process.exit(1);
}

const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
const posts = files.map(f => {
  const raw = fs.readFileSync(path.join(POSTS_DIR, f), 'utf8');
  const fm = parseFrontmatter(raw);
  const id = f.replace(/\.md$/, '');
  return {
    id,
    title: fm.title || id,
    excerpt: fm.excerpt || '',
    createdAt: fm.createdAt || '1970-01-01T00:00:00.000Z',
  };
});

posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
fs.writeFileSync(INDEX_FILE, JSON.stringify(posts, null, 2) + '\n');
console.log('已生成 ' + posts.length + ' 篇文章的索引 → ' + path.relative(ROOT, INDEX_FILE));
