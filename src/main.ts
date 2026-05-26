import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  debounce,
} from "obsidian";

type ScaleMode = "relative" | "absolute";

// How the range filter treats out-of-window nodes:
//   "dim"  — keep them in the graph (and the force simulation) but fade them.
//   "hide" — remove them from the force simulation entirely via setData, so the
//            remaining nodes reflow. Falls back to a visual hide if setData is
//            unavailable on the running Obsidian build.
type RangeMode = "dim" | "hide";

type Metric =
  | "mtime"          // last modified — newest hottest
  | "ctime"          // created — newest hottest
  | "totalLinks"     // backlinks + outgoing
  | "backlinks"      // incoming only
  | "outgoingLinks"  // outgoing only
  | "wordCount"      // longest hottest
  | "fileSize";      // largest hottest

type FocusMode =
  | "all"
  | "top10"
  | "top25"
  | "bottom10"
  | "bottom25"
  | "orphans"        // totalLinks == 0
  | "stale"          // bottom 10% by mtime
  | "stubs"          // bottom 10% by wordCount
  | "hideOrphans";   // hide totalLinks == 0

interface HeatmapSettings {
  enabled: boolean;
  metric: Metric;
  scaleMode: ScaleMode;
  preset: string;
  hotColor: string;
  midColor: string;
  coldColor: string;
  spanDays: number;
  logScale: boolean;
  showLegend: boolean;
  showControls: boolean;
  controlsCollapsed: boolean;
  // Focus Mode
  focusMode: FocusMode;
  filterHideCompletely: boolean;  // true = alpha 0; false = dim to 0.12
  // Range filter — keep only nodes whose current-metric value falls in a window.
  // Stored as normalized [0,1] handle positions; mapped to real units at paint
  // time against the live data extent (log for time metrics, linear otherwise).
  rangeMin: number;  // lower handle, 0 = no lower bound
  rangeMax: number;  // upper handle, 1 = no upper bound
  rangeMode: RangeMode;  // dim out-of-window nodes, or remove them from physics
  // Recent-edit halo
  haloEnabled: boolean;
  haloHours: number;              // window for "recent"
  haloColor: string;              // CSS hex; bright by default
  haloScale: number;              // multiplier on node size for halo (1.0..2.0)
  // Hover tooltip
  showTooltip: boolean;
}

const DEFAULTS: HeatmapSettings = {
  enabled: true,
  metric: "mtime",
  scaleMode: "relative",
  preset: "Heat",
  hotColor: "#ff2a2a",
  midColor: "#ffd000",
  coldColor: "#2a78ff",
  spanDays: 180,
  logScale: false,
  showLegend: true,
  showControls: true,
  controlsCollapsed: false,
  focusMode: "all",
  filterHideCompletely: false,
  rangeMin: 0,
  rangeMax: 1,
  rangeMode: "hide",
  haloEnabled: true,
  haloHours: 24,
  haloColor: "#00ffff",
  haloScale: 1.6,
  showTooltip: true,
};

const METRIC_LABELS: Record<Metric, string> = {
  mtime: "Last modified",
  ctime: "Created",
  totalLinks: "Total connections (back + out)",
  backlinks: "Backlinks (incoming)",
  outgoingLinks: "Outgoing links",
  wordCount: "Word count",
  fileSize: "File size",
};

const FOCUS_LABELS: Record<FocusMode, string> = {
  all: "All notes",
  top10: "Top 10% (by current metric)",
  top25: "Top 25% (by current metric)",
  bottom10: "Bottom 10% (by current metric)",
  bottom25: "Bottom 25% (by current metric)",
  orphans: "Only orphans (0 links)",
  stale: "Only stale (oldest 10%)",
  stubs: "Only stubs (shortest 10%)",
  hideOrphans: "Hide orphans",
};

// 3-stop palettes [hot, mid, cold]. Hot = highest value (most recent / most connected).
const COLOR_PRESETS: Record<string, [string, string, string]> = {
  Heat:        ["#ff2a2a", "#ffd000", "#2a78ff"], // red → yellow → blue (default)
  Inferno:     ["#fcffa4", "#dd513a", "#000004"], // matplotlib inferno (hot bright → dark)
  Viridis:     ["#fde725", "#21918c", "#440154"], // matplotlib viridis
  Plasma:      ["#f0f921", "#cc4778", "#0d0887"], // matplotlib plasma
  Magma:       ["#fcfdbf", "#b73779", "#000004"], // matplotlib magma
  Sunset:      ["#ffd166", "#ef476f", "#073b4c"], // warm sunset
  Forest:      ["#d4e09b", "#5a8f29", "#1b3a1b"], // moss / canopy
  Ocean:       ["#caf0f8", "#0077b6", "#03045e"], // bright cyan → deep blue
  Grayscale:   ["#f8f9fa", "#6c757d", "#212529"], // light → dark
  GitHub:      ["#39d353", "#26a641", "#0d4429"], // contribution-graph green ramp
  "Cool fire": ["#ffffff", "#ff5e62", "#1e0b3c"], // white-hot → deep purple
  "Cyber":     ["#ff00ff", "#00ffff", "#0a0a23"], // magenta → cyan → near-black
};

function isTimeMetric(m: Metric): boolean {
  return m === "mtime" || m === "ctime";
}

const RANGE_MIN_AGE_MS = 60_000; // 1 minute — finest grain at the recent end

// Map a normalized handle position [0,1] to an AGE in ms, log-scaled between
// 1 minute and the vault's oldest node. Extremes mean "no bound": 0 → 0 (include
// brand-new), 1 → Infinity (include oldest).
function ageAtPosition(p: number, maxAge: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  const max = Math.max(maxAge, RANGE_MIN_AGE_MS * 2);
  return RANGE_MIN_AGE_MS * Math.pow(max / RANGE_MIN_AGE_MS, p);
}

// Map a normalized handle position [0,1] to a raw value, linearly between the
// observed min and max. Extremes mean "no bound".
function valueAtPosition(p: number, lo: number, hi: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  return lo + (hi - lo) * p;
}

