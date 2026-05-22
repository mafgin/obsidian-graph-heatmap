# Graph Heatmap

An Obsidian plugin that colors graph view nodes by a metric you choose — recency, connectedness, word count, file size — and lets you focus on subsets of the vault (orphans, hubs, stale notes, stubs). All controls live in a floating panel inside the graph view, so you can switch metric, palette, scale, and filter without leaving the graph.

## Features

### Metrics

Color nodes by any of:

- **Last modified** (mtime) — newest hottest
- **Created** (ctime) — newest hottest
- **Total connections** (backlinks + outgoing) — most connected hottest
- **Backlinks** — most-referenced hottest
- **Outgoing links** — most-linking hottest
- **Word count** — longest hottest (lazy-loaded, cached per file)
- **File size** — largest hottest

### Focus Mode

Hide or dim parts of the graph to isolate what matters:

- Top 10% / 25% by current metric — your hubs / hot notes
- Bottom 10% / 25% by current metric — the cold tail
- Only orphans (0 links) — unlinked notes
- Only stale (oldest 10%) — dust collectors
- Only stubs (shortest 10%) — incomplete drafts
- Hide orphans — clean the graph of noise

Hidden nodes fade to 12% opacity by default; turn on *Hide completely* in settings for fully invisible nodes and edges.

### Recent-edit halo

Notes modified within the last 24 hours (configurable) get their color blended toward a halo color (default cyan). Always on, regardless of which metric you're coloring by — so you can always see what you just touched.

### 12 built-in color palettes

Heat, Inferno, Viridis, Plasma, Magma, Sunset, Forest, Ocean, Grayscale, GitHub, Cool fire, Cyber — plus a Custom mode with three color pickers.

### Scale modes

- **Relative** (default) — rank nodes by value across the whole vault. Every color is always used regardless of how active your vault is.
- **Absolute** (time metrics only) — map age to days directly, with a configurable span.

### Hover tooltip

Hover any node to see its path, the current metric's raw value, when it was last modified, how many connections it has, and its rank in the vault.

### Floating control panel

Bottom-left of the graph view, collapsible. Switch metric / scale / palette / Focus Mode without opening Settings. Shows a live gradient swatch with metric-aware labels ("newest ←→ oldest", "most ←→ least").

## Installation

### Via BRAT (recommended until this plugin is in the official community list)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat).
2. In BRAT: *Add Beta plugin* → paste `mafgin/obsidian-graph-heatmap` → Add.
3. Enable **Graph Heatmap** in *Settings → Community plugins*.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/mafgin/obsidian-graph-heatmap/releases).
2. Drop them into `<your-vault>/.obsidian/plugins/graph-heatmap/`.
3. Enable in *Settings → Community plugins*.

## Usage

Open the graph view. The control panel appears in the bottom-left:

- **On** — toggle the heatmap.
- **Metric** — what drives the color.
- **Scale** — relative (rank) or absolute (days; time metrics only).
- **Colors** — pick a palette or `Custom`.
- **Focus** — show only a subset (orphans, hubs, stale, etc.).

Advanced options live in *Settings → Graph Heatmap*: custom color pickers, span (days), log scale, halo color / window, dim vs hide for Focus Mode, and tooltip toggle.

### Recommended combos

- **`Metric: Last modified` + `Focus: Only orphans` + `Colors: Inferno`** — your unlinked notes, colored by how stale they are. Cleanup list.
- **`Metric: Total connections` + `Colors: Viridis`** — hub map. Pure structural view.
- **`Metric: Word count` + `Focus: Only stubs` + `Colors: GitHub`** — your shortest notes, easy to spot for expansion or deletion.
- **`Metric: Last modified` + halo on** — see this week's activity at a glance.

## How it works

The plugin hooks Obsidian's `layout-change`, `active-leaf-change`, and `vault.modify` events, plus a 2-second tick, and writes per-node colors via `renderer.nodes[].color`. For each open graph view it:

1. Computes a "value" per node for the chosen metric (higher = hotter for everything: newer time, more links, more words, more bytes).
2. Either ranks values (relative) or maps time delta to 0–1 (absolute).
3. Interpolates the active 3-stop gradient at that fraction.
4. Blends toward the halo color if mtime is within the halo window.
5. Applies the Focus Mode filter — sets alpha=0 (or 0.12) on nodes and edges that don't match.
6. Writes the result into the PIXI renderer.

The plugin uses undocumented Obsidian internals for per-node color (the same pattern as other graph plugins like Extended Graph). If the renderer's shape changes in a future Obsidian release, the plugin degrades silently — colors stop updating until the patch is adjusted, but nothing breaks.

## Building

```bash
npm install
npm run build       # production bundle to main.js
npm run dev         # esbuild watch mode
```

## License

MIT — see [LICENSE](LICENSE).
