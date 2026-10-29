const fs = require('fs');
const path = require('path');

const CONTENT_DIR = path.join(process.cwd(), 'content');
const INDEX_PATH = path.join(CONTENT_DIR, 'index.json');
const EXCERPT_LEN = 160;

function excerpt(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, EXCERPT_LEN) + (String(text || '').length > EXCERPT_LEN ? '…' : '');
}

function main() {
  if (!fs.existsSync(CONTENT_DIR)) {
    console.error('content/ 目录不存在');
    process.exit(1);
  }

  const files = fs.readdirSync(CONTENT_DIR)
    .filter(f => f.endsWith('.json') && f !== 'index.json');

  const posts = [];
  for (const file of files) {
    const full = path.join(CONTENT_DIR, file);
    try {
      const raw = fs.readFileSync(full, 'utf8');
      const post = JSON.parse(raw);
      if (!post.id || !post.title || !post.createdAt) {
        console.warn(`跳过 ${file}：缺少 id/title/createdAt`);
        continue;
      }
      posts.push({
        id: String(post.id),
        title: post.title,
        excerpt: excerpt(post.content),
        createdAt: post.createdAt,
        updatedAt: post.updatedAt || post.createdAt,
      });
    } catch (e) {
      console.warn(`跳过 ${file}：${e.message}`);
    }
  }

  posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const next = JSON.stringify(posts, null, 2) + '\n';
  const prev = fs.existsSync(INDEX_PATH) ? fs.readFileSync(INDEX_PATH, 'utf8') : '';

  if (next === prev) {
    console.log(`索引无变化（${posts.length} 篇）`);
    return;
  }

  fs.writeFileSync(INDEX_PATH, next, 'utf8');
  console.log(`已重建索引：${posts.length} 篇`);
}

main();