function formatAgeShort(ms: number): string {
  if (!Number.isFinite(ms)) return "oldest";
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${(d / 365).toFixed(d < 730 ? 1 : 0)}y`;
}

function formatCountShort(n: number, metric: Metric): string {
  if (!Number.isFinite(n)) return n < 0 ? "min" : "max";
  if (metric === "fileSize") return formatBytes(Math.round(n));
  return Math.round(n).toLocaleString();
}

function activeColors(s: HeatmapSettings): [string, string, string] {
  if (s.preset !== "custom" && COLOR_PRESETS[s.preset]) {
    return COLOR_PRESETS[s.preset];
  }
  return [s.hotColor, s.midColor, s.coldColor];
}

interface GraphNode {
  id: string;
  x?: number;
  y?: number;
  color?: { a: number; rgb: number };
  weight?: number;
  type?: string;
}

interface GraphLink {
  source: GraphNode;
  target: GraphNode;
  // `line` is the PIXI graphics for the edge. `alpha` controls fade (used for
  // Focus dimming); `visible`/`renderable` remove it from the draw loop entirely
  // so the renderer's per-frame alpha recompute can't make it flicker back.
  line?: { tint?: number; alpha?: number; visible?: boolean; renderable?: boolean };
}

// Obsidian's setData input: a node map keyed by id; each node lists its type and
// an outgoing-link adjacency set. Feeding a subset of this re-seeds the force
// worker so removed nodes truly leave the simulation.
interface GraphData {
  nodes: Record<string, { type: string; links: Record<string, boolean> }>;
}

// Per-node values for the active metric + Focus Mode recipes. Built once per
// paint (and reused by the physics filter) from the live renderer node set.
interface Entry {
  node: GraphNode;
  value: number;       // color metric value (higher = hotter)
  mtime: number;       // for halo + stale filter
  totalLinks: number;  // for orphans/hideOrphans filter
  wordCount: number;   // for stubs filter
  isReal: boolean;     // true if the node resolves to a TFile or unresolved-but-with-links
}

interface GraphRenderer {
  nodes: GraphNode[];
  links?: GraphLink[];
  colors: { fill: { a: number; rgb: number }; line?: { a: number; rgb: number } };
  changed?: () => void;
  setData?: (data: GraphData) => void;
  px?: {
    ticker?: { add?: (fn: () => void) => void; remove?: (fn: () => void) => void; _emitter?: unknown };
    view?: HTMLCanvasElement;
  };
  panX?: number;
  panY?: number;
  scale?: number;
  targetScale?: number;
}

interface GraphView {
  renderer: GraphRenderer;
  getViewType(): string;
}

export default class GraphHeatmapPlugin extends Plugin {
  settings: HeatmapSettings = DEFAULTS;
  private repaintScheduled = false;
  // Most recent data extent for the active metric, used to render range-filter
  // labels and map handle positions to real units. Refreshed every paint.
  private lastRangeExtent: { isTime: boolean; maxAge: number; valMin: number; valMax: number } =
    { isTime: true, maxAge: 86_400_000, valMin: 0, valMax: 1 };
  // Word count cache keyed by path; invalidated when file mtime advances.
  private wordCountCache: Map<string, { mtime: number; count: number }> = new Map();
  private wordCountPending: Set<string> = new Set();
  // Hover tooltip plumbing
  private tooltipEls: WeakMap<WorkspaceLeaf, HTMLElement> = new WeakMap();
  private hoverAttached: WeakSet<WorkspaceLeaf> = new WeakSet();
  // Per-leaf physics-filter state (range mode = "hide"). `snapshot` is the full
  // graph captured while unfiltered, so we can rebuild the complete set when the
  // filter clears. `subsetCount`/`appliedMin`/`appliedMax`/`appliedMetric` record
  // exactly what we last fed the worker, so we can (a) no-op when nothing changed
  // and (b) detect an external rebuild (returning to the graph re-creates the
  // full node set, so the live count no longer matches our subset).
  private physState: WeakMap<
    WorkspaceLeaf,
    {
      snapshot: GraphData | null;
      applied: boolean;
      subsetCount: number;
      appliedMin: number;
      appliedMax: number;
      appliedMetric: Metric;
    }
  > = new WeakMap();
  // Per-frame recolor. Obsidian rebuilds the node set with default (gray) colors
  // on setData and during its timeline animation; our debounced repaint lags, so
  // the graph flashes / stays gray. A requestAnimationFrame loop re-asserts our
  // cached hue on every node each frame (cheap: only allocates when the renderer
  // actually reset a node), independent of any Obsidian internal.
  private rafId: number | null = null;
  private colorCache: WeakMap<WorkspaceLeaf, Map<string, number>> = new WeakMap();
  private lastNodeCount: WeakMap<WorkspaceLeaf, number> = new WeakMap();
  // Throttle for live (during-drag) physics application.
  private lastLivePhysicsTs = 0;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new HeatmapSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.scheduleRepaint();
        this.schedulePhysics();
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.scheduleRepaint();
        this.schedulePhysics();
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", () => this.scheduleRepaint())
    );

    this.registerInterval(
      window.setInterval(() => this.scheduleRepaint(), 2000)
    );

    this.app.workspace.onLayoutReady(() => {
      this.scheduleRepaint();
      this.schedulePhysics();
      this.startColorLoop();
    });

    this.addCommand({
      id: "graph-heatmap-toggle",
      name: "Toggle graph heatmap",
      callback: async () => {
        this.settings.enabled = !this.settings.enabled;
        await this.saveSettings();
        this.scheduleRepaint();
      },
    });

    this.addCommand({
      id: "graph-heatmap-refresh",
      name: "Refresh graph heatmap now",
      callback: () => this.repaintAll(),
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.scheduleRepaint();
  }

  private scheduleRepaint = debounce(
    () => this.repaintAll(),
    120,
    true
  );

  // Re-apply the physics filter shortly after the workspace settles (returning
  // to the graph re-creates the full node set, dropping our filter). Debounced
  // so a burst of layout events collapses to one rebuild, and delayed enough for
  // the renderer to finish rebuilding before we filter it.
  private schedulePhysics = debounce(
    () => this.refreshPhysics(),
    200,
    true
  );

  private repaintAll() {
    const leaves = [
      ...this.app.workspace.getLeavesOfType("graph"),
      ...this.app.workspace.getLeavesOfType("localgraph"),
    ];
    for (const leaf of leaves) this.paintLeaf(leaf);
  }

  private paintLeaf(leaf: WorkspaceLeaf) {
    const view = leaf.view as unknown as GraphView;
    if (!view || typeof view.getViewType !== "function") return;
    const t = view.getViewType();
    if (t !== "graph" && t !== "localgraph") return;
    const renderer = view.renderer;
    if (!renderer || !Array.isArray(renderer.nodes)) return;

    // Track the node count so the rAF loop can detect rebuilds / animation.
    this.lastNodeCount.set(leaf, renderer.nodes.length);

    if (!this.settings.enabled) {
      // restore: revert color to renderer.colors.fill + un-hide any edges we dropped
      const fill = renderer.colors?.fill ?? { a: 1, rgb: 0x999999 };
      for (const node of renderer.nodes) {
        node.color = { a: fill.a, rgb: fill.rgb };
      }
      if (Array.isArray(renderer.links)) {
        for (const link of renderer.links) {
          if (!link.line) continue;
          link.line.visible = true;
          link.line.renderable = true;
          link.line.alpha = 1;
        }
      }
      renderer.changed?.();
      // Keep controls panel visible so user can re-enable from the graph view
      if (this.settings.showControls) this.ensureControls(leaf);
      else this.removeControls(leaf);
      return;
    }

    const now = Date.now();
    const spanMs = Math.max(1, this.settings.spanDays) * 86_400_000;
    const metric = this.settings.metric;

    // Per-node metric + auxiliary values (shared with the physics filter).
    const entries = this.buildEntries(renderer, metric);

    // Focus Mode: decide which nodes are softly "dimmed" for context.
    const dimmed = this.applyFocusMode(entries);

    // Range filter: refresh the data extent, then collect out-of-window nodes.
    // In "hide" mode the physics filter may already have removed them from the
    // node set (so this finds nothing); otherwise this is the visual path —
    // a live drag preview and the fallback when setData isn't available.
    // While physics-filtered the renderer holds only survivors, so we keep the
    // extent computed over the full set (set by applyPhysicsFilter) — otherwise
    // the slider's window meaning would shift as nodes drop out.
    const physApplied = this.physState.get(leaf)?.applied ?? false;
    if (!physApplied) this.refreshRangeExtent(entries, metric, now);
    const removed = this.applyRangeFilter(entries, metric, now);
    const rangeHide = this.settings.rangeMode === "hide";

    // Use relative mode for any non-time metric. Honour the user choice only for time metrics.
    const useRelative =
      this.settings.scaleMode === "relative" || !isTimeMetric(metric);

    let fracOf: (e: Entry) => number;
    if (useRelative) {
      const real = entries.filter((e) => e.isReal).slice().sort((a, b) => b.value - a.value);
      const ranks = new Map<GraphNode, number>();
      const denom = Math.max(1, real.length - 1);
      real.forEach((e, i) => ranks.set(e.node, i / denom));
      fracOf = (e) => (e.isReal ? ranks.get(e.node) ?? 1 : 1);
    } else {
      fracOf = (e) => {
        if (!e.isReal) return 1;
        let f = (now - e.value) / spanMs;
        if (f > 1) f = 1;
        if (f < 0) f = 0;
        return f;
      };
    }

    // Stash entries for the hover tooltip's hit-tester.
    this.lastEntries.set(leaf, entries);

    const [hot, mid, cold] = activeColors(this.settings);
    const haloMs = this.settings.haloHours * 3_600_000;
    const haloEnabled = this.settings.haloEnabled;
    const dimAlpha = this.settings.filterHideCompletely ? 0 : 0.12;

    // Cache id→hue so the rAF loop can cheaply re-assert colors every frame
    // (e.g. during Obsidian's timeline animation, which resets nodes to gray).
    const cache = new Map<string, number>();

    for (const e of entries) {
      let frac = fracOf(e);
      if (this.settings.logScale) {
        frac = Math.log1p(frac * 9) / Math.log(10);
      }
      let rgb = interpolateThree(hot, mid, cold, frac);

      // Halo: brighten color toward halo color for recently edited files.
      if (haloEnabled && e.mtime && now - e.mtime <= haloMs) {
        const haloRgb = hexToRgbInt(this.settings.haloColor);
        rgb = lerpRgb(rgb, haloRgb, 0.55);
      }

      // Range-removed nodes: vanish (alpha 0) in hide mode, fade in dim mode.
      let alpha = 1;
      if (removed.has(e.node)) alpha = rangeHide ? 0 : 0.12;
      else if (dimmed.has(e.node)) alpha = dimAlpha;
      e.node.color = { a: alpha, rgb };
      cache.set(e.node.id, rgb);
    }
    this.colorCache.set(leaf, cache);

    // Edges follow their endpoints:
    //   • either end range-removed, hide mode → drop from the draw loop entirely
    //     (visible/renderable=false), not just alpha — otherwise the renderer's
    //     per-frame line pass keeps repainting it and it flickers.
    //   • either end range-removed, dim mode → fade to 0.12 but keep drawn.
    //   • either end focus-dimmed → fade via alpha.
    //   • otherwise → full strength, and make sure it's drawable again.
    if (Array.isArray(renderer.links)) {
      for (const link of renderer.links) {
        if (!link.source || !link.target || !link.line) continue;
        if (removed.has(link.source) || removed.has(link.target)) {
          if (rangeHide) {
            link.line.visible = false;
            link.line.renderable = false;
            link.line.alpha = 0;
          } else {
            link.line.visible = true;
            link.line.renderable = true;
            link.line.alpha = 0.12;
          }
        } else if (dimmed.has(link.source) || dimmed.has(link.target)) {
          link.line.visible = true;
          link.line.renderable = true;
          link.line.alpha = dimAlpha;
        } else {
          link.line.visible = true;
          link.line.renderable = true;
          link.line.alpha = 1;
        }
      }
    }

    renderer.changed?.();

    if (this.settings.showTooltip) {
      this.attachHoverListener(leaf, renderer);
    } else {
      this.removeTooltip(leaf);
    }

    if (this.settings.showControls) {
      this.ensureControls(leaf);
    } else {
      this.removeControls(leaf);
    }
  }

  private controlsEls: WeakMap<WorkspaceLeaf, HTMLElement> = new WeakMap();

  private legendLabels(): { hot: string; cold: string } {
    const metric = this.settings.metric;
    if (isTimeMetric(metric)) {
      const isAbs = this.settings.scaleMode === "absolute";
      return {
        hot: isAbs ? "today" : "newest",
        cold: isAbs ? `${this.settings.spanDays}d+` : "oldest",
      };
    }
    return { hot: "most", cold: "least" };
  }

  // ── Metric / Focus Mode helpers ──

  private lastEntries: WeakMap<WorkspaceLeaf, Array<{
    node: GraphNode;
    value: number;
    mtime: number;
    totalLinks: number;
    wordCount: number;
    isReal: boolean;
  }>> = new WeakMap();

  private computeAuxStats(_renderer: GraphRenderer): {
    incoming: Map<string, number>;
    outgoing: Map<string, number>;
  } {
    const resolvedLinks = (this.app.metadataCache as unknown as {
      resolvedLinks: Record<string, Record<string, number>>;
    }).resolvedLinks;
    const incoming = new Map<string, number>();
    const outgoing = new Map<string, number>();
    for (const src in resolvedLinks) {
      let outSum = 0;
      const targets = resolvedLinks[src];
      for (const tgt in targets) {
        const n = targets[tgt];
        outSum += n;
        incoming.set(tgt, (incoming.get(tgt) ?? 0) + n);
      }
      outgoing.set(src, outSum);
    }
    return { incoming, outgoing };
  }

  private metricValue(
    file: TFile | null,
    metric: Metric,
    aux: { incoming: Map<string, number>; outgoing: Map<string, number> },
    fallbackId?: string
  ): number {
    const id = file?.path ?? fallbackId ?? "";
    switch (metric) {
      case "mtime":
        return file ? file.stat.mtime : 0;
      case "ctime":
        return file ? file.stat.ctime : 0;
      case "fileSize":
        return file ? file.stat.size : 0;
      case "wordCount":
        return file ? this.getWordCount(file) : 0;
      case "backlinks":
        return aux.incoming.get(id) ?? 0;
      case "outgoingLinks":
        return aux.outgoing.get(id) ?? 0;
      case "totalLinks":
      default:
        return (aux.incoming.get(id) ?? 0) + (aux.outgoing.get(id) ?? 0);
    }
  }

  private getWordCount(file: TFile): number {
    if (file.extension !== "md") return 0;
    const cached = this.wordCountCache.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) return cached.count;
    if (this.wordCountPending.has(file.path)) return cached?.count ?? 0;
    this.wordCountPending.add(file.path);
    this.app.vault
      .cachedRead(file)
      .then((content) => {
        const count = content.trim().split(/\s+/).filter(Boolean).length;
        this.wordCountCache.set(file.path, { mtime: file.stat.mtime, count });
        this.wordCountPending.delete(file.path);
        this.scheduleRepaint();
      })
      .catch(() => this.wordCountPending.delete(file.path));
    return cached?.count ?? 0;
  }

  // Compute per-node metric + Focus values from the live renderer node set.
  // Shared by paintLeaf (coloring) and the physics filter (subset selection).
  private buildEntries(renderer: GraphRenderer, metric: Metric): Entry[] {
    const auxStats = this.computeAuxStats(renderer);
    const entries: Entry[] = [];
    for (const node of renderer.nodes) {
      const file = this.app.vault.getAbstractFileByPath(node.id);
      const totalLinks =
        (auxStats.incoming.get(node.id) ?? 0) +
        (auxStats.outgoing.get(node.id) ?? 0);

      if (file instanceof TFile) {
        entries.push({
          node,
          value: this.metricValue(file, metric, auxStats),
          mtime: file.stat.mtime,
          totalLinks,
          wordCount: this.getWordCount(file),
          isReal: true,
        });
      } else if (!isTimeMetric(metric) && metric !== "wordCount" && metric !== "fileSize") {
        // Unresolved/folder nodes can still have a link value
        entries.push({
          node,
          value: this.metricValue(null, metric, auxStats, node.id),
          mtime: 0,
          totalLinks,
          wordCount: 0,
          isReal: true,
        });
      } else {
        entries.push({
          node,
          value: Number.NEGATIVE_INFINITY,
          mtime: 0,
          totalLinks,
          wordCount: 0,
          isReal: false,
        });
      }
    }
    return entries;
  }

  // Serialize the renderer's current (full) node + link set into setData's input
  // shape, so we can rebuild the complete graph after the filter clears.
  private serializeRenderer(renderer: GraphRenderer): GraphData {
    const data: GraphData = { nodes: {} };
    for (const node of renderer.nodes) {
      data.nodes[node.id] = { type: node.type ?? "", links: {} };
    }
    if (Array.isArray(renderer.links)) {
      for (const link of renderer.links) {
        const s = link.source?.id;
        const t = link.target?.id;
        if (s == null || t == null) continue;
        if (data.nodes[s]) data.nodes[s].links[t] = true;
      }
    }
    return data;
  }

  // Re-evaluate the physics ("hide") filter for every open graph leaf. Called on
  // discrete events (slider release, reset, metric/mode change) — NOT on the
  // periodic repaint, so we never re-heat the simulation while idle.
  private refreshPhysics(): void {
    const leaves = [
      ...this.app.workspace.getLeavesOfType("graph"),
      ...this.app.workspace.getLeavesOfType("localgraph"),
    ];
    for (const leaf of leaves) this.applyPhysicsFilter(leaf);
  }

  // Drive Obsidian's force worker with a filtered node set so out-of-window
  // nodes leave the simulation (in "hide" mode). Returns false if the running
  // build doesn't expose setData — paintLeaf's visual path is the fallback.
  private applyPhysicsFilter(leaf: WorkspaceLeaf): boolean {
    const view = leaf.view as unknown as GraphView;
    if (!view || typeof view.getViewType !== "function") return false;
    const t = view.getViewType();
    if (t !== "graph" && t !== "localgraph") return false;
    const renderer = view.renderer;
    if (!renderer || typeof renderer.setData !== "function" || !Array.isArray(renderer.nodes)) {
      return false;
    }
    // Don't filter a renderer that isn't built yet (e.g. mid view-rebuild).
    if (renderer.nodes.length === 0) return false;

    const st =
      this.physState.get(leaf) ??
      {
        snapshot: null,
        applied: false,
        subsetCount: -1,
        appliedMin: 0,
        appliedMax: 1,
        appliedMetric: this.settings.metric,
      };

    const rangeMin = this.settings.rangeMin;
    const rangeMax = this.settings.rangeMax;
    const metric = this.settings.metric;
    const want =
      this.settings.enabled &&
      this.settings.rangeMode === "hide" &&
      this.rangeFilterActive();

    // Already in the desired filtered state and the renderer still holds exactly
    // the subset we produced — nothing to do (avoids needless re-heating on every
    // pane switch / layout-change).
    if (
      want &&
      st.applied &&
      renderer.nodes.length === st.subsetCount &&
      st.appliedMin === rangeMin &&
      st.appliedMax === rangeMax &&
      st.appliedMetric === metric
    ) {
      return true;
    }

    // External rebuild: returning to the graph (or a vault change) re-creates the
    // full node set, so the live count no longer matches our subset. Our snapshot
    // and applied flag are stale — drop them and treat the renderer as the new
    // full graph.
    if (st.applied && renderer.nodes.length !== st.subsetCount) {
      st.applied = false;
      st.snapshot = null;
    }

    // Otherwise restore the complete graph first (setData rebuilds renderer.nodes
    // synchronously, preserving positions by id), so we evaluate against the full
    // set and never filter an already-filtered subset.
    let restored = false;
    if (st.applied && st.snapshot) {
      try { renderer.setData(st.snapshot); restored = true; } catch { /* fall through */ }
      st.applied = false;
    }

    if (!want) {
      st.snapshot = null; // re-capture fresh next time (picks up vault edits)
      st.subsetCount = -1;
      this.physState.set(leaf, st);
      if (restored) this.paintLeaf(leaf); // recolor the restored full set
      return true;
    }

    // Snapshot the now-full graph, compute which nodes fall outside the window,
    // then feed the worker only the survivors (+ links between survivors).
    const snapshot = this.serializeRenderer(renderer);
    const entries = this.buildEntries(renderer, metric);
    this.refreshRangeExtent(entries, metric, Date.now());
    const removedNodes = this.applyRangeFilter(entries, metric, Date.now());
    const removedIds = new Set<string>();
    for (const n of removedNodes) removedIds.add(n.id);

    const subset: GraphData = { nodes: {} };
    for (const id of Object.keys(snapshot.nodes)) {
      if (removedIds.has(id)) continue;
      const links: Record<string, boolean> = {};
      for (const target of Object.keys(snapshot.nodes[id].links)) {
        if (!removedIds.has(target)) links[target] = true;
      }
      subset.nodes[id] = { type: snapshot.nodes[id].type, links };
    }

    try {
      renderer.setData(subset);
      st.snapshot = snapshot;
      st.applied = true;
      st.subsetCount = Object.keys(subset.nodes).length;
      st.appliedMin = rangeMin;
      st.appliedMax = rangeMax;
      st.appliedMetric = metric;
    } catch {
      st.snapshot = null;
      st.applied = false;
      st.subsetCount = -1;
    }
    this.physState.set(leaf, st);
    // Recolor the survivors synchronously so the rebuilt node set never paints
    // as default gray between setData and the next debounced repaint.
    this.paintLeaf(leaf);
    return true;
  }

  // Apply the physics filter live while the user drags, throttled so we don't
  // re-seed the worker on every 1% slider tick.
  private liveFilterPhysics(): void {
    if (this.settings.rangeMode !== "hide") return;
    const now = Date.now();
    if (now - this.lastLivePhysicsTs < 90) return;
    this.lastLivePhysicsTs = now;
    this.refreshPhysics();
  }

  // Continuous rAF loop: re-assert our cached hue on every graph node each frame.
  // This wins against Obsidian's timeline animation (which rebuilds/recolors
  // nodes to default gray as it reveals them) without depending on any internal
  // render hook. It's cheap — a full repaint only when the node set changed; a
  // per-node hue re-assert otherwise, allocating only when a color was reset.
  private startColorLoop(): void {
    if (this.rafId !== null) return;
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      if (!this.settings.enabled) return;
      const leaves = [
        ...this.app.workspace.getLeavesOfType("graph"),
        ...this.app.workspace.getLeavesOfType("localgraph"),
      ];
      for (const leaf of leaves) this.reassertColors(leaf);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopColorLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private reassertColors(leaf: WorkspaceLeaf): void {
    const view = leaf.view as unknown as GraphView;
    if (!view || typeof view.getViewType !== "function") return;
    const t = view.getViewType();
    if (t !== "graph" && t !== "localgraph") return;
    const renderer = view.renderer;
    if (!renderer || !Array.isArray(renderer.nodes)) return;

    // Node set changed (setData / animation reveal): do a full repaint so colors,
    // edges, Focus, and the cache all rebuild against the new set.
    if (this.lastNodeCount.get(leaf) !== renderer.nodes.length) {
      this.paintLeaf(leaf);
      return;
    }

    // Otherwise just re-assert the cached hue (the animation can reset colors in
    // place even when the count is stable). Keep each node's current alpha so we
    // don't fight dim/hide or the animation's reveal fade.
    const cache = this.colorCache.get(leaf);
    if (!cache) return;
    let changed = false;
    for (const node of renderer.nodes) {
      const rgb = cache.get(node.id);
      if (rgb === undefined) continue;
      const cur = node.color;
      if (!cur) {
        node.color = { a: 1, rgb };
        changed = true;
      } else if (cur.rgb !== rgb) {
        node.color = { a: cur.a, rgb };
        changed = true;
      }
    }
    if (changed) renderer.changed?.();
  }

  private applyFocusMode(entries: Array<{
    node: GraphNode;
    value: number;
    mtime: number;
    totalLinks: number;
    wordCount: number;
    isReal: boolean;
  }>): Set<GraphNode> {
    const hidden = new Set<GraphNode>();
    const mode = this.settings.focusMode;
    if (mode === "all") return hidden;

    const real = entries.filter((e) => e.isReal);
    const sortedDesc = (key: (e: typeof real[number]) => number) =>
      real.slice().sort((a, b) => key(b) - key(a));

    const pctCutoff = (sorted: typeof real, frac: number) =>
      Math.max(1, Math.floor(sorted.length * frac));

    if (mode === "top10" || mode === "top25") {
      const sorted = sortedDesc((e) => e.value);
      const k = pctCutoff(sorted, mode === "top10" ? 0.1 : 0.25);
      const keep = new Set(sorted.slice(0, k).map((e) => e.node));
      for (const e of entries) if (!keep.has(e.node)) hidden.add(e.node);
    } else if (mode === "bottom10" || mode === "bottom25") {
      const sorted = sortedDesc((e) => e.value);
      const k = pctCutoff(sorted, mode === "bottom10" ? 0.1 : 0.25);
      const keep = new Set(sorted.slice(-k).map((e) => e.node));
      for (const e of entries) if (!keep.has(e.node)) hidden.add(e.node);
    } else if (mode === "orphans") {
      for (const e of entries) if (e.totalLinks > 0) hidden.add(e.node);
    } else if (mode === "hideOrphans") {
      for (const e of entries) if (e.totalLinks === 0) hidden.add(e.node);
    } else if (mode === "stale") {
      const sorted = sortedDesc((e) => -e.mtime); // oldest first
      const k = pctCutoff(sorted, 0.1);
      const keep = new Set(sorted.slice(0, k).map((e) => e.node));
      for (const e of entries) if (!keep.has(e.node)) hidden.add(e.node);
    } else if (mode === "stubs") {
      const sorted = sortedDesc((e) => -e.wordCount); // shortest first
      const k = pctCutoff(sorted, 0.1);
      const keep = new Set(sorted.slice(0, k).map((e) => e.node));
      for (const e of entries) if (!keep.has(e.node)) hidden.add(e.node);
    }
    return hidden;
  }

  private rangeFilterActive(): boolean {
    return this.settings.rangeMin > 0 || this.settings.rangeMax < 1;
  }

  // Compute the data extent for the active metric so the slider labels and the
  // position→value mapping reflect the current vault. For time metrics the
  // extent is the oldest node's age; otherwise the observed value min/max.
  private refreshRangeExtent(
    entries: Array<{ value: number; isReal: boolean }>,
    metric: Metric,
    now: number
  ): void {
    if (isTimeMetric(metric)) {
      let maxAge = 86_400_000; // floor: 1 day so the slider always has a span
      for (const e of entries) {
        if (e.isReal && e.value > 0) maxAge = Math.max(maxAge, now - e.value);
      }
      this.lastRangeExtent = { isTime: true, maxAge, valMin: 0, valMax: 1 };
    } else {
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (const e of entries) {
        if (!e.isReal) continue;
        if (e.value < lo) lo = e.value;
        if (e.value > hi) hi = e.value;
      }
      if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
      if (hi <= lo) hi = lo + 1;
      this.lastRangeExtent = { isTime: false, maxAge: 0, valMin: lo, valMax: hi };
    }
  }

  private applyRangeFilter(
    entries: Array<{ node: GraphNode; value: number; isReal: boolean }>,
    metric: Metric,
    now: number
  ): Set<GraphNode> {
    const removed = new Set<GraphNode>();
    if (!this.rangeFilterActive()) return removed;
    const ext = this.lastRangeExtent;
    if (isTimeMetric(metric)) {
      const ageFrom = ageAtPosition(this.settings.rangeMin, ext.maxAge);
      const ageTo = ageAtPosition(this.settings.rangeMax, ext.maxAge);
      for (const e of entries) {
        // Nodes without a real timestamp (folders, unresolved) can't fall in a
        // time window — remove them while a window is set.
        if (!e.isReal || e.value <= 0) { removed.add(e.node); continue; }
        const age = now - e.value;
        if (age < ageFrom || age > ageTo) removed.add(e.node);
      }
    } else {
      const lo = valueAtPosition(this.settings.rangeMin, ext.valMin, ext.valMax);
      const hi = valueAtPosition(this.settings.rangeMax, ext.valMin, ext.valMax);
      for (const e of entries) {
        if (!e.isReal) { removed.add(e.node); continue; }
        if (e.value < lo || e.value > hi) removed.add(e.node);
      }
    }
    return removed;
  }

  // Human-readable description of the current range window, e.g. "1m – 1mo" for
  // time metrics or "5 – 120" for counts. Used by the in-graph panel label.
  private rangeLabelText(): string {
    const ext = this.lastRangeExtent;
    const { rangeMin, rangeMax } = this.settings;
    if (!this.rangeFilterActive()) return "all notes";
    if (ext.isTime) {
      const from = rangeMin <= 0 ? "now" : formatAgeShort(ageAtPosition(rangeMin, ext.maxAge));
      const to = rangeMax >= 1 ? "oldest" : formatAgeShort(ageAtPosition(rangeMax, ext.maxAge));
      return `${from} – ${to} old`;
    }
    const lo = formatCountShort(valueAtPosition(rangeMin, ext.valMin, ext.valMax), this.settings.metric);
    const hi = formatCountShort(valueAtPosition(rangeMax, ext.valMin, ext.valMax), this.settings.metric);
    return `${lo} – ${hi}`;
  }

  // ── Hover tooltip ──

  private attachHoverListener(leaf: WorkspaceLeaf, renderer: GraphRenderer) {
    if (this.hoverAttached.has(leaf)) return;
    const canvas = renderer.px?.view;
    const container = (leaf.view as unknown as { contentEl?: HTMLElement }).contentEl;
    if (!canvas || !container) return;

    this.hoverAttached.add(leaf);

    const moveHandler = (ev: MouseEvent) => {
      if (!this.settings.showTooltip || !this.settings.enabled) {
        this.removeTooltip(leaf);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const cx = ev.clientX - rect.left;
      const cy = ev.clientY - rect.top;
      const node = this.hitTest(renderer, cx, cy, rect.width, rect.height);
      if (!node) {
        this.removeTooltip(leaf);
        return;
      }
      this.showTooltip(leaf, ev.clientX, ev.clientY, node);
    };
    const leaveHandler = () => this.removeTooltip(leaf);

    canvas.addEventListener("mousemove", moveHandler);
    canvas.addEventListener("mouseleave", leaveHandler);
    this.register(() => {
      canvas.removeEventListener("mousemove", moveHandler);
      canvas.removeEventListener("mouseleave", leaveHandler);
    });
  }

  private hitTest(
    renderer: GraphRenderer,
    canvasX: number,
    canvasY: number,
    canvasW: number,
    canvasH: number
  ): GraphNode | null {
    // Obsidian's graph renderer transforms graph coords to screen coords as:
    //   screen = panOffset + graph * scale + canvasCenter
    // panX/panY default to 0 when the user hasn't dragged; scale defaults to 1.
    const scale = renderer.targetScale ?? renderer.scale ?? 1;
    const panX = renderer.panX ?? 0;
    const panY = renderer.panY ?? 0;
    const cxOrigin = canvasW / 2;
    const cyOrigin = canvasH / 2;
    const r = Math.max(8, 12 / scale); // hit radius scales inversely with zoom
    let best: GraphNode | null = null;
    let bestD = r * r;
    for (const n of renderer.nodes) {
      if (n.x == null || n.y == null) continue;
      const sx = cxOrigin + (n.x + panX) * scale;
      const sy = cyOrigin + (n.y + panY) * scale;
      const dx = sx - canvasX;
      const dy = sy - canvasY;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD) {
        bestD = d2;
        best = n;
      }
    }
    return best;
  }

  private showTooltip(leaf: WorkspaceLeaf, screenX: number, screenY: number, node: GraphNode) {
    const container = (leaf.view as unknown as { contentEl?: HTMLElement }).contentEl;
    if (!container) return;
    let tip = this.tooltipEls.get(leaf);
    if (!tip || !container.contains(tip)) {
      tip = document.body.createDiv({ cls: "graph-heatmap-tooltip" });
      this.tooltipEls.set(leaf, tip);
    }
    tip.empty();
    tip.createDiv({ cls: "graph-heatmap-tooltip-path", text: node.id });

    // Look up entry data for this node
    const entries = this.lastEntries.get(leaf);
    const entry = entries?.find((e) => e.node === node);
    if (entry) {
      const m = this.settings.metric;
      let valueLine: string;
      if (m === "mtime" || m === "ctime") {
        valueLine = `${METRIC_LABELS[m]}: ${formatRelativeTime(entry.value)}`;
      } else if (m === "fileSize") {
        valueLine = `File size: ${formatBytes(entry.value)}`;
      } else if (m === "wordCount") {
        valueLine = `Word count: ${entry.value.toLocaleString()}`;
      } else {
        valueLine = `${METRIC_LABELS[m]}: ${entry.value}`;
      }
      tip.createDiv({ text: valueLine });

      // Auxiliary lines so the user understands the whole context
      if (m !== "mtime") tip.createDiv({ text: `Modified: ${formatRelativeTime(entry.mtime)}` });
      if (m !== "totalLinks" && m !== "backlinks" && m !== "outgoingLinks") {
        tip.createDiv({ text: `Connections: ${entry.totalLinks}` });
      }

      // Rank within real entries
      if (entries && entry.isReal) {
        const real = entries.filter((e) => e.isReal).sort((a, b) => b.value - a.value);
        const rank = real.findIndex((e) => e.node === node);
        if (rank >= 0) {
          tip.createDiv({ cls: "graph-heatmap-tooltip-rank", text: `Rank: ${rank + 1} of ${real.length}` });
        }
      }
    }

    // Position near cursor without going off-screen
    tip.style.left = `${screenX + 14}px`;
    tip.style.top = `${screenY + 14}px`;
  }

  private removeTooltip(leaf: WorkspaceLeaf) {
    const tip = this.tooltipEls.get(leaf);
    if (tip) {
      tip.detach();
      this.tooltipEls.delete(leaf);
    }
  }

  // Settings whose change requires a full DOM rebuild of the panel.
  private structuralSig(): string {
    return JSON.stringify({
      c: this.settings.controlsCollapsed,
      l: this.settings.showLegend,
      st: isTimeMetric(this.settings.metric),
    });
  }

  private ensureControls(leaf: WorkspaceLeaf) {
    const container = (leaf.view as unknown as { contentEl?: HTMLElement }).contentEl;
    if (!container) return;
    let panel = this.controlsEls.get(leaf);
    const sig = this.structuralSig();

    if (panel && container.contains(panel) && panel.dataset.heatmapSig === sig) {
      this.syncControlsValues(panel);
      return;
    }

    if (panel) panel.detach();
    panel = container.createDiv({ cls: "graph-heatmap-controls" });
    panel.dataset.heatmapSig = sig;
    this.controlsEls.set(leaf, panel);
    this.buildControlsDOM(panel);
  }

  private buildControlsDOM(panel: HTMLElement) {
    panel.toggleClass("is-collapsed", this.settings.controlsCollapsed);

    const header = panel.createDiv({ cls: "graph-heatmap-controls-header" });
    header.createSpan({ cls: "graph-heatmap-controls-title", text: "Heatmap" });
    const collapseBtn = header.createEl("button", {
      cls: "graph-heatmap-controls-collapse",
      text: this.settings.controlsCollapsed ? "▸" : "▾",
    });
    collapseBtn.addEventListener("click", async () => {
      this.settings.controlsCollapsed = !this.settings.controlsCollapsed;
      await this.saveSettings();
    });

    if (this.settings.controlsCollapsed) return;

    const body = panel.createDiv({ cls: "graph-heatmap-controls-body" });

    // Enabled toggle
    const enabledRow = body.createDiv({ cls: "graph-heatmap-controls-row" });
    enabledRow.createSpan({ text: "On" });
    const enabledToggle = enabledRow.createEl("input", {
      type: "checkbox",
      cls: "graph-heatmap-input-enabled",
    });
    enabledToggle.checked = this.settings.enabled;
    enabledToggle.addEventListener("change", async () => {
      this.settings.enabled = enabledToggle.checked;
      await this.saveSettings();
      this.refreshPhysics(); // restore full graph when turned off
    });

    // Metric
    const metricRow = body.createDiv({ cls: "graph-heatmap-controls-row" });
    metricRow.createSpan({ text: "Metric" });
    const metricSel = metricRow.createEl("select", { cls: "graph-heatmap-input-metric" });
    for (const m of Object.keys(METRIC_LABELS) as Metric[]) {
      metricSel.createEl("option", { value: m, text: METRIC_LABELS[m] });
    }
    metricSel.value = this.settings.metric;
    metricSel.addEventListener("change", async () => {
      this.settings.metric = metricSel.value as Metric;
      await this.saveSettings();
      this.refreshPhysics(); // window is metric-relative — re-evaluate removals
    });

    // Scale (disabled for link metrics — they force relative)
    const scaleRow = body.createDiv({ cls: "graph-heatmap-controls-row" });
    scaleRow.createSpan({ text: "Scale" });
    const scaleSel = scaleRow.createEl("select", { cls: "graph-heatmap-input-scale" });
    for (const [val, label] of [
      ["relative", "Relative"],
      ["absolute", "Absolute (days)"],
    ] as const) {
      scaleSel.createEl("option", { value: val, text: label });
    }
    scaleSel.value = this.settings.scaleMode;
    scaleSel.disabled = !isTimeMetric(this.settings.metric);
    scaleSel.addEventListener("change", async () => {
      this.settings.scaleMode = scaleSel.value as ScaleMode;
      await this.saveSettings();
    });

    // Color preset
    const presetRow = body.createDiv({ cls: "graph-heatmap-controls-row" });
    presetRow.createSpan({ text: "Colors" });
    const presetSel = presetRow.createEl("select", { cls: "graph-heatmap-input-preset" });
    for (const name of Object.keys(COLOR_PRESETS)) {
      presetSel.createEl("option", { value: name, text: name });
    }
    presetSel.createEl("option", { value: "custom", text: "Custom" });
    presetSel.value = this.settings.preset;
    presetSel.addEventListener("change", async () => {
      this.settings.preset = presetSel.value;
      await this.saveSettings();
    });

    // Focus Mode — show / hide nodes by recipe
    const focusRow = body.createDiv({ cls: "graph-heatmap-controls-row" });
    focusRow.createSpan({ text: "Focus" });
    const focusSel = focusRow.createEl("select", { cls: "graph-heatmap-input-focus" });
    for (const f of Object.keys(FOCUS_LABELS) as FocusMode[]) {
      focusSel.createEl("option", { value: f, text: FOCUS_LABELS[f] });
    }
    focusSel.value = this.settings.focusMode;
    focusSel.addEventListener("change", async () => {
      this.settings.focusMode = focusSel.value as FocusMode;
      await this.saveSettings();
    });

    // Range filter — dual slider over the active metric. Drag updates live;
    // release persists. Narrowing either handle activates the filter.
    const rangeRow = body.createDiv({ cls: "graph-heatmap-controls-row" });
    const rangeLabelCell = rangeRow.createSpan();
    const rangeLabelTop = rangeLabelCell.createDiv({ cls: "graph-heatmap-range-head" });
    rangeLabelTop.createSpan({ text: "Range" });
    const resetBtn = rangeLabelTop.createEl("button", {
      cls: "graph-heatmap-range-reset",
      text: "⟲",
      attr: { title: "Reset range" },
    });
    // dim / hide toggle — hide removes out-of-window nodes from the force
    // simulation (the layout reflows); dim just fades them in place.
    const modeBtn = rangeLabelCell.createEl("button", {
      cls: "graph-heatmap-range-mode",
      text: this.settings.rangeMode,
      attr: { title: "hide: drop filtered nodes from the layout · dim: just fade them" },
    });
    modeBtn.addEventListener("click", async () => {
      this.settings.rangeMode = this.settings.rangeMode === "hide" ? "dim" : "hide";
      modeBtn.setText(this.settings.rangeMode);
      await this.saveSettings();
      this.refreshPhysics();
    });
    const rangeWrap = rangeRow.createDiv({ cls: "graph-heatmap-range-wrap" });
    const minSlider = rangeWrap.createEl("input", {
      type: "range",
      cls: "graph-heatmap-input-rangemin",
    });
    const maxSlider = rangeWrap.createEl("input", {
      type: "range",
      cls: "graph-heatmap-input-rangemax",
    });
    for (const s of [minSlider, maxSlider]) {
      s.min = "0";
      s.max = "1";
      s.step = "0.01";
    }
    minSlider.value = String(this.settings.rangeMin);
    maxSlider.value = String(this.settings.rangeMax);

    const rangeValueLabel = body.createDiv({
      cls: "graph-heatmap-range-label",
      text: this.rangeLabelText(),
    });

    const onMinInput = () => {
      let v = parseFloat(minSlider.value);
      if (v > this.settings.rangeMax) {
        v = this.settings.rangeMax;
        minSlider.value = String(v);
      }
      this.settings.rangeMin = v;
      rangeValueLabel.setText(this.rangeLabelText());
      this.scheduleRepaint();
      this.liveFilterPhysics(); // reflow live during drag (throttled)
    };
    const onMaxInput = () => {
      let v = parseFloat(maxSlider.value);
      if (v < this.settings.rangeMin) {
        v = this.settings.rangeMin;
        maxSlider.value = String(v);
      }
      this.settings.rangeMax = v;
      rangeValueLabel.setText(this.rangeLabelText());
      this.scheduleRepaint();
      this.liveFilterPhysics(); // reflow live during drag (throttled)
    };
    minSlider.addEventListener("input", onMinInput);
    maxSlider.addEventListener("input", onMaxInput);
    // Persist + re-run the layout on release (input fires per-tick: dragging is a
    // smooth visual preview; release commits the physics filter in hide mode).
    const onRelease = async () => {
      await this.saveSettings();
      this.refreshPhysics();
    };
    minSlider.addEventListener("change", onRelease);
    maxSlider.addEventListener("change", onRelease);
    resetBtn.addEventListener("click", async () => {
      this.settings.rangeMin = 0;
      this.settings.rangeMax = 1;
      minSlider.value = "0";
      maxSlider.value = "1";
      rangeValueLabel.setText(this.rangeLabelText());
      await this.saveSettings();
      this.refreshPhysics(); // restore full graph
    });

    // Gradient preview swatch + metric-aware labels
    const preview = body.createDiv({ cls: "graph-heatmap-controls-preview" });
    const [hot, mid, cold] = activeColors(this.settings);
    preview.style.background = `linear-gradient(to right, ${hot}, ${mid}, ${cold})`;

    if (this.settings.showLegend) {
      const labels = body.createDiv({ cls: "graph-heatmap-controls-labels" });
      const { hot: hotL, cold: coldL } = this.legendLabels();
      labels.createSpan({ text: hotL });
      labels.createSpan({ text: coldL });
    }
  }

  // Non-destructive: updates values on existing DOM without rebuilding.
  // Skips controls that have focus to avoid yanking a click target out from
  // under the user.
  private syncControlsValues(panel: HTMLElement) {
    const active = document.activeElement;
    const setSelect = (sel: HTMLSelectElement | null, v: string) => {
      if (!sel || sel === active) return;
      if (sel.value !== v) sel.value = v;
    };

    const enabledEl = panel.querySelector<HTMLInputElement>(".graph-heatmap-input-enabled");
    if (enabledEl && enabledEl !== active && enabledEl.checked !== this.settings.enabled) {
      enabledEl.checked = this.settings.enabled;
    }

    setSelect(panel.querySelector(".graph-heatmap-input-metric"), this.settings.metric);
    setSelect(panel.querySelector(".graph-heatmap-input-preset"), this.settings.preset);
    setSelect(panel.querySelector(".graph-heatmap-input-focus"), this.settings.focusMode);
    const scaleEl = panel.querySelector<HTMLSelectElement>(".graph-heatmap-input-scale");
    setSelect(scaleEl, this.settings.scaleMode);
    if (scaleEl) scaleEl.disabled = !isTimeMetric(this.settings.metric);

    const preview = panel.querySelector<HTMLElement>(".graph-heatmap-controls-preview");
    if (preview) {
      const [hot, mid, cold] = activeColors(this.settings);
      preview.style.background = `linear-gradient(to right, ${hot}, ${mid}, ${cold})`;
    }

    const labelEls = panel.querySelectorAll<HTMLSpanElement>(".graph-heatmap-controls-labels span");
    if (labelEls.length === 2) {
      const { hot, cold } = this.legendLabels();
      if (labelEls[0].textContent !== hot) labelEls[0].textContent = hot;
      if (labelEls[1].textContent !== cold) labelEls[1].textContent = cold;
    }

    // Range sliders: don't yank the handle the user is dragging.
    const minEl = panel.querySelector<HTMLInputElement>(".graph-heatmap-input-rangemin");
    if (minEl && minEl !== active && minEl.value !== String(this.settings.rangeMin)) {
      minEl.value = String(this.settings.rangeMin);
    }
    const maxEl = panel.querySelector<HTMLInputElement>(".graph-heatmap-input-rangemax");
    if (maxEl && maxEl !== active && maxEl.value !== String(this.settings.rangeMax)) {
      maxEl.value = String(this.settings.rangeMax);
    }
    const rangeLabelEl = panel.querySelector<HTMLElement>(".graph-heatmap-range-label");
    if (rangeLabelEl) {
      const txt = this.rangeLabelText();
      if (rangeLabelEl.textContent !== txt) rangeLabelEl.setText(txt);
    }
    const modeEl = panel.querySelector<HTMLElement>(".graph-heatmap-range-mode");
    if (modeEl && modeEl !== active && modeEl.textContent !== this.settings.rangeMode) {
      modeEl.setText(this.settings.rangeMode);
    }
  }

  private removeControls(leaf: WorkspaceLeaf) {
    const el = this.controlsEls.get(leaf);
    if (el) {
      el.detach();
      this.controlsEls.delete(leaf);
    }
  }

  onunload() {
    this.stopColorLoop();
    // restore default colors before unloading
    const leaves = [
      ...this.app.workspace.getLeavesOfType("graph"),
      ...this.app.workspace.getLeavesOfType("localgraph"),
    ];
    for (const leaf of leaves) {
      const view = leaf.view as unknown as GraphView;
      const renderer = view?.renderer;
      if (!renderer || !Array.isArray(renderer.nodes)) continue;
      // If we left the graph physics-filtered, rebuild the complete node set.
      const st = this.physState.get(leaf);
      if (st?.applied && st.snapshot && typeof renderer.setData === "function") {
        try { renderer.setData(st.snapshot); } catch { /* best-effort restore */ }
        this.physState.delete(leaf);
      }
      const fill = renderer.colors?.fill ?? { a: 1, rgb: 0x999999 };
      for (const node of renderer.nodes) {
        node.color = { a: fill.a, rgb: fill.rgb };
      }
      if (Array.isArray(renderer.links)) {
        for (const link of renderer.links) {
          if (!link.line) continue;
          link.line.visible = true;
          link.line.renderable = true;
          link.line.alpha = 1;
        }
      }
      renderer.changed?.();
      this.removeControls(leaf);
      this.removeTooltip(leaf);
    }
  }
}

function formatRelativeTime(ts: number): string {
  if (!ts) return "—";
  const diffMs = Date.now() - ts;
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function hexToRgbInt(hex: string): number {
  const h = hex.replace("#", "");
  return parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
}

function interpolateThree(
  hotHex: string,
  midHex: string,
  coldHex: string,
  t: number
): number {
  if (t < 0.5) return lerpRgb(hexToRgbInt(hotHex), hexToRgbInt(midHex), t * 2);
  return lerpRgb(hexToRgbInt(midHex), hexToRgbInt(coldHex), (t - 0.5) * 2);
}

function lerpRgb(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

class HeatmapSettingTab extends PluginSettingTab {
  plugin: GraphHeatmapPlugin;

  constructor(app: App, plugin: GraphHeatmapPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Enabled")
      .setDesc("Apply heatmap colors to graph view nodes.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
          this.plugin.settings.enabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Metric")
      .setDesc(
        "What drives the color. Time metrics (last modified, created) measure recency. " +
        "Link metrics measure how connected a note is — useful for spotting hubs and orphans."
      )
      .addDropdown((d) => {
        for (const m of Object.keys(METRIC_LABELS) as Metric[]) {
          d.addOption(m, METRIC_LABELS[m]);
        }
        d.setValue(this.plugin.settings.metric).onChange(async (v) => {
          this.plugin.settings.metric = v as Metric;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Scale mode")
      .setDesc(
        "Relative: rank nodes by value, spread the gradient across the whole vault — every color is always used. " +
        "Absolute: anchor the gradient to wall-clock age via 'Span (days)'. Absolute only applies to time metrics; " +
        "link metrics always use relative."
      )
      .addDropdown((d) =>
        d
          .addOption("relative", "Relative (percentile rank)")
          .addOption("absolute", "Absolute (days, time metrics only)")
          .setValue(this.plugin.settings.scaleMode)
          .onChange(async (v) => {
            this.plugin.settings.scaleMode = v as ScaleMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Color preset")
      .setDesc(
        "Pre-built palettes. Pick 'Custom' to define your own three stops below."
      )
      .addDropdown((d) => {
        for (const name of Object.keys(COLOR_PRESETS)) d.addOption(name, name);
        d.addOption("custom", "Custom");
        d.setValue(this.plugin.settings.preset).onChange(async (v) => {
          this.plugin.settings.preset = v;
          await this.plugin.saveSettings();
          this.display(); // re-render to reflect custom-color enabled state
        });
      });

    const customDisabled = this.plugin.settings.preset !== "custom";
    const customNote = customDisabled
      ? "Custom mode is OFF — these are only used when 'Color preset' is set to Custom."
      : "";

    new Setting(containerEl)
      .setName("Custom hot color (newest / most)")
      .setDesc(customNote)
      .addColorPicker((c) =>
        c.setValue(this.plugin.settings.hotColor).onChange(async (v) => {
          this.plugin.settings.hotColor = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Custom mid color")
      .addColorPicker((c) =>
        c.setValue(this.plugin.settings.midColor).onChange(async (v) => {
          this.plugin.settings.midColor = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Custom cold color (oldest / least)")
      .addColorPicker((c) =>
        c.setValue(this.plugin.settings.coldColor).onChange(async (v) => {
          this.plugin.settings.coldColor = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Span (days)")
      .setDesc("Absolute mode only. Age at which a note is fully 'cold'. Older notes saturate at cold color.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.spanDays))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!Number.isNaN(n) && n > 0) {
              this.plugin.settings.spanDays = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Log scale")
      .setDesc("Compress the long tail — recent edits become more visually distinct.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.logScale).onChange(async (v) => {
          this.plugin.settings.logScale = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show gradient labels")
      .setDesc("Show the 'newest / oldest' or 'most / least' labels under the gradient swatch inside the controls panel.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showLegend).onChange(async (v) => {
          this.plugin.settings.showLegend = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show controls panel in graph view")
      .setDesc("Floating panel inside the graph view (bottom-left) with metric, scale, color preset, and gradient swatch — change everything without opening settings.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showControls).onChange(async (v) => {
          this.plugin.settings.showControls = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Focus Mode" });

    new Setting(containerEl)
      .setName("Hide completely vs dim")
      .setDesc("When Focus Mode is active, nodes that don't match the filter are dimmed by default (alpha 0.12). Turn this on to hide them and their edges completely.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.filterHideCompletely).onChange(async (v) => {
          this.plugin.settings.filterHideCompletely = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Recent-edit halo" });

    new Setting(containerEl)
      .setName("Enable halo")
      .setDesc("Brighten the color of any note edited within the recency window. Always-on regardless of color metric.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.haloEnabled).onChange(async (v) => {
          this.plugin.settings.haloEnabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Halo window (hours)")
      .setDesc("How recent counts as 'just edited'. Default 24.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.haloHours))
          .onChange(async (v) => {
            const n = parseFloat(v);
            if (!Number.isNaN(n) && n > 0) {
              this.plugin.settings.haloHours = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Halo color")
      .setDesc("Recently edited node colors get blended toward this color.")
      .addColorPicker((c) =>
        c.setValue(this.plugin.settings.haloColor).onChange(async (v) => {
          this.plugin.settings.haloColor = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Tooltip" });

    new Setting(containerEl)
      .setName("Show hover tooltip")
      .setDesc("When hovering a node in the graph view, show its file path, the current metric's raw value, modification time, connection count, and rank within the vault.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showTooltip).onChange(async (v) => {
          this.plugin.settings.showTooltip = v;
          await this.plugin.saveSettings();
        })
      );
  }
}
