// Раз в час: смотрит публичные папки Яндекс Диска и добавляет в таблицу ролики,
// которые лежат в каталоге «ПРИНЯТО К РЕЛИЗУ» и которых в таблице ещё нет.
// Если ролик с диска исчез (удалили или перенесли), его строка скрывается из таблицы -
// так же, как кнопкой «Удалить» на сайте. Заполненные поля не меняет, файлы на диске не трогает.
// Если рядом с роликом лежит текстовый файл с тем же именем (ролик.mp4 + ролик.txt), из него
// берутся название, описание и заметка - но только в пустые поля строки.
// Если рядом лежит картинка с тем же именем (ролик.jpg / .png / .webp), это превью:
// у строки ставится «Превью готово».
//
// Переменные окружения:
//   SUPABASE_URL          адрес проекта
//   SUPABASE_SERVICE_KEY  секретный ключ (service_role / secret) - только в секретах GitHub
//   YADISK_SOURCES        публичные ссылки на папки, по одной в строке.
//                         Можно указать автора: "https://disk.yandex.ru/d/xxxx = Лера"
//   YADISK_ALL_SOURCES    то же, но из этих папок берутся ВСЕ видео, без каталога
//                         «Принято к релизу» (папка, куда ролики кладёт телеграм-бот)
//                         Если обе переменные со ссылками не заданы, ссылки берутся из таблицы
//                         settings (yadisk_sources, yadisk_all_sources) - те же, что у кнопки на сайте.
//   DRY_RUN=1             только показать, что было бы сделано

const AUTHORS = ["Леша", "Миша", "Саша", "Лера", "Алекс", "Ратибор", "Даня"];
// Папка названа не именем автора из таблицы: чьи это ролики.
const FOLDER_OWNERS = { "никита": "Лера" };
// Каталог с принятыми роликами: «Принято к релизу», «Принят», «Принято», «Принял».
const isReleaseDir = (name) => /^(принят|принял)/.test(norm(name));
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|avi|webm)$/i;
const MAX_DEPTH = 6;

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, YADISK_SOURCES, YADISK_ALL_SOURCES } = process.env;
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
    // Диск иногда отвечает 500 или 429 на ровном месте - пробуем до трёх раз.
    let r;
    for (let attempt = 1; ; attempt++) {
      r = await fetch(u).catch(() => null);
      if (r && r.ok) break;
      if (attempt >= 3 || (r && r.status < 500 && r.status !== 429)) throw new Error(`Яндекс Диск ответил ${r ? r.status : "обрывом связи"} на папку ${path}`);
      await new Promise((res) => setTimeout(res, 3000 * attempt));
    }
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
  const words = norm(path).split(/[^a-zа-я0-9]+/i).filter(Boolean);
  for (const [word, owner] of Object.entries(FOLDER_OWNERS)) if (words.some((w) => w.startsWith(word))) return owner;
  for (const a of AUTHORS) if (words.some((w) => w.startsWith(norm(a)))) return a; // «Шортсы Ратибора» -> Ратибор
  return "";
}

// Текстовый файл рядом с роликом. С подписями «Название: / Описание: / Заметка:»
// или без них: тогда первая строка - название, остальное - описание.
function parseMeta(text) {
  const meta = { title: "", descr: "", note: "" };
  const keys = { "название": "title", "описание": "descr", "заметка": "note" };
  const lines = String(text || "").replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trimEnd());
  if (!lines.some((l) => l.trim())) return null;
  if (!lines.some((l) => /^\s*(название|описание|заметка)\s*:/i.test(l))) {
    const i = lines.findIndex((l) => l.trim());
    meta.title = lines[i].trim();
    meta.descr = lines.slice(i + 1).join("\n").trim();
    return meta;
  }
  let cur = null;
  for (const l of lines) {
    const m = l.match(/^\s*(название|описание|заметка)\s*:\s*(.*)$/i);
    if (m) { cur = keys[m[1].toLowerCase()]; meta[cur] = m[2]; }
    else if (cur) meta[cur] += "\n" + l;
  }
  for (const k of Object.keys(meta)) meta[k] = meta[k].trim();
  return meta;
}

