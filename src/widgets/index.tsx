/**
 * Agent Bridge — lets any AI agent (Claude Code, Codex, …) that can only reach RemNote through the
 * RemNote MCP server apply edits the MCP cannot make: multi-line rems with full formatting
 * (underline, colour, highlight, superscript), image display size, heading size, moving rems,
 * document flag, PDF/URL sources.
 *
 * Protocol (plain rems, written with ordinary MCP calls):
 *   The plugin keeps a top-level document named QUEUE_DOC. An agent appends one or more child rems
 *       AGENTJOB <jobId> <part>/<total> <hex of UTF-8 JSON chunk>
 *   (hex so the MCP markdown parser cannot turn any character into a flashcard; keep each rem
 *   under ~2500 chars because the MCP splits longer text into a second rem).
 *   Joined JSON: { "v": 1, "job": "<jobId>", "ops": [ ... ] }
 *   The plugin reacts to the queue changing (no polling), applies the ops, removes the job rems and
 *   appends   AGENTRESULT <jobId> ok=<n> failed=<m> <first errors>   which the agent reads back.
 * Ops:
 *   {op:"setText", rem, text: RichTextInterface}          replace a rem's text
 *   {op:"imageSize", rem, width, height?}                 display size of the image(s) in a rem
 *   {op:"imagesUnder", rem, widths:[...]}                 size images under rem, in document order,
 *                                                          only those with no width yet
 *   {op:"setParent", rem, parent, position?}
 *   {op:"setIsDocument", rem, value}
 *   {op:"setFontSize", rem, size: "H1"|"H2"|"H3"|null}
 *   {op:"addSource", rem, source}
 *   {op:"setHighlightColor", rem, color}
 *   {op:"addTag", rem, tag}                               tag a rem (tag = rem id, e.g. Extra Card Detail)
 * Safety: text/image ops refuse rems that hold flashcard data (cloze ids, back text, occlusion
 * blocks). Only rems inside QUEUE_DOC are read as instructions. Nothing leaves RemNote.
 */
import { AppEvents, declareIndexPlugin, type ReactRNPlugin, type RichTextInterface } from '@remnote/plugin-sdk';
import '../style.css';
import '../index.css';

const QUEUE_DOC = 'Agent Bridge Queue';
const JOB_RE = /^(?:AGENTJOB|CLAUDEJOB) (\S+) (\d+)\/(\d+) ([0-9a-f]+)$/;
const KEEP_RESULTS = 20;
const K_PAUSED = 'paused';
const S_TOASTS = 'toasts';

type Op = { op: string; rem?: string; [k: string]: any };

function hexToString(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return new TextDecoder().decode(bytes);
}

function plain(rt: RichTextInterface | undefined): string {
  return (rt || []).map((p: any) => (typeof p === 'string' ? p : p.text ?? '')).join('');
}

function hasCardData(rem: any): boolean {
  const parts: any[] = [...(rem.text || []), ...(rem.backText || [])];
  return (rem.backText && rem.backText.length > 0) || parts.some((p) => typeof p === 'object' && (p.cId || p.blocks));
}

function sized(text: any[], width: number, height?: number) {
  return text.map((p: any) => {
    if (typeof p === 'object' && p.i === 'i') {
      const q: any = { ...p, width };
      if (height) q.height = height;
      else if (p.width && p.height) q.height = (p.height * width) / p.width;
      else delete q.height;
      delete q.percent;
      return q;
    }
    return p;
  });
}

let queueId: string | undefined;
let running = false;
let again = false;
let debounce: ReturnType<typeof setTimeout> | undefined;

async function getQueue(plugin: ReactRNPlugin, create: boolean) {
  let q = await plugin.rem.findByName([QUEUE_DOC], null);
  if (!q && create) {
    q = await plugin.rem.createRem();
    if (q) {
      await q.setText([QUEUE_DOC]);
      await q.setIsDocument(true);
    }
  }
  queueId = q?._id;
  return q;
}

function schedule(plugin: ReactRNPlugin, via: string) {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => applyQueue(plugin, via, true), 800);
}

