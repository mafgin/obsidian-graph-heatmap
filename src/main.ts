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

type Metric =
  | "mtime"          // last modified — newest hottest
  | "ctime"          // created — newest hottest
  | "totalLinks"     // backlinks + outgoing
  | "backlinks"      // incoming only
  | "outgoingLinks"; // outgoing only

interface HeatmapSettings {
  enabled: boolean;
  metric: Metric;
  scaleMode: ScaleMode;   // relative = percentile rank (recommended); absolute = days (mtime/ctime only)
  preset: string;         // one of COLOR_PRESETS keys, or "custom"
  hotColor: string;       // active only when preset === "custom"
  midColor: string;
  coldColor: string;
  spanDays: number;       // only used in absolute mode for time metrics
  logScale: boolean;
  showLegend: boolean;
  showControls: boolean;       // floating in-graph control panel
  controlsCollapsed: boolean;  // panel collapsed to its title bar only
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
};

const METRIC_LABELS: Record<Metric, string> = {
  mtime: "Last modified",
  ctime: "Created",
  totalLinks: "Total connections (back + out)",
  backlinks: "Backlinks (incoming)",
  outgoingLinks: "Outgoing links",
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

function activeColors(s: HeatmapSettings): [string, string, string] {
  if (s.preset !== "custom" && COLOR_PRESETS[s.preset]) {
    return COLOR_PRESETS[s.preset];
  }
  return [s.hotColor, s.midColor, s.coldColor];
}

interface GraphNode {
  id: string;
  color?: { a: number; rgb: number };
  type?: string;
}

interface GraphRenderer {
  nodes: GraphNode[];
  colors: { fill: { a: number; rgb: number } };
  changed?: () => void;
  px?: { ticker?: { _emitter?: unknown } };
}

interface GraphView {
  renderer: GraphRenderer;
  getViewType(): string;
}

export default class GraphHeatmapPlugin extends Plugin {
  settings: HeatmapSettings = DEFAULTS;
  private repaintScheduled = false;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new HeatmapSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.scheduleRepaint())
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.scheduleRepaint())
    );
    this.registerEvent(
      this.app.vault.on("modify", () => this.scheduleRepaint())
    );

    this.registerInterval(
      window.setInterval(() => this.scheduleRepaint(), 2000)
    );

    this.app.workspace.onLayoutReady(() => this.scheduleRepaint());

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

    if (!this.settings.enabled) {
      // restore: revert color to renderer.colors.fill
      const fill = renderer.colors?.fill ?? { a: 1, rgb: 0x999999 };
      for (const node of renderer.nodes) {
        node.color = { a: fill.a, rgb: fill.rgb };
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

    // Build link-count maps (only when needed) — single pass over resolvedLinks.
    let linkValue: ((path: string) => number) | null = null;
    if (!isTimeMetric(metric)) {
      const resolvedLinks = (this.app.metadataCache as unknown as {
        resolvedLinks: Record<string, Record<string, number>>;
      }).resolvedLinks;
      const outgoing = new Map<string, number>();
      const incoming = new Map<string, number>();
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
      if (metric === "backlinks") {
        linkValue = (p) => incoming.get(p) ?? 0;
      } else if (metric === "outgoingLinks") {
        linkValue = (p) => outgoing.get(p) ?? 0;
      } else {
        // totalLinks
        linkValue = (p) => (incoming.get(p) ?? 0) + (outgoing.get(p) ?? 0);
      }
    }

    // For each node, compute a value where HIGHER = HOTTER:
    //   mtime/ctime → the timestamp itself (newer file → larger value)
    //   *Links → the link count
    type Entry = { node: GraphNode; value: number; isReal: boolean };
    const entries: Entry[] = [];
    for (const node of renderer.nodes) {
      const file = this.app.vault.getAbstractFileByPath(node.id);
      if (file instanceof TFile) {
        let value: number;
        if (metric === "mtime") value = file.stat.mtime;
        else if (metric === "ctime") value = file.stat.ctime;
        else value = linkValue!(node.id);
        entries.push({ node, value, isReal: true });
      } else if (!isTimeMetric(metric)) {
        // unresolved/folder nodes can still have a link value
        entries.push({ node, value: linkValue!(node.id), isReal: true });
      } else {
        // time metrics can't apply to non-files → always cold
        entries.push({ node, value: Number.NEGATIVE_INFINITY, isReal: false });
      }
    }

    // Use relative mode for any non-time metric (absolute would need an arbitrary
    // max-link threshold). Honour the user choice only for time metrics.
    const useRelative =
      this.settings.scaleMode === "relative" || !isTimeMetric(metric);

    let fracOf: (e: Entry) => number;
    if (useRelative) {
      // Rank by value DESCENDING so highest = position 0 = hottest.
      const real = entries.filter((e) => e.isReal).slice().sort((a, b) => b.value - a.value);
      const ranks = new Map<GraphNode, number>();
      const denom = Math.max(1, real.length - 1);
      real.forEach((e, i) => ranks.set(e.node, i / denom));
      fracOf = (e) => (e.isReal ? ranks.get(e.node) ?? 1 : 1);
    } else {
      // Absolute time mode: frac = age / spanMs.
      fracOf = (e) => {
        if (!e.isReal) return 1;
        let f = (now - e.value) / spanMs;
        if (f > 1) f = 1;
        if (f < 0) f = 0;
        return f;
      };
    }

    const [hot, mid, cold] = activeColors(this.settings);
    for (const e of entries) {
      let frac = fracOf(e);
      if (this.settings.logScale) {
        frac = Math.log1p(frac * 9) / Math.log(10);
      }
      const rgb = interpolateThree(hot, mid, cold, frac);
      e.node.color = { a: 1, rgb };
    }

    renderer.changed?.();

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

  // Settings whose change requires a full DOM rebuild of the panel.
  // Anything else (metric, scaleMode, preset, enabled, custom colors, spanDays)
  // is reflected by syncing values onto the existing DOM so open dropdowns
  // are not destroyed mid-interaction.
  private structuralSig(): string {
    return JSON.stringify({
      c: this.settings.controlsCollapsed,
      l: this.settings.showLegend,
      // scale select's `disabled` depends on metric type — when the metric
      // crosses the time/link boundary we want the visual change to land.
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
  }

  private removeControls(leaf: WorkspaceLeaf) {
    const el = this.controlsEls.get(leaf);
    if (el) {
      el.detach();
      this.controlsEls.delete(leaf);
    }
  }

  onunload() {
    // restore default colors before unloading
    const leaves = [
      ...this.app.workspace.getLeavesOfType("graph"),
      ...this.app.workspace.getLeavesOfType("localgraph"),
    ];
    for (const leaf of leaves) {
      const view = leaf.view as unknown as GraphView;
      const renderer = view?.renderer;
      if (!renderer || !Array.isArray(renderer.nodes)) continue;
      const fill = renderer.colors?.fill ?? { a: 1, rgb: 0x999999 };
      for (const node of renderer.nodes) {
        node.color = { a: fill.a, rgb: fill.rgb };
      }
      renderer.changed?.();
      this.removeControls(leaf);
    }
  }
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
  }
}