async function readMeta(f) {
  if (!f.txt || f.txt.size > 200000) return null;
  try {
    let href = f.txt.file;
    if (!href) {
      const u = new URL((process.env.YADISK_API || "https://cloud-api.yandex.net/v1/disk/public/resources") + "/download");
      u.searchParams.set("public_key", f.src);
      u.searchParams.set("path", f.txt.path);
      href = (await (await fetch(u)).json()).href;
    }
    const r = await fetch(href);
    if (!r.ok) throw new Error(`код ${r.status}`);
    return parseMeta(await r.text());
  } catch (e) {
    console.log(`  не смог прочитать текстовый файл к «${f.file}»: ${e.message}`);
    return null;
  }
}
// Что из текстового файла можно дописать в строку: только в пустые поля.
function fillEmpty(row, meta) {
  const patch = {};
  for (const k of ["title", "descr", "note"]) if (meta && meta[k] && !String(row[k] || "").trim()) patch[k] = meta[k];
  return patch;
}

async function collect(source, n, all = false) {
  const found = [];
  async function walk(path, depth, inside) {
    const items = await listDir(source.url, path);
    const texts = new Map(items.filter((it) => it.type === "file" && /\.txt$/i.test(it.name)).map((it) => [norm(stem(it.name)), it]));
    const images = new Set(items.filter((it) => it.type === "file" && /\.(jpe?g|png|webp)$/i.test(it.name)).map((it) => norm(stem(it.name))));
    for (const it of items) {
      if (it.type === "dir") {
        const here = inside || isReleaseDir(it.name);
        if (depth < MAX_DEPTH) await walk(it.path, depth + 1, here);
      } else if (inside && (it.media_type === "video" || VIDEO_EXT.test(it.name))) {
        found.push({
          key: `${n}:${it.path}`,
          file: stem(it.name),
          folder: all ? "" : path.split("/").pop().replace(/^\d+\.\s*/, ""), // «3. Улун» -> «Улун»
          author: authorOf(it.path, source.author),
          added: String(it.created || it.modified || new Date().toISOString()).slice(0, 10),
          txt: texts.get(norm(stem(it.name))) || null,
          img: images.has(norm(stem(it.name))),
          src: source.url,
        });
      }
    }
  }
  await walk("/", 0, all);
  return found;
}