async function applyQueue(plugin: ReactRNPlugin, via: string, quiet: boolean) {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    if (quiet && (await plugin.storage.getSynced<boolean>(K_PAUSED))) return;
    const toasts = !quiet || (await plugin.settings.getSetting<boolean>(S_TOASTS));
    await plugin.app.registerCommand({
    id: 'agent-bridge-toggle',
    name: 'Agent Bridge: pause / resume',
    action: async () => {
      const paused = !(await plugin.storage.getSynced<boolean>(K_PAUSED));
      await plugin.storage.setSynced(K_PAUSED, paused);
      await plugin.app.toast(paused ? 'Agent Bridge paused: agent edits wait in the queue' : 'Agent Bridge on');
      if (!paused) schedule(plugin, 'resume');
    },
  });

  const queue = await getQueue(plugin, true);
    if (!queue) return;
    const children = await queue.getChildrenRem();
    const jobs = new Map<string, { parts: Map<number, string>; total: number; rems: any[] }>();
    const results: any[] = [];
    for (const c of children) {
      const t = plain(c.text).trim();
      if (t.startsWith('AGENTRESULT ')) results.push(c);
      const m = t.match(JOB_RE);
      if (!m) continue;
      const [, id, part, total, hex] = m;
      const j = jobs.get(id) || { parts: new Map<number, string>(), total: Number(total), rems: [] as any[] };
      j.parts.set(Number(part), hex);
      j.rems.push(c);
      jobs.set(id, j);
    }
    if (jobs.size === 0) {
      if (!quiet) await plugin.app.toast('Agent Bridge: nothing queued');
      return;
    }
    for (const [id, j] of jobs) {
      if (j.parts.size !== j.total) continue; // agent is still writing parts
      let ok = 0;
      const errors: string[] = [];
      let ops: Op[] = [];
      try {
        const hex = Array.from({ length: j.total }, (_, i) => j.parts.get(i + 1)).join('');
        ops = JSON.parse(hexToString(hex)).ops || [];
      } catch (e: any) {
        errors.push(`decode: ${e?.message || e}`);
      }
      for (const o of ops) {
        try {
          await applyOp(plugin, o);
          ok++;
        } catch (e: any) {
          errors.push(`${o.op} ${o.rem}: ${e?.message || e}`);
        }
      }
      for (const r of j.rems) await r.remove();
      const res = await plugin.rem.createRem();
      if (res) {
        await res.setText([`AGENTRESULT ${id} ok=${ok} failed=${errors.length} via=${via} ${errors.slice(0, 5).join(' | ')}`]);
        await res.setParent(queue);
        results.push(res);
      }
      if (toasts) await plugin.app.toast(`Agent Bridge: ${ok} edit(s) applied${errors.length ? `, ${errors.length} failed` : ''}`);
    }
    for (const r of results.slice(0, Math.max(0, results.length - KEEP_RESULTS))) await r.remove();
  } finally {
    running = false;
    if (again) {
      again = false;
      schedule(plugin, 'rerun');
    }
  }
}

async function applyOp(plugin: ReactRNPlugin, o: Op) {
  const rem = await plugin.rem.findOne(o.rem);
  if (!rem) throw new Error('rem not found');
  switch (o.op) {
    case 'setText':
      if (hasCardData(rem)) throw new Error('refused: rem has flashcard data');
      await rem.setText(o.text as RichTextInterface);
      return;
    case 'imageSize':
      if (hasCardData(rem)) throw new Error('refused: rem has flashcard data');
      await rem.setText(sized(rem.text || [], o.width, o.height) as RichTextInterface);
      return;
    case 'imagesUnder': {
      const widths: number[] = [...(o.widths || [])];
      for (const d of await rem.getDescendants()) {
        if (!widths.length) break;
        const img = (d.text || []).find((p: any) => typeof p === 'object' && p.i === 'i') as any;
        if (!img || img.width || hasCardData(d)) continue;
        await d.setText(sized(d.text || [], widths.shift() as number) as RichTextInterface);
      }
      return;
    }
    case 'setParent':
      await rem.setParent(o.parent, o.position);
      return;
    case 'setIsDocument':
      await rem.setIsDocument(!!o.value);
      return;
    case 'setFontSize':
      await rem.setFontSize(o.size ?? undefined);
      return;
    case 'addSource':
      await rem.addSource(o.source);
      return;
    case 'addTag':
      await rem.addTag(o.tag);
      return;
    case 'setHighlightColor':
      await rem.setHighlightColor(o.color);
      return;
    default:
      throw new Error(`unknown op ${o.op}`);
  }
}

async function onActivate(plugin: ReactRNPlugin) {
  await plugin.settings.registerBooleanSetting({
    id: S_TOASTS,
    title: 'Show a small notice when edits are applied',
    defaultValue: false,
  });

  await plugin.app.registerCommand({
    id: 'agent-bridge-apply',
    name: 'Agent Bridge: apply queued edits now',
    action: async () => applyQueue(plugin, 'command', false),
  });

  await plugin.app.registerCommand({
    id: 'agent-bridge-toggle',
    name: 'Agent Bridge: pause / resume',
    action: async () => {
      const paused = !(await plugin.storage.getSynced<boolean>(K_PAUSED));
      await plugin.storage.setSynced(K_PAUSED, paused);
      await plugin.app.toast(paused ? 'Agent Bridge paused: agent edits wait in the queue' : 'Agent Bridge on');
      if (!paused) schedule(plugin, 'resume');
    },
  });

  const queue = await getQueue(plugin, true);
  // Event-driven: react when the queue document (or anything inside it) changes. No polling.
  if (queueId) plugin.event.addListener(AppEvents.RemChanged, queueId, () => schedule(plugin, 'queue'));
  plugin.event.addListener(AppEvents.GlobalRemChanged, undefined, async (args: any) => {
    if (!queueId || !args?.remId) return;
    const r = await plugin.rem.findOne(args.remId);
    if (r && r.parent === queueId && plain(r.text).startsWith('AGENTJOB')) schedule(plugin, 'global');
  });
  if (queue) schedule(plugin, 'startup'); // jobs written while RemNote was closed
}

async function onDeactivate(_: ReactRNPlugin) {
  if (debounce) clearTimeout(debounce);
}

declareIndexPlugin(onActivate, onDeactivate);
