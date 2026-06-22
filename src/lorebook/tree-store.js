// tree-store.js — дерево («оглавление каналов») поверх энтри книги.
// v0: строим дерево ИЗ метаданных энтри (поле пути в comment/group), не из
// отдельного хрупкого стора — переживает экспорт/импорт книги.
//
// Путь узла кодируем в энтри так: первая строка comment вида
//   [TREE: Characters/Sable]
// Если метки нет — энтри попадает в корневой узел "Uncategorized".
//
// Метки: 🟢 (чистое чтение/парсинг).

import { readEntries } from './lorebook-service.js';

const PATH_RE = /\[TREE:\s*([^\]]+)\]/i;
// Служебные энтри нашего слоя, которые НЕ показываем в дереве/оглавлении
// (граф-manifest — внутренний JSON-индекс, disable:true).
const INTERNAL_RE = /tier=manifest|origin=graph/i;

function isInternal(entry) { return INTERNAL_RE.test(String(entry?.comment ?? '')); }

function pathOf(entry) {
  const src = `${entry.comment ?? ''}`;
  const m = src.match(PATH_RE);
  return (m ? m[1] : 'Uncategorized').split('/').map((s) => s.trim()).filter(Boolean);
}

function titleOf(entry) {
  // приоритет: comment без метки → key[0] → первые слова content
  const c = `${entry.comment ?? ''}`.replace(PATH_RE, '').trim();
  if (c) return c;
  if (Array.isArray(entry.key) && entry.key[0]) return entry.key[0];
  return `${entry.content ?? ''}`.slice(0, 40) || 'entry';
}

/** Построить дерево: { name, children:Map, entries:[] }. */
export async function buildTree() {
  const entries = await readEntries();
  const root = { name: '(root)', children: new Map(), entries: [] };
  for (const e of entries) {
    if (isInternal(e)) continue;        // граф-manifest не часть оглавления
    const segs = pathOf(e);
    let node = root;
    for (const seg of segs) {
      if (!node.children.has(seg)) node.children.set(seg, { name: seg, children: new Map(), entries: [] });
      node = node.children.get(seg);
    }
    node.entries.push({ uid: e.uid, title: titleOf(e), content: `${e.content ?? ''}` });
  }
  return root;
}

/** Компактное оглавление для инъекции (без полного содержимого энтри). */
export async function renderToc() {
  const root = await buildTree();
  const lines = [];
  const walk = (node, depth) => {
    for (const [name, child] of node.children) {
      const n = child.entries.length;
      lines.push(`${'  '.repeat(depth)}- ${name}${n ? ` (${n})` : ''}`);
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  if (!lines.length) return '';
  return `[Memory map — branches available in this lorebook]\n${lines.join('\n')}`;
}

/** Достать полное содержимое конкретных веток по их именам (для агента). */
export async function getBranchContent(branchNames) {
  const root = await buildTree();
  const out = [];
  const want = new Set(branchNames.map((b) => b.toLowerCase()));
  const walk = (node, trail) => {
    for (const [name, child] of node.children) {
      const path = [...trail, name].join('/');
      if (want.has(name.toLowerCase()) || want.has(path.toLowerCase())) {
        for (const e of child.entries) out.push(`### ${e.title}\n${e.content}`);
      }
      walk(child, [...trail, name]);
    }
  };
  walk(root, []);
  return out.join('\n\n');
}
