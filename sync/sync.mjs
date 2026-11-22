// Раз в час: смотрит публичные папки Яндекс Диска и добавляет в таблицу ролики,
// которые лежат в каталоге «ПРИНЯТО К РЕЛИЗУ» и которых в таблице ещё нет.
// Ничего не удаляет и не меняет уже заполненные поля.
//
// Переменные окружения:
//   SUPABASE_URL          адрес проекта
//   SUPABASE_SERVICE_KEY  секретный ключ (service_role / secret) - только в секретах GitHub
//   YADISK_SOURCES        публичные ссылки на папки, по одной в строке.
//                         Можно указать автора: "https://disk.yandex.ru/d/xxxx = Лера"
//   DRY_RUN=1             только показать, что было бы сделано

const AUTHORS = ["Леша", "Миша", "Саша", "Лера", "Алекс", "Ратибор"];
const RELEASE_DIR = "принято к релизу";
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|avi|webm)$/i;
const MAX_DEPTH = 6;

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, YADISK_SOURCES } = process.env;
const DRY = /^(1|true|yes)$/i.test(process.env.DRY_RUN || "");

const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
const stem = (name) => name.replace(/\.[^.]+$/, "");

function parseSources(text) {
  return String(text || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
    const i = l.indexOf("=", l.indexOf("://") + 3);
    return i > 0 ? { url: l.slice(0, i).trim(), author: l.slice(i + 1).trim() } : { url: l, author: "" };
  });
}

async function listDir(publicKey, path) {
  const items = [];
  for (let offset = 0; ; offset += 200) {
    const u = new URL(process.env.YADISK_API || "https://cloud-api.yandex.net/v1/disk/public/resources");
    u.searchParams.set("public_key", publicKey);
    u.searchParams.set("path", path);
    u.searchParams.set("limit", "200");
    u.searchParams.set("offset", String(offset));
    const r = await fetch(u);
    if (!r.ok) throw new Error(`Яндекс Диск ответил ${r.status} на папку ${path}`);
    const j = await r.json();
    const page = (j._embedded && j._embedded.items) || [];
    items.push(...page);
    if (page.length < 200) break;
  }
  return items;
}

// Автор: явно заданный у ссылки, иначе имя автора в любой части пути.
function authorOf(path, fallback) {
  if (fallback) return fallback;
  const parts = path.split("/").map(norm);
  for (const a of AUTHORS) if (parts.some((p) => p.split(/[^a-zа-я0-9]+/i).includes(norm(a)))) return a;
  return "";
}

async function collect(source, n) {
  const found = [];
  async function walk(path, depth, inside) {
    for (const it of await listDir(source.url, path)) {
      if (it.type === "dir") {
        const here = inside || norm(it.name) === RELEASE_DIR;
        if (depth < MAX_DEPTH) await walk(it.path, depth + 1, here);
      } else if (inside && (it.media_type === "video" || VIDEO_EXT.test(it.name))) {
        found.push({
          key: `${n}:${it.path}`,
          file: stem(it.name),
          author: authorOf(it.path, source.author),
          added: String(it.created || it.modified || new Date().toISOString()).slice(0, 10),
        });
      }
    }
  }
  await walk("/", 0, false);
  return found;
}

async function db(method, path, body, prefer) {
  const headers = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`База ответила ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

async function main() {
  const sources = parseSources(YADISK_SOURCES);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Не заданы SUPABASE_URL и SUPABASE_SERVICE_KEY");
  if (!sources.length) throw new Error("Не задан YADISK_SOURCES - нет ни одной ссылки на папку");

  const files = [];
  for (let i = 0; i < sources.length; i++) files.push(...(await collect(sources[i], i + 1)));
  console.log(`На диске в «ПРИНЯТО К РЕЛИЗУ» найдено видео: ${files.length}`);

  const rows = await db("GET", "shorts?select=id,author,file,disk_path&limit=5000");
  const known = new Set(rows.map((r) => r.disk_path).filter(Boolean));
  const free = rows.filter((r) => !r.disk_path); // строки, заведённые руками или из старой таблицы

  const link = [], add = [];
  for (const f of files) {
    if (known.has(f.key)) continue;
    const i = free.findIndex((r) => norm(r.file) === norm(f.file) && (!r.author || !f.author || r.author === f.author));
    if (i >= 0) link.push({ id: free.splice(i, 1)[0].id, f });
    else add.push(f);
    known.add(f.key);
  }

  console.log(`Уже в таблице, привязываю к файлу: ${link.length}`);
  console.log(`Новых роликов: ${add.length}`);
  for (const f of add) console.log(`  + ${f.author || "автор не определён"} / ${f.file}`);
  if (DRY) { console.log("Пробный запуск: в базу ничего не записано."); return; }

  for (const { id, f } of link) await db("PATCH", `shorts?id=eq.${id}`, { disk_path: f.key }, "return=minimal");
  if (add.length) {
    const now = Date.now();
    await db("POST", "shorts", add.map((f, i) => ({ author: f.author, file: f.file, added: f.added, ord: now + i, disk_path: f.key })), "return=minimal");
  }
  console.log("Готово.");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
