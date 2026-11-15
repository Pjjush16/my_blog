// Cloudflare Worker: YAONET 控制台（frontmatter 模式）
// 读 + 写全部走 GitHub Contents API（比 Pages CDN 更稳定、更新更即时）
// 首页和博客页则由浏览器直接读 blog.yaonet.de5.net，不经过本 Worker
// 已移除 Basic Auth，请用 Cloudflare Access / 网关等方式在外层做鉴权
//
// 环境变量 FAVICON_URL：你自己的头像 URL（png / ico 均可，推荐 512×512 PNG）
// 未设置时回退到 https://blog.yaonet.de5.net/favicon.ico

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 兼容 /admin 前缀：/admin/api/save → /api/save，/admin → /
    let pathname = url.pathname;
    if (pathname === '/admin') pathname = '/';
    else if (pathname.startsWith('/admin/')) pathname = pathname.slice('/admin'.length);

    try {
      if (request.method === 'GET' && pathname === '/') {
        const apiBase = url.pathname.startsWith('/admin') ? '/admin/api' : '/api';
        return html(ADMIN_PAGE.replace(/__API_BASE__/g, apiBase));
      }
      if (request.method === 'GET' && pathname === '/favicon.ico') return await apiFavicon(env);
      if (request.method === 'GET'  && pathname === '/api/posts')  return await apiList(env);
      if (request.method === 'GET'  && pathname === '/api/post')   return await apiGetPost(env, url);
      if (request.method === 'POST' && pathname === '/api/save')   return await apiSave(request, env);
      if (request.method === 'POST' && pathname === '/api/delete') return await apiDelete(request, env);
      return json({ ok: false, error: 'Not Found' }, 404);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  },
};

// ========== GitHub API ==========
function ghHeaders(env) {
  return {
    Authorization: 'token ' + env.GITHUB_TOKEN,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'yaonet-cf-admin',
  };
}
function apiUrl(env, path) {
  return 'https://api.github.com/repos/' + env.GITHUB_OWNER + '/' + env.GITHUB_REPO + '/contents/' + path;
}
function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64decode(b64) { return decodeURIComponent(escape(atob(b64.replace(/\s/g, '')))); }

