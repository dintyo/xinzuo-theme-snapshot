#!/usr/bin/env node
/*
 * Seed your Shopify dev store from the public xinzuo.com.au catalog snapshot.
 *
 * Default: SLIM (40 products, 5 articles, all collections, all pages) — ~90 seconds.
 * Full catalog opt-in: --full (237 products, 77 articles) — ~8 minutes.
 *
 * Usage:
 *   node scripts/seed-to-dev-store.mjs                # dry-run, slim
 *   node scripts/seed-to-dev-store.mjs --write        # write slim seed (default)
 *   node scripts/seed-to-dev-store.mjs --write --full # full catalog
 *   node scripts/seed-to-dev-store.mjs --wipe         # delete existing dev-store products first
 *   node scripts/seed-to-dev-store.mjs --write --wipe # wipe + write slim seed
 *
 * Reads .env: SHOPIFY_STORE_URL=*.myshopify.com, SHOPIFY_ACCESS_TOKEN=shpat_…
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const WRITE = process.argv.includes('--write');
const FULL = process.argv.includes('--full');
const WIPE = process.argv.includes('--wipe');

const SLIM_PRODUCTS = 40;
const SLIM_ARTICLES = 5;
const CONCURRENCY = 4;

const envPath = path.join(process.cwd(), '.env');
if (!existsSync(envPath)) {
  console.error(`No .env in ${process.cwd()}. See README.`);
  process.exit(1);
}
const env = Object.fromEntries(
  readFileSync(envPath, 'utf-8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);

const STORE = env.SHOPIFY_STORE_URL;
const TOKEN = env.SHOPIFY_ACCESS_TOKEN;
if (!STORE || !TOKEN) { console.error('Missing SHOPIFY_STORE_URL or SHOPIFY_ACCESS_TOKEN'); process.exit(1); }

const hostname = STORE.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
if (!hostname.endsWith('.myshopify.com')) {
  console.error(`REFUSED: store URL must end in *.myshopify.com. Got: ${hostname}`);
  console.error(`(Use the *.myshopify.com URL, not a custom domain.)`);
  process.exit(1);
}
if (/^xinzuo\.com\.au$/i.test(hostname)) { console.error('REFUSED: production custom domain'); process.exit(1); }

const BASE = `https://${hostname}`;
const API = `${BASE}/admin/api/2024-10`;

// --- HTTP with rate-limit handling ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, endpoint, body) {
  while (true) {
    const r = await fetch(`${API}/${endpoint}`, {
      method,
      headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) {
      const wait = parseFloat(r.headers.get('retry-after') || '2') * 1000;
      await sleep(wait);
      continue;
    }
    if (!r.ok) throw new Error(`${method} ${endpoint} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
}

async function paginate(endpoint) {
  // `endpoint` may already contain a query string (e.g. "products.json?fields=id").
  // Use the right separator so we don't end up with two `?` and a broken URL.
  const sep = endpoint.includes('?') ? '&' : '?';
  let next = `${API}/${endpoint}${sep}limit=250`;
  const out = [];
  while (next) {
    const r = await fetch(next, { headers: { 'X-Shopify-Access-Token': TOKEN } });
    if (!r.ok) throw new Error(`${endpoint} ${r.status}`);
    const data = await r.json();
    const key = Object.keys(data)[0];
    out.push(...(data[key] ?? []));
    const m = (r.headers.get('link') || '').match(/<([^>]+)>;\s*rel="next"/);
    next = m ? m[1] : null;
  }
  return out;
}

// --- Concurrency pool ---
async function pool(items, worker, concurrency = CONCURRENCY) {
  let idx = 0;
  let ok = 0, fail = 0;
  let lastLog = Date.now();
  const total = items.length;
  const errors = [];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (idx < items.length) {
        const i = idx++;
        try { await worker(items[i], i); ok++; } catch (e) { fail++; if (errors.length < 3) errors.push(e.message); }
        if (Date.now() - lastLog > 2000) {
          console.log(`  ${ok + fail}/${total} (${ok} ok, ${fail} failed)`);
          lastLog = Date.now();
        }
      }
    }),
  );
  if (fail && errors.length) for (const e of errors) console.log(`    sample error: ${e.slice(0, 200)}`);
  return { ok, fail };
}

// --- Load seed ---
const seedPath = path.join(process.cwd(), 'seed.json');
if (!existsSync(seedPath)) { console.error('No seed.json in CWD'); process.exit(1); }
const seed = JSON.parse(readFileSync(seedPath, 'utf-8'));

// Slim seed: keep the FIRST 40 products BUT make sure the ones referenced by name in
// templates/index.json (Featured Products, "Build Your Own Knife Set", etc.) are included.
// Otherwise those sections render empty on the homepage.
function collectReferencedProductHandles() {
  const handles = new Set();
  for (const dir of ['templates', 'sections', 'config', 'blocks']) {
    const full = path.join(process.cwd(), dir);
    if (!existsSync(full)) continue;
    const walk = (d) => {
      const out = [];
      for (const n of readdirSync(d)) {
        const f = path.join(d, n);
        if (statSync(f).isDirectory()) out.push(...walk(f));
        else if (f.endsWith('.json')) out.push(f);
      }
      return out;
    };
    for (const file of walk(full)) {
      const txt = readFileSync(file, 'utf-8');
      // Match "product-handle-string" entries inside "products": [...] arrays
      // and direct shopify://products/X refs.
      for (const m of txt.matchAll(/shopify:\/\/products\/([\w-]+)/g)) handles.add(m[1]);
      // Heuristic: match "products": ["a", "b"] lists used by featured/related sections
      for (const m of txt.matchAll(/"products"\s*:\s*\[([^\]]+)\]/g)) {
        for (const h of m[1].matchAll(/"([\w-]+)"/g)) handles.add(h[1]);
      }
    }
  }
  return handles;
}

let productsToCreate;
if (FULL) {
  productsToCreate = seed.products;
} else {
  const referenced = collectReferencedProductHandles();
  const byHandle = new Map(seed.products.map((p) => [p.handle, p]));
  // Always include products referenced by the theme, then fill remaining slots
  const priority = [...referenced].map((h) => byHandle.get(h)).filter(Boolean);
  const remaining = seed.products.filter((p) => !referenced.has(p.handle));
  productsToCreate = [...priority, ...remaining.slice(0, Math.max(0, SLIM_PRODUCTS - priority.length))];
  console.log(`Slim seed: ${priority.length} theme-referenced + ${productsToCreate.length - priority.length} backfill = ${productsToCreate.length} products`);
}
const articlesToCreate = FULL ? seed.articles : seed.articles.slice(0, SLIM_ARTICLES);

console.log(`\n${WRITE ? '✓ WRITE' : 'DRY-RUN'} → ${hostname}`);
console.log(`Mode: ${FULL ? 'FULL' : 'SLIM'}`);
console.log(`Plan: ${productsToCreate.length} products + ${seed.collections.length} collections + ${seed.pages.length} pages + ${articlesToCreate.length} articles`);
console.log(`Concurrency: ${CONCURRENCY}`);
if (WIPE) console.log(`Will WIPE existing products/collections/pages/articles first.`);
if (!WRITE) console.log(`\n(Pass --write to actually create.)\n`);

const startedAt = Date.now();

if (WRITE && WIPE) {
  console.log('\n=== WIPE: deleting existing dev-store content ===');
  const existing = {
    products: await paginate('products.json?fields=id'),
    custom: await paginate('custom_collections.json?fields=id'),
    smart: await paginate('smart_collections.json?fields=id'),
    pages: await paginate('pages.json?fields=id'),
    articles: await paginate('articles.json?fields=id,blog_id'),
    blogs: await paginate('blogs.json?fields=id,handle'),
  };
  await pool(existing.products, (p) => api('DELETE', `products/${p.id}.json`));
  console.log(`  deleted ${existing.products.length} products`);
  await pool(existing.custom, (c) => api('DELETE', `custom_collections/${c.id}.json`));
  await pool(existing.smart, (c) => api('DELETE', `smart_collections/${c.id}.json`));
  console.log(`  deleted ${existing.custom.length + existing.smart.length} collections`);
  await pool(existing.pages, (p) => api('DELETE', `pages/${p.id}.json`));
  console.log(`  deleted ${existing.pages.length} pages`);
  for (const a of existing.articles) {
    try { await api('DELETE', `blogs/${a.blog_id}/articles/${a.id}.json`); } catch {}
  }
  console.log(`  deleted ${existing.articles.length} articles`);
  // Also wipe Files (uploaded theme images) so re-runs don't accumulate dupes.
  // Use GraphQL fileDelete since REST doesn't expose Files.
  async function gqlWipe(query, variables) {
    const r = await fetch(`${BASE}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!r.ok) throw new Error(`graphql ${r.status}`);
    const j = await r.json();
    if (j.errors) throw new Error(JSON.stringify(j.errors));
    return j.data;
  }
  let fileCursor = null, allFileIds = [];
  while (true) {
    const data = await gqlWipe(`query($cursor: String) { files(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } edges { node { id } } } }`, { cursor: fileCursor });
    allFileIds.push(...data.files.edges.map((e) => e.node.id));
    if (!data.files.pageInfo.hasNextPage) break;
    fileCursor = data.files.pageInfo.endCursor;
  }
  if (allFileIds.length) {
    // fileDelete accepts up to ~250 IDs per call
    for (let i = 0; i < allFileIds.length; i += 100) {
      const batch = allFileIds.slice(i, i + 100);
      await gqlWipe(`mutation($ids: [ID!]!) { fileDelete(fileIds: $ids) { userErrors { field message } } }`, { ids: batch });
    }
  }
  console.log(`  deleted ${allFileIds.length} files`);
}

const created = { media: 0, products: 0, collections: 0, pages: 0, blogs: 0, articles: 0 };

// --- MEDIA: upload theme images to dev-store Files (must happen BEFORE theme push) ---
// The theme JSON references images by shopify://shop_images/{filename}. Those refs
// resolve at storefront render time by looking up filename in the store's Files.
// If we don't upload these, the logo, hero, testimonials, icons, etc. all render as empty.
const mediaManifestPath = path.join(process.cwd(), 'media-manifest.json');
const mediaDir = path.join(process.cwd(), 'media');
if (existsSync(mediaManifestPath) && existsSync(mediaDir)) {
  const manifest = JSON.parse(readFileSync(mediaManifestPath, 'utf-8'));
  const files = manifest.files ?? [];
  console.log(`\n=== Media (${files.length} images) ===`);
  if (WRITE) {
    // GraphQL endpoint for staged uploads + fileCreate
    async function gql(query, variables) {
      while (true) {
        const r = await fetch(`${BASE}/admin/api/2024-10/graphql.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables }),
        });
        if (r.status === 429) {
          await sleep(parseFloat(r.headers.get('retry-after') || '2') * 1000);
          continue;
        }
        if (!r.ok) throw new Error(`graphql ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const j = await r.json();
        if (j.errors) throw new Error(JSON.stringify(j.errors));
        return j.data;
      }
    }
    // List existing files on dev store so --wipe-equivalent (idempotent) skipping works:
    // we re-upload by filename even if present (Shopify creates a new version).
    const mimeByExt = { webp: 'image/webp', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };
    const uploadedIds = [];
    const res = await pool(files, async (entry) => {
      const localPath = path.join(mediaDir, entry.filename);
      // (concurrency=8 below)
      if (!existsSync(localPath)) throw new Error(`local missing: ${entry.filename}`);
      const buf = readFileSync(localPath);
      const ext = path.extname(entry.filename).slice(1).toLowerCase();
      const mime = mimeByExt[ext] || 'application/octet-stream';
      // 1) staged upload
      const staged = await gql(`mutation($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { field message }
        }
      }`, { input: [{ filename: entry.filename, mimeType: mime, httpMethod: 'POST', resource: 'FILE', fileSize: String(buf.byteLength) }] });
      const errs1 = staged.stagedUploadsCreate.userErrors;
      if (errs1.length) throw new Error(`staged: ${JSON.stringify(errs1)}`);
      const target = staged.stagedUploadsCreate.stagedTargets[0];
      // 2) POST to storage URL
      const fd = new FormData();
      for (const p of target.parameters) fd.append(p.name, p.value);
      fd.append('file', new Blob([buf], { type: mime }), entry.filename);
      const upRes = await fetch(target.url, { method: 'POST', body: fd });
      if (!upRes.ok && upRes.status !== 201) throw new Error(`storage upload ${upRes.status}`);
      // 3) fileCreate
      const created = await gql(`mutation($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files { id alt fileStatus }
          userErrors { field message code }
        }
      }`, { files: [{ originalSource: target.resourceUrl, contentType: ext === 'svg' ? 'FILE' : 'IMAGE', filename: entry.filename }] });
      const errs2 = created.fileCreate.userErrors;
      if (errs2.length) throw new Error(`fileCreate: ${JSON.stringify(errs2)}`);
      uploadedIds.push(created.fileCreate.files[0].id);
    }, 8);
    created.media = res.ok;
    console.log(`  ${res.ok} uploaded, ${res.fail} failed`);
    // Wait for all uploads to be READY before continuing. By the time we get here,
    // most have already processed (Shopify is usually <1s per image), so poll quickly.
    if (uploadedIds.length) {
      console.log(`  waiting for files to be READY...`);
      // Batch in groups of 50 to stay under GraphQL cost limit
      const start = Date.now();
      let allReady = false;
      for (let i = 0; i < 20; i++) {
        await sleep(1500);
        let ready = 0, failed = 0;
        for (let off = 0; off < uploadedIds.length; off += 50) {
          const batch = uploadedIds.slice(off, off + 50);
          const queryNodes = batch.map((id, j) => `n${j}: node(id: "${id}") { ... on MediaImage { fileStatus } ... on File { fileStatus } }`).join('\n');
          const q = await gql(`query { ${queryNodes} }`, {});
          for (const n of Object.values(q)) {
            if (n?.fileStatus === 'READY') ready++;
            else if (n?.fileStatus === 'FAILED') failed++;
          }
        }
        if (i % 2 === 0) console.log(`    ready: ${ready}/${uploadedIds.length} (${Math.round((Date.now() - start) / 1000)}s)`);
        if (ready + failed === uploadedIds.length) { allReady = true; break; }
      }
      if (!allReady) console.log(`  ⚠ some files still processing — theme may show empty images on first load`);
    }
  } else created.media = files.length;
} else {
  console.log('\n(No media-manifest.json or media/ dir — skipping image upload. Theme will have empty image fields.)');
}

// --- PRODUCTS (parallel) ---
console.log(`\n=== Products (${productsToCreate.length}) ===`);
if (WRITE) {
  const res = await pool(productsToCreate, async (p) => {
    await api('POST', 'products.json', {
      product: {
        title: p.title, body_html: p.body_html, handle: p.handle,
        product_type: p.product_type, vendor: p.vendor, tags: p.tags,
        options: p.options, images: p.images, variants: p.variants,
      },
    });
  });
  created.products = res.ok;
  console.log(`  ${res.ok} created, ${res.fail} failed`);
} else created.products = productsToCreate.length;

// --- COLLECTIONS (parallel) ---
console.log(`\n=== Collections (${seed.collections.length}) ===`);
if (WRITE) {
  const res = await pool(seed.collections, async (c) => {
    const endpoint = c.type === 'smart' ? 'smart_collections.json' : 'custom_collections.json';
    const key = c.type === 'smart' ? 'smart_collection' : 'custom_collection';
    const body = c.type === 'smart'
      ? { [key]: { title: c.title, handle: c.handle, body_html: c.body_html, sort_order: c.sort_order, image: c.image, disjunctive: c.disjunctive, rules: c.rules } }
      : { [key]: { title: c.title, handle: c.handle, body_html: c.body_html, sort_order: c.sort_order, image: c.image } };
    await api('POST', endpoint, body);
  });
  created.collections = res.ok;
  console.log(`  ${res.ok} created, ${res.fail} failed`);
} else created.collections = seed.collections.length;

// --- PAGES (parallel) ---
console.log(`\n=== Pages (${seed.pages.length}) ===`);
if (WRITE) {
  const res = await pool(seed.pages, async (p) => {
    await api('POST', 'pages.json', { page: { title: p.title, handle: p.handle, body_html: p.body_html, published: true } });
  });
  created.pages = res.ok;
  console.log(`  ${res.ok} created, ${res.fail} failed`);
} else created.pages = seed.pages.length;

// --- BLOGS + ARTICLES ---
console.log(`\n=== Blogs + Articles (${articlesToCreate.length}) ===`);
const blogHandleToId = new Map();
if (WRITE) {
  for (const b of seed.blogs) {
    try {
      const resp = await api('POST', 'blogs.json', { blog: { title: b.title, handle: b.handle } });
      blogHandleToId.set(b.handle, resp.blog.id);
      created.blogs++;
    } catch {}
  }
  // Default blog fallback
  if (!blogHandleToId.size) {
    const resp = await api('POST', 'blogs.json', { blog: { title: 'News', handle: 'news' } });
    blogHandleToId.set('news', resp.blog.id);
    created.blogs++;
  }
  const fallback = [...blogHandleToId.values()][0];
  const res = await pool(articlesToCreate, async (a) => {
    const blogId = blogHandleToId.get(a.blog_handle) ?? fallback;
    await api('POST', `blogs/${blogId}/articles.json`, {
      article: { title: a.title, handle: a.handle, body_html: a.body_html, tags: a.tags, image: a.image, published: true },
    });
  });
  created.articles = res.ok;
  console.log(`  ${res.ok} created, ${res.fail} failed`);
} else { created.blogs = seed.blogs.length; created.articles = articlesToCreate.length; }

const elapsed = Math.round((Date.now() - startedAt) / 1000);
console.log(`\n=== Summary (${elapsed}s) ===`);
console.log(JSON.stringify(created, null, 2));
console.log(`\n${WRITE ? '✓ Done.' : 'DRY RUN — pass --write to create.'}`);
if (WRITE) {
  console.log(`\nNext: push the Liquid theme:`);
  console.log(`  node scripts/push-theme.mjs --write`);
}