// Строки, чьих файлов на диске больше нет. Смотрим только папки, которые сейчас обошли.
// Предохранитель: если в одной папке пропало больше половины роликов (и больше пяти) -
// это похоже на сбой или смену ссылки, такие строки не трогаем.
function findGone(rows, present, scanned) {
  const prefix = (k) => k.slice(0, k.indexOf(":"));
  const gone = [];
  for (const p of scanned) {
    const mine = rows.filter((r) => r.disk_path && !r.deleted && prefix(r.disk_path) === p);
    const miss = mine.filter((r) => !present.has(r.disk_path));
    if (miss.length > 5 && miss.length > mine.length / 2) {
      console.log(`Папка ${p}: на диске не нашлось ${miss.length} из ${mine.length} роликов - слишком много, строки не скрываю.`);
      continue;
    }
    gone.push(...miss);
  }
  return gone;
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
  const noDb = !SUPABASE_URL || !SUPABASE_SERVICE_KEY;
  if (noDb && !DRY) throw new Error("Не заданы SUPABASE_URL и SUPABASE_SERVICE_KEY");
  let srcText = YADISK_SOURCES, allText = YADISK_ALL_SOURCES;
  if (!noDb && !srcText && !allText) {
    const st = await db("GET", "settings?select=key,value");
    const setting = (k) => (st.find((x) => x.key === k) || {}).value || "";
    srcText = setting("yadisk_sources");
    allText = setting("yadisk_all_sources");
  }
  const sources = parseSources(srcText);
  const allSources = parseSources(allText);
  if (!sources.length && !allSources.length) throw new Error("Не задан YADISK_SOURCES - нет ни одной ссылки на папку");

  const files = [];
  for (let i = 0; i < sources.length; i++) files.push(...(await collect(sources[i], i + 1)));
  console.log(`На диске в «ПРИНЯТО К РЕЛИЗУ» найдено видео: ${files.length}`);
  const before = files.length;
  for (let i = 0; i < allSources.length; i++) files.push(...(await collect(allSources[i], `all${i + 1}`, true)));
  if (allSources.length) console.log(`В папках, где берётся всё, найдено видео: ${files.length - before}`);

  if (noDb) console.log("База не подключена: сравниваю с пустой таблицей.");
  const rows = noDb ? [] : await db("GET", "shorts?select=id,author,file,disk_path,deleted,title,descr,note,preview_ready&limit=5000");
  const scanned = [...sources.map((_, i) => String(i + 1)), ...allSources.map((_, i) => `all${i + 1}`)];
  const gone = findGone(rows, new Set(files.map((f) => f.key)), scanned);
  const known = new Set(rows.map((r) => r.disk_path).filter(Boolean));
  const free = rows.filter((r) => !r.disk_path); // строки, заведённые руками или из старой таблицы

  const byPath = new Map(rows.filter((r) => r.disk_path).map((r) => [r.disk_path, r]));
  const link = [], add = [], fill = [];
  for (const f of files) {
    if (known.has(f.key)) {
      // Строка уже есть: если у неё пустые поля, а рядом с роликом лежит текст - дописываем.
      const row = byPath.get(f.key);
      if (row && !row.deleted) {
        const patch = f.txt && ["title", "descr"].some((k) => !String(row[k] || "").trim()) ? fillEmpty(row, await readMeta(f)) : {};
        if (f.img && !row.preview_ready) patch.preview_ready = true;
        if (Object.keys(patch).length) fill.push({ id: row.id, f, patch });
      }
      continue;
    }
    const i = free.findIndex((r) => (norm(r.file) === norm(f.file) || (f.folder && norm(r.file) === norm(f.folder))) && (!r.author || !f.author || r.author === f.author));
    const meta = f.txt ? await readMeta(f) : null;
    if (i >= 0) { const row = free.splice(i, 1)[0]; link.push({ id: row.id, f, patch: { ...fillEmpty(row, meta), ...(f.img && !row.preview_ready ? { preview_ready: true } : {}) } }); }
    else add.push({ ...f, meta: meta || {} });
    known.add(f.key);
  }

  console.log(`Уже в таблице, привязываю к файлу: ${link.length}`);
  console.log(`Новых роликов: ${add.length}`);
  for (const f of add) console.log(`  + ${f.author || "автор не определён"} / ${f.file}${f.meta.title ? ` - «${f.meta.title}»` : ""}`);
  console.log(`Дописываю из файлов рядом с роликом (название, описание, превью): ${fill.length}`);
  for (const x of fill) console.log(`  ~ ${x.f.author || "автор не определён"} / ${x.f.file}: ${Object.keys(x.patch).join(", ")}`);
  console.log(`Пропали с диска, скрываю из таблицы: ${gone.length}`);
  for (const r of gone) console.log(`  - ${r.author || "автор не определён"} / ${r.file}`);
  if (DRY) { console.log("Пробный запуск: в базу ничего не записано."); return; }

  for (const { id, f, patch } of link) await db("PATCH", `shorts?id=eq.${id}`, { disk_path: f.key, ...patch }, "return=minimal");
  for (const { id, patch } of fill) await db("PATCH", `shorts?id=eq.${id}`, patch, "return=minimal");
  if (add.length) {
    const now = Date.now();
    await db("POST", "shorts", add.map((f, i) => ({ author: f.author, file: f.file, added: f.added, ord: now + i, disk_path: f.key, title: f.meta.title || "", descr: f.meta.descr || "", note: f.meta.note || "", preview_ready: !!f.img })), "return=minimal");
  }
  for (const r of gone) await db("PATCH", `shorts?id=eq.${r.id}`, { deleted: true }, "return=minimal");
  console.log("Готово.");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
