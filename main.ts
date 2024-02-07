import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import * as d3 from "d3";

class Vector2 {
	x: number
	y: number
	constructor(x: number, y: number) {
		this.x = x
		this.y = y
	}
	static add(a: Vector2, b: Vector2) {
		return new Vector2(a.x + b.x, a.y + b.y)

	}
	static sub(a: Vector2, b: Vector2) {
		return new Vector2(a.x - b.x, a.y - b.y)
	}

	static len(a: Vector2) {
		return Math.sqrt(Vector2.lenSq(a))
	}

	static lenSq(a: Vector2) {
		return a.x * a.x + a.y * a.y
	}
}

class BoundingBox {
	min_x: number
	min_y: number
	max_x: number
	max_y: number
	constructor(min_x: number = 0, min_y: number = 0, max_x: number = 0, max_y: number = 0) {
		this.min_x = min_x
		this.min_y = min_y
		this.max_x = max_x
		this.max_y = max_y
	}
	static fromRect(bbox:SVGRect) {
		return new BoundingBox(bbox.x, bbox.y, bbox.x + bbox.width, bbox.y + bbox.height)
	}
	width() {
		return this.max_x - this.min_x
	}
	height() {
		return this.max_y - this.min_y
	}
	contains(p: Vector2) {
		return p.x >= this.min_x && p.x <= this.max_x && p.y >= this.min_y && p.y <= this.max_y
	}
}

// Remember to rename these classes and interfaces!
type MinimapSide = 'top-right' | 'top-left' | 'bottom-left' | 'bottom-right';

interface CanvasMinimapSettings {
	width: number;
	height: number;
	margin: number;
	fontSize: number;
	side: MinimapSide;
	enabled: boolean;
	backgroundColor: string;
	groupColor: string;
	nodeColor: string;
}

const DEFAULT_SETTINGS: CanvasMinimapSettings = {
	width: 400,
	height: 300,
	margin: 100,
	fontSize: 10,
	side: 'bottom-right',
	enabled: true,
	backgroundColor: '#f3f0e933',
	groupColor: '#bdd5de55',
	nodeColor: '#c3d6d7'
}

export default class CanvasMinimap extends Plugin {
	settings: CanvasMinimapSettings;

