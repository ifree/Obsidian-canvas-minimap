import { App, TAbstractFile, Plugin, PluginSettingTab, Setting, FileView } from 'obsidian';
import * as d3 from "d3";

// Obsidian canvas types
interface CanvasRect{
	cx: number;
	cy: number;
	width: number;
	height: number;
	left: number;
	top: number;
	maxX: number;
	maxY: number;
	minX: number;
	minY: number;
}


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
	constructor(min_x = 0, min_y = 0, max_x = 0, max_y = 0) {
		this.min_x = min_x
		this.min_y = min_y
		this.max_x = max_x
		this.max_y = max_y
	}
	static fromRect(bbox: SVGRect | undefined) {
		if (!bbox)
			return new BoundingBox()
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
	fontColor: string;
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
	fontColor: 'white',
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
			id: 'reload',
			name: 'Reload the minimap',
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
			id: 'toggle',
			name: 'Toggle the minimap',
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

		this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
			this.reloadMinimap()
		}))
		this.registerEvent(this.app.vault.on('modify', (file: TAbstractFile) => {
			if(!this.getActiveCanvas())
				return
			const activeFile = this.app.workspace.getActiveFile()
			// check if the file is the active file
			if (activeFile && file.path === activeFile.path)
			{
				this.reloadMinimap()
			}
		}))
	}

	renderMinimap(svg: any, canvas: any) {
		const nodes: Map<string, any> = canvas.nodes
		const edges: Map<string, any> = canvas.edges

		const sidePositionOf = (node: any, side: string) => {
			const origin = new Vector2(node.x, node.y);
			const radius = new Vector2(node.width / 2, node.height / 2);
			const center = Vector2.add(origin, radius);

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

		const bbox: BoundingBox = new BoundingBox();
		const groups: Map<string, any> = new Map()
		const children: Map<string, any> = new Map()
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
			const g = svg.append('g')
			const rect = g.append("rect");

			const props = Object.entries(n);
			for (const [k, v] of props) {
				// allowed props: x, y, width, height, id
				if (k === 'x' || k === 'y' || k === 'width' || k === 'height' || k === 'id')
					rect.attr(k, v);
			}
			rect.attr("stroke", "darkblue");
			rect.attr("fill", this.settings.groupColor);
			

			const label: string = n.label
			if (label) {
				// prevent text from scaling
				const scale_x = this.settings.width / (bbox.max_x - bbox.min_x)
				const scale_y = this.settings.height / (bbox.max_y - bbox.min_y)
				const scale = Math.min(scale_x, scale_y)
				const font_size = this.settings.fontSize / scale
				const text = g.append("text")
				text
					.text(label)
					.attr("x", n.x)
					.attr("y", n.y)
					.attr("text-anchor", "left")
					.attr("alignment-baseline", "left")
					.attr("fill", this.settings.fontColor)
					.attr("font-size", font_size)
					.attr("font-weight", "bold")

			}
		})
		children.forEach((n: any) => {
			const rect = svg.append("rect");
			const props = Object.entries(n);
			for (const [k, v] of props) {
				if (k === 'x' || k === 'y' || k === 'width' || k === 'height' || k === 'id')
					rect.attr(k, v);
			}
			rect.attr("stroke", "blue");
			rect.attr("fill", this.settings.nodeColor);
		})
		edges.forEach((e: any) => {
			const fromPos = sidePositionOf(e.from.node, e.from.side);
			const toPos = sidePositionOf(e.to.node, e.to.side);


			const linkAnchor = (side: string) => {
				if (side == "left" || side == "right") return d3.linkHorizontal();
				else return d3.linkVertical();
			};
			const link = linkAnchor(e.fromSide)(
				{
					source: [fromPos.x, fromPos.y],
					target: [toPos.x, toPos.y]
				});
			//console.log(e, fromPos, toPos, link)
			svg
				.append("path")
				.attr("d", link)
				.attr("marker-end", "url(#arrowhead-end)")
				.attr("stroke", "grey")
				.attr("stroke-width", 5)
				.attr("fill", "none");

		})

		//project client area to the minimap
		let canvas_rect = canvas.canvasRect as CanvasRect;
		if(canvas_rect){
			//TODO: later			
		}

	}

	onunload() {
		this.unloadMinimap()
	}

	getActiveCanvas(): any {
		let currentView = this.app.workspace?.getActiveViewOfType(FileView)
		if(currentView?.getViewType() !== 'canvas')
			return null
		return (currentView as any)['canvas']
	}

	reloadMinimap() {
		this.unloadMinimap()
		this.setupMinimap()
	}
	unloadMinimap() {
		const active_canvas = this.getActiveCanvas()
		if (active_canvas) {
			const container = d3.select(active_canvas.wrapperEl.parentNode)
			const minimap = container.select('#_minimap_')
			if (!minimap.empty()) {
				minimap.remove()
			}
			const toolbar = container.select('#_minimap_toolbar_')
			if (!toolbar.empty()) {
				toolbar.remove()
			}
		}
	}
	setupMinimap() {
		if (!this.settings.enabled) return
		//let active_canvas = this.app.workspace.getActiveViewOfType("canvas")
		const active_canvas = this.getActiveCanvas()

		if (active_canvas) {
			const container = d3.select(active_canvas.wrapperEl.parentNode)
			let minimap = container.select('#_minimap_')
			if (minimap.empty()) {

				const div = container.append('div').attr('id', '_minimap_')
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

				const side = this.settings.side
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
				const svg = div.append('svg')
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
					const active_canvas = this.getActiveCanvas()

					const p = d3.pointer(e)
					const [x, y] = p
					const svg_bbox = BoundingBox.fromRect(svg.node()?.getBBox())

					if (!svg_bbox.contains(new Vector2(x, y))) {
						return
					}
					const svg_nodes = Array.from(svg.selectAll('rect').nodes())

					const target_nodes = svg_nodes.filter((n: any, i: number) => {
						const bbox = BoundingBox.fromRect(n.getBBox())
						return bbox.contains(new Vector2(x, y))
					}).map((n: any) => active_canvas.nodes?.get(n.id))

					if (target_nodes.length > 0) {
						// focus to nearest node
						let bbox = target_nodes[0].bbox
						let distSq = Vector2.lenSq(new Vector2(bbox.minX - x, bbox.minY - y))
						for (const n of target_nodes) {
							const current_bbox = n.bbox
							const current_distSq = Vector2.lenSq(new Vector2(current_bbox.minX - x, current_bbox.minY - y))
							if (current_distSq < distSq) {
								distSq = current_distSq
								bbox = current_bbox
							}
						}
						active_canvas?.zoomToBbox(bbox)
					}

				})
				container.on('click', (e: any) => {
					// locate rect of minimap
					//const [x, y] = d3.pointer(e)
					// cant register click on svg, so we dispatch click event to the svg /facepalm
					svg.node()?.dispatchEvent(new MouseEvent('click', { bubbles: false, clientX: e.clientX, clientY: e.clientY }))
				})

				// rearrange toolbar
				if(container.select('#_minimap_toolbar_').empty()){
					let toolbar_clone = container.select('.canvas-controls').clone(true)
					let toolbar_item_rect = (toolbar_clone.select('.canvas-control-item').node() as HTMLElement)?.getBoundingClientRect()
					container.append(() => toolbar_clone.node())
					toolbar_clone.attr('id', '_minimap_toolbar_')
					
					// get minimap position
					setTimeout(()=>{
						const minimap_pos = new Vector2((minimap.node() as HTMLElement)?.offsetLeft, (minimap.node() as HTMLElement)?.offsetTop)
						toolbar_clone
						.style('position', 'absolute')
						.style('left', `${minimap_pos?.x}px`)
						.style('top', `${minimap_pos?.y - toolbar_item_rect.height - 4}px`)
						.style('z-index', '1001')
						.style('flex-direction', 'row')
						.style('justify-content', 'flex-start')
						.style('align-items', 'top')
						.style('padding', '0')
						.style('margin', '0')
						.style('background-color', 'transparent')
						.style('border', 'none')
						toolbar_clone.selectAll('.canvas-control-group').style('flex-direction', 'row')		
					}, 500)
				}
				// toolbar event routing
				// TODO: optimize this later
				const minimap_toolbar = container.selectAll('.canvas-controls').filter("#_minimap_toolbar_")
				const toolbar = container.selectAll('.canvas-controls').filter(":not(#_minimap_toolbar_)")
				minimap_toolbar.selectAll('.canvas-control-item').select(function(d:any, i:number, nodes:any){
					d3.select(this).on('click', (e:any)=>{						
						toolbar.selectAll('.canvas-control-item').filter((_:any, idx:number) => idx == i ).dispatch('click')
					})
					return this;
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
			.setDesc('Margin around the minimap')
			.addText(text => text
				.setValue(this.plugin.settings.margin.toString())
				.onChange(async (value) => {
					this.plugin.settings.margin = parseInt(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Font size')
			.setDesc('The font size of the minimap labels')
			.addText(text => text
				.setValue(this.plugin.settings.fontSize.toString())
				.onChange(async (value) => {
					this.plugin.settings.fontSize = parseInt(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Font color')
			.setDesc('The font color of the minimap labels')
			.addText(text => text
				.setValue(this.plugin.settings.fontColor)
				.onChange(async (value) => {
					this.plugin.settings.fontColor = value;
					await this.plugin.saveSettings();
				}));


		new Setting(containerEl)
			.setName('Side')
			.setDesc('Which side of the editor view to place the minimap on')
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
			.setDesc('Whether the minimap is enabled')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enabled)
				.onChange(async (value) => {
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Background color')
			.setDesc('Background color of the minimap')
			.addText(text => text
				.setValue(this.plugin.settings.backgroundColor)
				.onChange(async (value) => {
					this.plugin.settings.backgroundColor = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Group color')
			.setDesc('Color of the group nodes')
			.addText(text => text
				.setValue(this.plugin.settings.groupColor)
				.onChange(async (value) => {
					this.plugin.settings.groupColor = value;
					await this.plugin.saveSettings();
				}));
	}
}
