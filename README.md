# Agent Bridge for RemNote

A small RemNote plugin that lets AI agents (Claude Code, Codex, or anything else that talks to RemNote through the **RemNote MCP server**) make the edits the MCP can't make on its own:

- multi-line rems with full formatting: bold, italic, underline, text colour, highlight, superscript/subscript
- image display size
- heading size (H1/H2/H3)
- moving rems, turning a rem into a document
- adding a source (e.g. a PDF) to a rem
- tagging rems (e.g. *Extra Card Detail*)

It's built for one person's study workflow and works as-is. It has no UI. It's event-driven: nothing runs until an agent queues work.

## How it works

1. On startup the plugin makes sure a top-level document named **`Agent Bridge Queue`** exists.
2. An agent writes a job into that document with ordinary MCP calls (`append_doc`). Each job is one or more plain rems:

   ```
   AGENTJOB <jobId> <part>/<total> <hex of UTF-8 JSON>
   ```

   The payload is hex so the MCP's markdown parser can't turn characters like `==` or `::` into flashcards. Keep each rem under about 2500 characters, because the MCP splits longer text into a second rem.

3. The plugin notices the change, applies the job, deletes the job rems and appends a result line the agent can read back:

   ```
   AGENTRESULT <jobId> ok=<n> failed=<m> via=<trigger> <first errors>
   ```

   Only the last 20 results are kept.

### Job JSON

```json
{ "v": 1, "job": "20261107T124405", "ops": [ { "op": "setText", "rem": "<remId>", "text": [ "plain ", { "i": "m", "text": "bold red", "b": true, "tc": 1 } ] } ] }
```

| op | fields | effect |
|---|---|---|
| `setText` | `rem`, `text` (RemNote RichText) | replace the rem's text; `\n` inside a string makes a multi-line rem |
| `imageSize` | `rem`, `width`, `height?` | set the display size of the image(s) in a rem |
| `imagesUnder` | `rem`, `widths: number[]` | size images under a rem in document order, skipping any that already have a width |
| `setFontSize` | `rem`, `size`: `"H1"` / `"H2"` / `"H3"` / `null` | heading size |
| `setParent` | `rem`, `parent`, `position?` | move a rem |
| `setIsDocument` | `rem`, `value` | make or unmake a document |
| `addSource` | `rem`, `source` | add a source rem (e.g. a PDF) |
| `setHighlightColor` | `rem`, `color` | whole-rem highlight |
| `addTag` | `rem`, `tag` (rem id) | tag a rem, e.g. with *Extra Card Detail* (the MCP's own tag tool doesn't persist the tag) |

RichText formatting keys: `b` bold, `l` italic, `u` underline, `sup`/`sub`, `tc` text colour, `h` highlight. Colour numbers: 1 red, 2 orange, 3 yellow, 4 green, 5 purple, 6 blue, 7 gray, 8 brown, 9 pink.

## Controls

- **Agent Bridge: pause / resume** (command palette): stops or restarts automatic applying. While paused, jobs wait in the queue.
- **Agent Bridge: apply queued edits now**: applies whatever is waiting.
- Setting: **Show a small notice when edits are applied** (off by default).

## Safety

- Only rems inside the `Agent Bridge Queue` document are read as instructions.
- `setText`, `imageSize` and `imagesUnder` refuse any rem that holds flashcard data (cloze, back text, image occlusion), so existing cards are never rewritten.
- The plugin sends no data anywhere: no network requests, no third parties. Everything stays inside RemNote.
- It needs the `All / ReadCreateModifyDelete` scope because it edits rems anywhere the agent points it.

## Develop

```bash
npm install
npm run dev     # serves http://localhost:8080 → RemNote → Settings → Plugins → Build → Develop from localhost
npm run build   # PluginZip.zip for upload
```

Built from the official RemNote plugin template (`@remnote/plugin-sdk` 0.0.46, MIT).
