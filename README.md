# Graph Heatmap

An Obsidian plugin that colors graph view nodes by a metric you choose — recency, creation time, or how connected a note is — using a gradient from "hot" to "cold". A floating control panel lives inside the graph view so you can switch metric, palette, and scale without opening Settings.

## Features

- **Five metrics** to color by:
  - Last modified (`mtime`) — newest hottest
  - Created (`ctime`) — newest hottest
  - Total connections (backlinks + outgoing) — most connected hottest
  - Backlinks only — most-referenced hottest
  - Outgoing links only — most-linking hottest
- **Two scale modes**:
  - *Relative* (default) — rank nodes by value across the whole vault. Every color is always used regardless of how active your vault is, so you always get information density.
  - *Absolute* (time metrics only) — map age to days directly, with a configurable span.
- **12 built-in color palettes**: Heat, Inferno, Viridis, Plasma, Magma, Sunset, Forest, Ocean, Grayscale, GitHub, Cool fire, Cyber — plus a Custom mode with three color pickers.
- **Floating control panel** inside the graph view (bottom-left, collapsible). Switch metric, scale, or palette without leaving the graph.
- **Gradient swatch + labels** showing what hot and cold mean for the current metric (`newest / oldest`, or `most / least`).
- **Log scale toggle** in settings — compresses the long tail so recent activity stands out more.
- Restores default node colors cleanly when disabled or unloaded.

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

Open the graph view. The control panel appears in the bottom-left. From there:

- **On** — toggle the heatmap.
- **Metric** — what drives the color.
- **Scale** — relative (rank) or absolute (days; time metrics only).
- **Colors** — pick a palette or `Custom`.

The gradient swatch at the bottom shows the active palette, with labels indicating the meaning of the two ends.

Advanced options live in *Settings → Graph Heatmap*: custom color pickers, span (days) for absolute mode, log scale, and panel/label visibility.

## How it works

The plugin hooks Obsidian's `layout-change`, `active-leaf-change`, and `vault.modify` events, plus a 2-second tick, and writes per-node colors via `renderer.nodes[].color`. For each open graph view it:

1. Picks a numeric "value" per node based on the chosen metric.
2. Either ranks all values (relative mode) or maps the time delta to a 0–1 fraction (absolute mode).
3. Interpolates the active 3-stop gradient at that fraction.
4. Writes the result into the PIXI renderer's per-node color.

This uses undocumented Obsidian internals (the same pattern as several other graph plugins). If the renderer's shape changes in a future Obsidian release, the plugin degrades silently — colors stop updating until the patch is adjusted, but nothing breaks.

## Building

```bash
npm install
npm run build       # production bundle to main.js
npm run dev         # esbuild watch mode
```

## License

MIT — see [LICENSE](LICENSE).