	async onload() {
		await this.loadSettings();


		this.addCommand({
			id: 'canvas-minimap-reload',
			name: 'Reload Canvas minimap',
			checkCallback: (checking: boolean) => {

				if (this.getActiveCanvas()) {
					if (!checking) {
						this.reloadMinimap()
					}
					return true;
				}
			}
		});

		this.addCommand({
			id: 'canvas-minimap-toggle',
			name: 'Toggle Canvas minimap',
			checkCallback: (checking: boolean) => {
				if (this.getActiveCanvas()) {
					if (!checking) {
						this.settings.enabled = !this.settings.enabled
						this.saveSettings()
					}
					return true;
				}
			}
		});

		this.addSettingTab(new CanvasMinimapSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.setupMinimap()
		})
		this.app.workspace.on('active-leaf-change', () => {
			this.reloadMinimap()
		})
	}

	renderMinimap(svg: any, canvas: any) {
		let nodes: Map<string, any> = canvas.nodes
		let edges: Map<string, any> = canvas.edges

		let sidePositionOf = (node: any, side: string) => {
			let origin = new Vector2(node.x, node.y);
			let radius = new Vector2(node.width / 2, node.height / 2);
			let center = Vector2.add(origin, radius);

			if (side == "left") {
				return Vector2.sub(center, new Vector2(radius.x, 0));
			} else if (side == "right") {
				return Vector2.add(center, new Vector2(radius.x, 0));
			} else if (side == "top") {
				return Vector2.sub(center, new Vector2(0, radius.y));
			} else if (side == "bottom") {
				return Vector2.add(center, new Vector2(0, radius.y));
			}
			throw new Error(`invalid side ${side}`);
		};

		// clear the svg		
		svg.selectAll('*').remove();

		let bbox:BoundingBox = new BoundingBox();
		let groups: Map<string, any> = new Map()
		let children: Map<string, any> = new Map()
		nodes.forEach((node: any) => {
			bbox.min_x = Math.min(bbox.min_x, node.x);
			bbox.min_y = Math.min(bbox.min_y, node.y);
			bbox.max_x = Math.max(bbox.max_x, node.x + node.width);
			bbox.max_y = Math.max(bbox.max_y, node.y + node.height);
			if (node.unknownData?.type === 'group') {
				groups.set(node.id, node)
			} else {
				children.set(node.id, node)
			}
		});


		svg.attr(
			"viewBox",
			`${bbox.min_x - this.settings.margin} ${bbox.min_y - this.settings.margin} ${bbox.max_x - bbox.min_x + this.settings.margin} ${bbox.max_y - bbox.min_y + this.settings.margin
			} `
		)
			.attr("preserveAspectRatio", "xMidYMid meet")
			.attr("width", this.settings.width)
			.attr("height", this.settings.height);

		groups.forEach((n: any) => {
			let g = svg.append('g')
			let rect = g.append("rect");

			let props = Object.entries(n);
			for (let [k, v] of props) {
				// allowed props: x, y, width, height, id
				if (k === 'x' || k === 'y' || k === 'width' || k === 'height' || k === 'id')
					rect.attr(k, v);
			}
			rect.attr("stroke", "darkblue");
			rect.attr("fill", this.settings.groupColor);
			rect.on('click', (e: any) => {
				console.log('clicked', n)
			})

			let label: string = n.label
			if (label) {
				// prevent text from scaling
				let scale_x = this.settings.width / (bbox.max_x - bbox.min_x)
				let scale_y = this.settings.height / (bbox.max_y - bbox.min_y)
				let scale = Math.min(scale_x, scale_y)
				let font_size = this.settings.fontSize / scale
				let text = g.append("text")
				text
					.text(label)
					.attr("x", n.x)
					.attr("y", n.y)
					.attr("text-anchor", "left")
					.attr("alignment-baseline", "left")
					.attr("fill", "white")
					.attr("font-size", font_size)
					.attr("font-weight", "bold")

			}
		})
		children.forEach((n: any) => {
			let rect = svg.append("rect");
			let props = Object.entries(n);
			for (let [k, v] of props) {
				if (k === 'x' || k === 'y' || k === 'width' || k === 'height' || k === 'id')
					rect.attr(k, v);
			}
			rect.attr("stroke", "blue");
			rect.attr("fill", this.settings.nodeColor);
		})
		edges.forEach((e: any) => {
			let fromPos = sidePositionOf(e.from.node, e.from.side);
			let toPos = sidePositionOf(e.to.node, e.to.side);

			let linkAnchor = (side: string) => {
				if (side == "left" || side == "right") return d3.linkHorizontal();
				else return d3.linkVertical();
			};
			let link = linkAnchor(e.fromSide)
				.x((d: any) => d.x)
				.y((d: any) => d.y)({
					source: fromPos,
					target: toPos
				});
			svg
				.append("path")
				.attr("d", link)
				.attr("marker-end", "url(#arrowhead-end)")
				.attr("stroke", "grey")
				.attr("stroke-width", 5)
				.attr("fill", "none");

		})

		//console.log(svg, nodes, edges)
	}

	onunload() {
		this.unloadMinimap()
	}

	getActiveCanvas(): any {
		const maybeCanvasView = this.app.workspace?.getLeaf().view
		return maybeCanvasView ? (maybeCanvasView as any)['canvas'] : null
	}

	reloadMinimap() {
		this.unloadMinimap()
		this.setupMinimap()
	}
	unloadMinimap() {
		let active_canvas = this.getActiveCanvas()
		if (active_canvas) {
			let container = d3.select(active_canvas.wrapperEl.parentNode)
			let minimap = container.select('#_minimap_')
			if (!minimap.empty()) {
				minimap.remove()
			}
		}
	}
	setupMinimap() {
		if (!this.settings.enabled) return
		//let active_canvas = this.app.workspace.getActiveViewOfType("canvas")
		let active_canvas = this.getActiveCanvas()

		if (active_canvas) {
			let container = d3.select(active_canvas.wrapperEl.parentNode)
			let minimap = container.select('#_minimap_')
			if (minimap.empty()) {

				let div = container.append('div').attr('id', '_minimap_')
					.style('position', 'absolute')
					.style('width', this.settings.width)
					.style('height', this.settings.height)
					.style('background-color', this.settings.backgroundColor)
					.style('z-index', '1000')
					.style('opacity', '0.3')
					.style('pointer-events', 'none')
					.style('border', '1px solid black')
					.style('border-radius', '5px')
					.style('overflow', 'hidden')

				let side = this.settings.side
				// position the minimap
				if (side === 'top-right') {
					div.style('top', '0').style('right', '0')
				} else if (side === 'top-left') {
					div.style('top', '0').style('left', '0')
				} else if (side === 'bottom-left') {
					div.style('bottom', '0').style('left', '0')
				} else if (side === 'bottom-right') {
					div.style('bottom', '0').style('right', '0')
				}

				// markers
				let svg = div.append('svg')
				svg
					.append("defs")
					.selectAll("marker")
					.data(["arrowhead-start", "arrowhead-end"]) // Unique ids for start and end markers
					.enter()
					.append("marker")
					.attr("id", (d: string) => d)
					.attr("markerWidth", 10)
					.attr("markerHeight", 7)
					.attr("refX", (d: string) => (d === "arrowhead-start" ? 10 : 0)) // Adjust refX for start and end markers
					.attr("refY", 3.5)
					.attr("orient", "auto")
					.append("polygon")
					.attr("points", (d: string) =>
						d === "arrowhead-start" ? "10 0, 0 3.5, 10 7" : "0 0, 10 3.5, 0 7"
					);

				minimap = container.select('#_minimap_')
				svg.on('click', (e: any) => {
					let active_canvas = this.getActiveCanvas()

					let p = d3.pointer(e)
					let [x, y] = p
					let svg_bbox = BoundingBox.fromRect(svg.node().getBBox())

					if (!svg_bbox.contains(new Vector2(x, y))) {
						return
					}
					let svg_nodes = Array.from(svg.selectAll('rect').nodes())

					let target_nodes = svg_nodes.filter((n: any, i:Number) => {
						let bbox = BoundingBox.fromRect(n.getBBox())
						return bbox.contains(new Vector2(x, y))
					}).map((n: any) => active_canvas.nodes?.get(n.id))
					
					if(target_nodes.length > 0){
						// focus to nearest node
						let bbox = target_nodes[0].bbox
						let distSq = Vector2.lenSq(new Vector2(bbox.minX - x, bbox.minY - y))
						for(let n of target_nodes){
							let current_bbox = n.bbox
							let current_distSq = Vector2.lenSq(new Vector2(current_bbox.minX - x, current_bbox.minY - y))
							if(current_distSq < distSq){
								distSq = current_distSq
								bbox = current_bbox
							}
						}
						active_canvas?.zoomToBbox(bbox)
					}
					
				})
				container.on('click', (e: any) => {
					// locate rect of minimap
					let [x, y] = d3.pointer(e)
					// cant register click on svg, so we dispatch click event to the svg /facepalm
					svg.node().dispatchEvent(new MouseEvent('click', { bubbles: false, clientX: e.clientX, clientY: e.clientY }))
				})

			}

			this.renderMinimap(container.select('#_minimap_>svg'), active_canvas)
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.reloadMinimap()
	}
}