async function ghGet(env, path) {
  const branch = env.GITHUB_BRANCH || 'main';
  const res = await fetch(apiUrl(env, path) + '?ref=' + branch, { headers: ghHeaders(env) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('GitHub GET ' + path + ': ' + res.status);
  const data = await res.json();
  return { sha: data.sha, content: data.content ? b64decode(data.content) : '' };
}

async function ghPut(env, path, content, sha, message) {
  const body = { message, content: b64encode(content), branch: env.GITHUB_BRANCH || 'main' };
  if (sha) body.sha = sha;
  const res = await fetch(apiUrl(env, path), {
    method: 'PUT',
    headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('GitHub PUT ' + path + ': ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return res.json();
}

async function ghDelete(env, path, sha, message) {
  const res = await fetch(apiUrl(env, path), {
    method: 'DELETE',
    headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha, branch: env.GITHUB_BRANCH || 'main' }),
  });
  if (!res.ok) throw new Error('GitHub DELETE ' + path + ': ' + res.status);
}

// ========== Favicon ==========
// 只做一件事：代理 env.FAVICON_URL（你自己的头像），未设置则回退到 blog 的 ico
async function apiFavicon(env) {
  const src = env.FAVICON_URL || 'https://blog.yaonet.de5.net/favicon.ico';
  try {
    const res = await fetch(src, { cf: { cacheTtl: 86400 } });
    if (!res.ok) throw new Error(String(res.status));
    return new Response(res.body, {
      headers: {
        'content-type': res.headers.get('content-type') || 'image/x-icon',
        'cache-control': 'public, max-age=86400',
      },
    });
  } catch (e) {
    return new Response('', { status: 404 });
  }
}

// ========== frontmatter ==========
function splitFrontmatter(raw) {
  if (!raw.startsWith('---')) return { fm: {}, body: raw };
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: raw };
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
  return { fm, body: raw.slice(m[0].length) };
}
function yamlEscape(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// ========== 路径 ==========
function indexPath(env) { return env.INDEX_PATH || 'content/index.json'; }
function postsDir(env)  { return (env.POSTS_PATH || 'content/posts').replace(/\/$/, ''); }

async function getIndex(env) {
  const file = await ghGet(env, indexPath(env));
  if (!file) return [];
  try { const arr = JSON.parse(file.content); return Array.isArray(arr) ? arr : []; }
  catch { return []; }
}

// ========== API ==========
async function apiList(env) {
  const posts = await getIndex(env);
  return json({ ok: true, posts });
}

async function apiGetPost(env, url) {
  const id = url.searchParams.get('id');
  if (!id) return json({ ok: false, error: '缺少 id' }, 400);
  const file = await ghGet(env, postsDir(env) + '/' + id + '.md');
  if (!file) return json({ ok: false, error: '文章不存在' }, 404);
  const { fm, body } = splitFrontmatter(file.content);
  return json({
    ok: true, id,
    title: fm.title || '',
    excerpt: fm.excerpt || '',
    createdAt: fm.createdAt || '',
    content: body,
  });
}

async function apiSave(request, env) {
  const body = await request.json();
  const id = String(body.id || '').trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return json({ ok: false, error: 'ID 只能包含字母、数字、- 和 _' }, 400);

  const title = String(body.title || '').trim() || '无标题';
  const excerpt = String(body.excerpt || '').trim().replace(/\s+/g, ' ');
  const content = String(body.content || '');
  if (!content.trim()) return json({ ok: false, error: '内容不能为空' }, 400);

  const postPath = postsDir(env) + '/' + id + '.md';
  const existing = await ghGet(env, postPath);

  let createdAt = String(body.createdAt || '').trim();
  if (!createdAt && existing) createdAt = splitFrontmatter(existing.content).fm.createdAt || '';
  if (!createdAt) createdAt = new Date().toISOString();

  const head = ['---', 'title: ' + yamlEscape(title), 'createdAt: ' + createdAt];
  if (excerpt) head.push('excerpt: ' + yamlEscape(excerpt));
  head.push('---', '');
  const full = head.join('\n') + content;

  await ghPut(env, postPath, full, existing ? existing.sha : null, '更新文章: ' + title);

  return json({ ok: true, id, path: postPath, title, excerpt, createdAt });
}

async function apiDelete(request, env) {
  const body = await request.json();
  const id = String(body.id || '').trim();
  if (!id) return json({ ok: false, error: '缺少 id' }, 400);
  const postPath = postsDir(env) + '/' + id + '.md';
  const file = await ghGet(env, postPath);
  if (file) await ghDelete(env, postPath, file.sha, '删除文章: ' + id);
  return json({ ok: true });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { 'content-type': 'application/json;charset=UTF-8' },
  });
}
function html(str) {
  return new Response(str, { headers: { 'content-type': 'text/html;charset=UTF-8' } });
}

// ========== 内联后台页面 ==========
const ADMIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>YAONET · 控制台</title>
<!-- Favicon 兼容链：现代 → 老 IE → iOS → Windows 磁贴 -->
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="shortcut icon" type="image/x-icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/favicon.ico">
<meta name="theme-color" content="#2d5a4a">
<meta name="msapplication-TileColor" content="#2d5a4a">
<meta name="msapplication-TileImage" content="/favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://unpkg.com/vditor/dist/index.css" />
<style>
  :root{
    --bg:#f7f6f3;--surface:#fff;--text:#1a1a1a;--text-2:#5f5f5f;--text-3:#8a8a8a;
    --border:rgba(0,0,0,.07);--accent:#2d5a4a;--accent-soft:#e8efec;
    --radius-sm:10px;--header-h:64px;
    --font:'Manrope',system-ui,-apple-system,sans-serif;
  }
  @media (prefers-color-scheme:dark){
    :root{--bg:#0f0f0f;--surface:#1a1a1a;--text:#f0f0f0;--text-2:#a0a0a0;--text-3:#6e6e6e;
      --border:rgba(255,255,255,.08);--accent:#7fbfa8;--accent-soft:#1f2e29;}
  }
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{height:100%}
  body{
    font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.65;
    -webkit-font-smoothing:antialiased;
    display:flex;flex-direction:column;height:100vh;height:100dvh;overflow:hidden;
  }
  button,input{font:inherit;color:inherit}

  /* ---------- 顶栏 ---------- */
  .site-header{flex:0 0 auto;height:var(--header-h);
    background:color-mix(in srgb,var(--bg) 82%,transparent);
    backdrop-filter:blur(16px);border-bottom:1px solid var(--border);z-index:100}
  .header-inner{display:flex;align-items:center;gap:10px;height:100%;padding:0 16px;
    flex-wrap:nowrap;min-width:0}
  .site-brand{font-size:1.2rem;font-weight:800;letter-spacing:-.03em;white-space:nowrap;
    flex:0 0 auto;overflow:hidden;text-overflow:ellipsis;
    color:inherit;text-decoration:none;cursor:pointer;transition:opacity .15s}
  .site-brand:hover{opacity:.8}
  .site-brand span{color:var(--accent)}
  .site-brand small{font-size:.72rem;font-weight:600;color:var(--text-3);margin-left:8px;letter-spacing:0}

  /* 右上角操作区：margin-left:auto 把整组推到顶栏最右 */
  .actions{display:flex;align-items:center;gap:8px;flex:0 0 auto;min-width:0;
    margin-left:auto}
  .status{font-size:.78rem;color:var(--text-3);min-height:1em;max-width:260px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto}
  .status.err{color:#c0392b}

  .btn{padding:8px 16px;border-radius:999px;font-family:var(--font);font-size:.85rem;font-weight:600;
    border:1px solid transparent;cursor:pointer;transition:all .2s;white-space:nowrap;
    flex:0 0 auto;line-height:1.2}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .btn-primary{background:var(--accent);color:#fff}
  .btn-primary:hover:not(:disabled){opacity:.88}
  .btn-ghost{background:transparent;border-color:var(--border);color:var(--text-2)}
  .btn-ghost:hover{background:var(--surface);color:var(--text)}
  .btn-danger{background:transparent;border-color:rgba(192,57,43,.3);color:#c0392b}
  .btn-danger:hover{background:rgba(192,57,43,.08)}

  .icon-btn{width:34px;height:34px;flex:0 0 auto;border-radius:9px;border:1px solid var(--border);
    background:transparent;color:var(--text-2);cursor:pointer;display:inline-flex;
    align-items:center;justify-content:center;font-size:16px;transition:.15s}
  .icon-btn:hover{background:var(--bg);color:var(--text)}

  /* ---------- 顶栏标题滚动（手机） ---------- */
  #headerTitle{display:none;flex:1 1 auto;min-width:0;overflow:hidden;position:relative}
  #headerTitle .mq-track{display:inline-flex;white-space:nowrap;will-change:transform}
  #headerTitle .mq-text{padding-right:48px;font-size:.9rem;font-weight:600}
  #headerTitle.mq-active .mq-track{animation:mq-scroll 14s linear infinite}
  @keyframes mq-scroll{
    from{transform:translateX(0)}
    to{transform:translateX(-50%)}
  }

  /* ---------- 主框架 ---------- */
  .admin-main{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:320px 1fr}

  /* ---------- 侧栏 ---------- */
  .post-list{background:var(--surface);border-right:1px solid var(--border);
    display:flex;flex-direction:column;min-height:0}
  .list-head{display:none}

  /* 抽屉左上角品牌（仅移动端可见） */
  .drawer-brand{font-size:1rem;font-weight:800;letter-spacing:-.03em;
    color:var(--text);text-decoration:none;display:inline-flex;align-items:baseline;
    cursor:pointer;transition:opacity .15s}
  .drawer-brand:hover{opacity:.8}
  .drawer-brand span{color:var(--accent)}

  /* 侧栏表单：标题 / 编号 / 简介 / 删除 */
  .side-form{flex:0 0 auto;padding:12px;display:flex;flex-direction:column;gap:8px;
    border-bottom:1px solid var(--border);background:var(--surface)}
  .side-form #delBtn{align-self:flex-end}
  body.empty .side-form{display:none}

  .field{padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--font);
    font-size:.86rem;background:var(--bg);color:var(--text);outline:none;
    transition:border-color .15s;width:100%;min-width:0}
  .field:focus{border-color:var(--accent)}
  .field.title{font-weight:600}
  .field.id{font-family:ui-monospace,Menlo,monospace;font-size:.8rem}

  .list-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;padding:8px;
    -webkit-overflow-scrolling:touch}
  .list-empty{padding:24px 8px;text-align:center;color:var(--text-3);font-size:.82rem}
  .list-item{position:relative;padding:10px 12px;border-radius:var(--radius-sm);cursor:pointer;
    transition:background .15s;margin-bottom:2px}
  .list-item:hover{background:var(--accent-soft)}
  .list-item.active{background:var(--accent-soft)}
  .list-item .t{font-size:.88rem;font-weight:600;line-height:1.4;padding-right:22px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .list-item.active .t{color:var(--accent)}
  .list-item .d{font-size:.7rem;color:var(--text-3);margin-top:2px}
  .list-item .del{position:absolute;right:6px;top:8px;width:22px;height:22px;line-height:20px;
    text-align:center;border:0;background:transparent;color:var(--text-3);border-radius:6px;
    cursor:pointer;font-size:14px;opacity:0;transition:opacity .15s}
  .list-item:hover .del,.list-item.active .del{opacity:1}
  .list-item .del:hover{background:rgba(192,57,43,.1);color:#c0392b}
  @media (hover:none){.list-item .del{opacity:1}}

  /* ---------- 编辑区 ---------- */
  .editor-pane{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--surface)}
  .editor-wrap{flex:1 1 auto;min-height:0;position:relative;display:flex;flex-direction:column}
  #editor{flex:1 1 auto;min-height:0;position:relative;overflow:hidden}
  #editor .vditor{height:100% !important;border:none !important;background:transparent !important}
  #editor .vditor-toolbar{border-bottom:1px solid var(--border) !important;background:transparent !important}
  #editor .vditor-reset{font-family:var(--font) !important}

  .empty-hint{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;
    justify-content:center;gap:14px;background:var(--surface);color:var(--text-3);
    font-size:.9rem;z-index:5;padding:24px;text-align:center}
  .empty-hint .emoji{font-size:34px;opacity:.7}

  body.empty #editor{display:none}
  body.empty .empty-hint{display:flex}

  /* ---------- Toast ---------- */
  .toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));
    transform:translate(-50%,12px);background:var(--text);color:var(--bg);
    padding:9px 18px;border-radius:999px;font-size:.8rem;font-weight:600;opacity:0;
    pointer-events:none;transition:opacity .2s,transform .2s;z-index:200;max-width:80vw;text-align:center}
  .toast.show{opacity:1;transform:translate(-50%,0)}
  .toast.err{background:#c0392b;color:#fff}

  /* ---------- 手机端 ---------- */
  @media (max-width:899px){
    :root{--header-h:56px}
    .header-inner{padding:0 10px;gap:8px}
    .site-brand{display:none}
    #headerTitle{display:block}
    #status{display:none}
    #newBtn{display:none}
    #drawerBtn{display:inline-flex}
    .actions{gap:8px}
    .actions .btn{padding:7px 12px;font-size:.8rem}

    .admin-main{display:block;position:relative}

    /* 侧栏全屏覆盖：表单 + 列表 */
    .post-list{position:fixed;top:var(--header-h);right:0;bottom:0;left:0;
      transform:translateY(8px);opacity:0;pointer-events:none;
      transition:opacity .2s,transform .2s;z-index:90;
      border-right:none;background:var(--surface);display:flex;flex-direction:column}
    body.list-open .post-list{opacity:1;transform:translateY(0);pointer-events:auto}

    .list-head{display:flex;align-items:center;justify-content:space-between;
      padding:10px 12px;border-bottom:1px solid var(--border);flex:0 0 auto;gap:8px}
    .list-head .btn{flex:0 0 auto;padding:7px 12px;font-size:.8rem}

    .side-form{padding:10px;gap:6px}
    .field{font-size:.82rem;padding:7px 10px}

    .list-scroll{padding:10px}
    .list-item{padding:12px 14px}
    .list-item .t{font-size:.92rem}
    .list-item .del{opacity:1;top:10px;right:8px;width:26px;height:26px;line-height:24px}

    .editor-pane{height:100%}
  }

  @media (min-width:900px){
    #drawerBtn{display:none !important}
    .list-head{display:none !important}
  }
</style>
</head>
<body class="empty">

<header class="site-header">
  <div class="header-inner">
    <button id="drawerBtn" class="icon-btn" type="button" aria-label="打开文章列表">☰</button>
    <a href="https://yaonet.de5.net" class="site-brand" title="前往 YAONET 首页">YAO<span>NET</span><small>控制台</small></a>
    <div id="headerTitle"><div class="mq-track"></div></div>
    <div class="actions">
      <span id="status" class="status"></span>
      <button id="newBtn" class="btn btn-ghost" type="button">新建</button>
      <button id="saveBtn" class="btn btn-primary" type="button">保存</button>
    </div>
  </div>
</header>

<main class="admin-main">
  <aside class="post-list" id="postList">
    <div class="list-head">
      <a href="https://yaonet.de5.net" class="drawer-brand" title="前往 YAONET 首页">YAO<span>NET</span></a>
      <div style="display:flex;gap:8px">
        <button id="newBtnMobile" class="btn btn-primary" type="button">＋ 新建</button>
        <button id="listClose" class="icon-btn" type="button" aria-label="关闭">✕</button>
      </div>
    </div>

    <div class="side-form">
      <input id="titleInput" class="field title" placeholder="标题" />
      <input id="idInput" class="field id" placeholder="ID（文件名，不含 .md）" />
      <input id="excerptInput" class="field excerpt" placeholder="简介（用于列表页）" />
      <button id="delBtn" class="btn btn-danger" type="button" style="display:none">删除</button>
    </div>

    <div class="list-scroll" id="listScroll">
      <div class="list-empty">加载中…</div>
    </div>
  </aside>

  <section class="editor-pane">
    <div class="editor-wrap">
      <div id="editor"></div>
      <div class="empty-hint" id="emptyHint">
        <div class="emoji">📝</div>
        <div id="emptyHintText">从左侧选择一篇文章，或新建一篇</div>
        <button id="emptyNewBtn" class="btn btn-ghost" type="button">新建文章</button>
      </div>
    </div>
  </section>
</main>

<div id="toast" class="toast"></div>

<script src="https://unpkg.com/vditor/dist/index.min.js"></script>
<script>
  var API = '__API_BASE__';
  var currentId = null;
  var currentCreatedAt = null;
  var vditor = null;
  var editorPromise = null;
  var postsCache = [];
  var dirty = false;
  var suppressDirty = false;
  var toastTimer = null;

  var bodyEl = document.body;
  var statusEl = document.getElementById('status');
  var listEl = document.getElementById('listScroll');
  var titleInput = document.getElementById('titleInput');
  var idInput = document.getElementById('idInput');
  var excerptInput = document.getElementById('excerptInput');
  var delBtn = document.getElementById('delBtn');
  var saveBtn = document.getElementById('saveBtn');
  var newBtn = document.getElementById('newBtn');
  var newBtnMobile = document.getElementById('newBtnMobile');
  var drawerBtn = document.getElementById('drawerBtn');
  var listClose = document.getElementById('listClose');
  var headerTitle = document.getElementById('headerTitle');
  var emptyHintText = document.getElementById('emptyHintText');
  var toastEl = document.getElementById('toast');
  var brandLink = document.querySelector('.site-brand');
  var drawerBrand = document.querySelector('.drawer-brand');

  var mqMobile = window.matchMedia('(max-width: 899px)');
  function isMobile(){ return mqMobile.matches; }

  function esc(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function fmt(iso){
    try{ return new Date(iso).toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'}); }
    catch(e){ return ''; }
  }
  function toast(msg, isErr){
    if(!toastEl || !msg) return;
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.className = 'toast' + (isErr ? ' err' : ''); }, 2200);
  }
  function setStatus(msg, isErr){
    statusEl.textContent = msg || '';
    statusEl.className = isErr ? 'status err' : 'status';
    if(isMobile()) toast(msg, isErr);
  }

  function setDelVisible(v){
    delBtn.style.display = v ? '' : 'none';
  }

  function setEditorValue(text){
    dirty = false;
    suppressDirty = true;
    if(vditor) vditor.setValue(text || '');
    setTimeout(function(){ suppressDirty = false; }, 60);
  }

  /* ---------- 顶栏标题滚动 ---------- */
  function setMarqueeText(text){
    var track = headerTitle.querySelector('.mq-track');
    headerTitle.classList.remove('mq-active');
    track.innerHTML = '';
    var a = document.createElement('span');
    a.className = 'mq-text';
    a.textContent = text;
    track.appendChild(a);
    void track.offsetWidth;
    if(a.scrollWidth > headerTitle.clientWidth + 1){
      var b = a.cloneNode(true);
      b.setAttribute('aria-hidden','true');
      track.appendChild(b);
      headerTitle.classList.add('mq-active');
    }
  }
  function updateHeaderTitle(title){
    setMarqueeText(title || 'YAONET 控制台');
  }

  /* ---------- 侧栏开合 ---------- */
  function openList(){
    if(!isMobile()) return;
    bodyEl.classList.add('list-open');
  }
  function closeList(){
    bodyEl.classList.remove('list-open');
  }
  drawerBtn.addEventListener('click', function(e){
    e.stopPropagation();
    if(bodyEl.classList.contains('list-open')) closeList();
    else openList();
  });
  listClose.addEventListener('click', closeList);

  /* ---------- 编辑器 ---------- */
  function ensureEditor(){
    if(editorPromise) return editorPromise;
    editorPromise = new Promise(function(resolve){
      if(typeof Vditor === 'undefined'){ resolve(null); return; }
      vditor = new Vditor('editor', {
        height: '100%',
        mode: 'wysiwyg',   // 默认所见即所得
        cache: { enable: false },
        placeholder: '开始写 Markdown…',
        toolbar: [
          'emoji', 'headings', 'bold', 'italic', 'strike', 'link', '|',
          'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
          'quote', 'line', 'code', 'inline-code', 'insert-before', 'insert-after', '|',
          'table', '|',
          'undo', 'redo', '|',
          'fullscreen', 'edit-mode', 'both', 'preview', 'outline'
        ],
        upload: { handler: function(){ return null; } },
        link: { isUpload: false },
        input: function(){ if(!suppressDirty) dirty = true; },
        after: function(){ resolve(vditor); },
      });
    });
    return editorPromise;
  }

  async function showEditorPane(){
    bodyEl.classList.remove('empty');
    closeList();
    await new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); });
    await ensureEditor();
    requestAnimationFrame(function(){ try{ if(vditor) vditor.resize(); }catch(e){} });
  }

  function confirmDiscard(){
    return !dirty || confirm('当前文章有未保存的修改，确定放弃吗？');
  }

  function highlightActive(id){
    var items = listEl.querySelectorAll('.list-item');
    for(var i=0;i<items.length;i++){
      items[i].classList.toggle('active', items[i].getAttribute('data-id') === id);
    }
  }

  /* ---------- 列表 ---------- */
  async function loadPosts(){
    try{
      var res = await fetch(API + '/posts');
      var data = await res.json();
      if(!data.ok) throw new Error(data.error || '加载失败');
      postsCache = data.posts || [];
      renderList(postsCache);
    }catch(e){
      listEl.innerHTML = '<div class="list-empty">加载失败：' + esc(e.message) + '</div>';
    }
  }

  function renderList(posts){
    if(!posts.length){
      listEl.innerHTML = '<div class="list-empty">还没有文章，点「新建」开始。</div>';
      return;
    }
    listEl.innerHTML = posts.map(function(p){
      return '<div class="list-item" data-id="' + esc(p.id) + '">' +
        '<div class="t">' + esc(p.title || '无标题') + '</div>' +
        '<div class="d">' + fmt(p.createdAt) + '</div>' +
        '<button class="del" data-del="' + esc(p.id) + '" title="删除">×</button>' +
      '</div>';
    }).join('');
  }

  /* ---------- 打开 / 新建 / 清空 ---------- */
  async function openPost(id){
    if(currentId === id){ closeList(); return; }
    if(!confirmDiscard()) return;
    setStatus('加载中…');
    try{
      var res = await fetch(API + '/post?id=' + encodeURIComponent(id));
      var data = await res.json();
      if(!data.ok) throw new Error(data.error || '加载失败');
      currentId = data.id;
      currentCreatedAt = data.createdAt || null;
      titleInput.value = data.title || '';
      idInput.value = data.id;
      idInput.readOnly = true;
      excerptInput.value = data.excerpt || '';
      updateHeaderTitle(data.title || '无标题');
      setDelVisible(true);
      highlightActive(id);
      await showEditorPane();
      setEditorValue(data.content || '');
      setStatus('');
    }catch(e){
      setStatus(e.message, true);
    }
  }

  async function newPost(){
    if(!confirmDiscard()) return;
    currentId = null;
    currentCreatedAt = null;
    titleInput.value = '';
    idInput.value = 'post-' + Date.now().toString(36);
    idInput.readOnly = false;
    excerptInput.value = '';
    updateHeaderTitle('新建文章');
    setDelVisible(false);
    highlightActive(null);
    await showEditorPane();
    setEditorValue('');
    setStatus('新文章，保存后写入仓库');
    try{ titleInput.focus(); }catch(e){}
  }

  function clearEditor(){
    currentId = null;
    currentCreatedAt = null;
    dirty = false;
    titleInput.value = '';
    idInput.value = '';
    idInput.readOnly = false;
    excerptInput.value = '';
    setDelVisible(false);
    highlightActive(null);
    if(vditor) setEditorValue('');
    updateHeaderTitle('');
    bodyEl.classList.add('empty');
    closeList();
  }

  /* ---------- 保存 ---------- */
  async function savePost(){
    if(!vditor || bodyEl.classList.contains('empty')){
      setStatus('请先选择或新建文章', true);
      return;
    }
    var id = idInput.value.trim();
    var title = titleInput.value.trim();
    var content = vditor.getValue();

    if(!/^[a-zA-Z0-9_-]+$/.test(id)){ setStatus('ID 只能包含字母、数字、- 和 _', true); return; }
    if(!title){ setStatus('请填写标题', true); return; }
    if(!content.trim()){ setStatus('内容不能为空', true); return; }

    var payload = { id: id, title: title, excerpt: excerptInput.value.trim(), content: content };
    if(currentCreatedAt) payload.createdAt = currentCreatedAt;

    saveBtn.disabled = true;
    setStatus('保存中…');
    try{
      var res = await fetch(API + '/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var data = await res.json();
      if(!data.ok) throw new Error(data.error || '保存失败');

      currentId = data.id;
      currentCreatedAt = data.createdAt || currentCreatedAt;
      idInput.value = data.id;
      idInput.readOnly = true;
      updateHeaderTitle(data.title || '无标题');
      setDelVisible(true);
      dirty = false;
      setStatus('已保存：' + data.path);

      var pos = -1;
      for(var i=0;i<postsCache.length;i++){ if(postsCache[i].id === data.id){ pos = i; break; } }
      var entry = { id: data.id, title: data.title, excerpt: data.excerpt, createdAt: data.createdAt };
      if(pos >= 0) postsCache[pos] = entry; else postsCache.unshift(entry);
      postsCache.sort(function(a,b){ return new Date(b.createdAt) - new Date(a.createdAt); });
      renderList(postsCache);
      highlightActive(data.id);
    }catch(e){
      setStatus('保存失败：' + e.message, true);
    }finally{
      saveBtn.disabled = false;
    }
  }

  /* ---------- 删除 ---------- */
  async function deletePost(id){
    if(!id){ setStatus('请先保存文章', true); return; }
    if(!confirm('确定删除「' + id + '」？此操作会直接提交到 GitHub。')) return;
    setStatus('删除中…');
    try{
      var res = await fetch(API + '/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id }),
      });
      var data = await res.json();
      if(!data.ok) throw new Error(data.error || '删除失败');
      postsCache = postsCache.filter(function(p){ return p.id !== id; });
      renderList(postsCache);
      if(currentId === id) clearEditor();
      setStatus('已删除：' + id);
    }catch(e){
      setStatus('删除失败：' + e.message, true);
    }
  }

  /* ---------- 事件 ---------- */
  listEl.addEventListener('click', function(e){
    var del = e.target.closest('button[data-del]');
    if(del){ e.stopPropagation(); deletePost(del.getAttribute('data-del')); return; }
    var item = e.target.closest('.list-item');
    if(item) openPost(item.getAttribute('data-id'));
  });

  newBtn.addEventListener('click', newPost);
  newBtnMobile.addEventListener('click', newPost);
  saveBtn.addEventListener('click', savePost);
  delBtn.addEventListener('click', function(){ deletePost(currentId); });
  document.getElementById('emptyNewBtn').addEventListener('click', newPost);

  /* 品牌入口：点击回主站前先检查未保存 */
  [brandLink, drawerBrand].forEach(function(el){
    if(!el) return;
    el.addEventListener('click', function(e){
      if(!confirmDiscard()) e.preventDefault();
    });
  });

  titleInput.addEventListener('input', function(){
    dirty = true;
    if(isMobile()) updateHeaderTitle(titleInput.value.trim() || '无标题');
  });
  excerptInput.addEventListener('input', function(){ dirty = true; });
  idInput.addEventListener('input', function(){ dirty = true; });

  document.addEventListener('keydown', function(e){
    if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's'){ e.preventDefault(); savePost(); }
    if(e.key === 'Escape' && bodyEl.classList.contains('list-open')){ closeList(); }
  });

  window.addEventListener('resize', function(){
    if(vditor){ try{ vditor.resize(); }catch(e){} }
    if(isMobile()){
      var t = currentId ? (titleInput.value.trim() || '无标题') : 'YAONET 控制台';
      updateHeaderTitle(t);
    }
  });

  /* ---------- 启动 ---------- */
  (async function boot(){
    updateHeaderTitle('');
    if(isMobile()) emptyHintText.textContent = '点左上角 ☰ 打开文章列表';
    loadPosts();
  })();
</script>
</body>
</html>`;
