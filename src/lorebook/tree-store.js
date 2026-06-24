// tree-store.js — a tree ("channel ToC") over the book's entries.
// v0: build the tree FROM entry metadata (path field in comment/group), not from
// a separate fragile store — survives book export/import.
//
// A node path is encoded in an entry as a comment line like:
//   [TREE: Characters/Sable]
// Without the marker the entry lands in the root "Uncategorized" node.
//
// Markers: 🟢 (pure read/parse).

import { readEntries } from './lorebook-service.js';

const PATH_RE = /\[TREE:\s*([^\]]+)\]/i;
// Internal entries of our layer that are NOT shown in the tree/ToC
// (graph manifest — internal JSON index, disable:true).
const INTERNAL_RE = /tier=manifest|origin=graph/i;

function isInternal(entry) { return INTERNAL_RE.test(String(entry?.comment ?? '')); }

function pathOf(entry) {
  const src = `${entry.comment ?? ''}`;
  const m = src.match(PATH_RE);
  return (m ? m[1] : 'Uncategorized').split('/').map((s) => s.trim()).filter(Boolean);
}

function titleOf(entry) {
  // priority: comment without marker → key[0] → first words of content
  const c = `${entry.comment ?? ''}`.replace(PATH_RE, '').trim();
  if (c) return c;
  if (Array.isArray(entry.key) && entry.key[0]) return entry.key[0];
  return `${entry.content ?? ''}`.slice(0, 40) || 'entry';
}

/** Build the tree: { name, children:Map, entries:[] }. */
export async function buildTree() {
  const entries = await readEntries();
  const root = { name: '(root)', children: new Map(), entries: [] };
  for (const e of entries) {
    if (isInternal(e)) continue;        // graph manifest is not part of the ToC
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

/** Compact ToC for injection (without full entry content). */
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

/** Fetch full content of specific branches by name (for the agent). */
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