class CanvasMinimapSettingTab extends PluginSettingTab {
	plugin: CanvasMinimap;

	constructor(app: App, plugin: CanvasMinimap) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		containerEl.createEl('h2', { text: 'Canvas Minimap Settings' });

		new Setting(containerEl)
			.setName('Width')
			.setDesc('Width of the minimap')
			.addText(text => text
				.setValue(this.plugin.settings.width.toString())
				.onChange(async (value) => {
					this.plugin.settings.width = parseInt(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Height')
			.setDesc('Height of the minimap')
			.addText(text => text
				.setValue(this.plugin.settings.height.toString())
				.onChange(async (value) => {
					this.plugin.settings.height = parseInt(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Margin')
			.setDesc('Margin of the minimap')
			.addText(text => text
				.setValue(this.plugin.settings.margin.toString())
				.onChange(async (value) => {
					this.plugin.settings.margin = parseInt(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Font Size')
			.setDesc('Font size of the minimap')
			.addText(text => text
				.setValue(this.plugin.settings.fontSize.toString())
				.onChange(async (value) => {
					this.plugin.settings.fontSize = parseInt(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Side')
			.setDesc('Side of the minimap')
			.addDropdown(dropdown => dropdown
				.addOptions({
					'top-right': 'Top Right',
					'top-left': 'Top Left',
					'bottom-left': 'Bottom Left',
					'bottom-right': 'Bottom Right'
				})
				.setValue(this.plugin.settings.side)
				.onChange(async (value) => {
					this.plugin.settings.side = value as MinimapSide;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Enabled')
			.setDesc('Enable minimap')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enabled)
				.onChange(async (value) => {
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Background Color')
			.setDesc('Background color of the minimap')
			.addText(text => text
				.setValue(this.plugin.settings.backgroundColor)
				.onChange(async (value) => {
					this.plugin.settings.backgroundColor = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Group Color')
			.setDesc('Color of the group nodes')
			.addText(text => text
				.setValue(this.plugin.settings.groupColor)
				.onChange(async (value) => {
					this.plugin.settings.groupColor = value;
					await this.plugin.saveSettings();
				}));
	}
}
