import { App, TAbstractFile, Plugin, PluginSettingTab, Setting, FileView, Keymap, Events } from 'obsidian';
import * as d3 from "d3";
import { assert } from 'console';
import { around } from 'monkey-around'; // for canvas patching

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

class CanvasEvent extends Events {
	constructor() {
	  super();
	}
}
type CanvasEventType = "CANVAS_MOVED" | "CANVAS_DIRTY" | "CANVAS_VIEWPORT_CHANGED" | "CANVAS_TICK";
type CanvasNavigationStrategy = "PAN" | "ZOOM" | "NONE";

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
	minX: number
	minY: number
	maxX: number
	maxY: number
	constructor(min_x = 0, min_y = 0, max_x = 0, max_y = 0) {
		this.minX = min_x
		this.minY = min_y
		this.maxX = max_x
		this.maxY = max_y
	}
	static fromRect(bbox: SVGRect | undefined) {
		if (!bbox)
			return new BoundingBox()
		return new BoundingBox(bbox.x, bbox.y, bbox.x + bbox.width, bbox.y + bbox.height)
	}
	width() {
		return this.maxX - this.minX
	}
	height() {
		return this.maxY - this.minY
	}
	contains(p: Vector2) {
		return p.x >= this.minX && p.x <= this.maxX && p.y >= this.minY && p.y <= this.maxY
	}
	isValid(){
		return this.minX < this.maxX && this.minY < this.maxY	
	}
}

function clamp(x: number, min: number, max: number) {
	return Math.min(Math.max(x, min), max)
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
	hijackToolbar: boolean;
	drawActiveViewport: boolean;
	primaryNavigationStrategy: CanvasNavigationStrategy;
	secondaryNavigationStrategy: CanvasNavigationStrategy;
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
	nodeColor: '#c3d6d7',
	hijackToolbar: false,
	drawActiveViewport: true,
	primaryNavigationStrategy: 'ZOOM',
	secondaryNavigationStrategy: 'PAN'
}

export default class CanvasMinimap extends Plugin {
	settings: CanvasMinimapSettings;
	canvas_bounds: BoundingBox = new BoundingBox()
	canvas_patched: boolean = false
	canvas_event: CanvasEvent = new CanvasEvent()

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
		this.registerEvent(this.app.workspace.on('resize', () => {
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


		const bbox: BoundingBox = new BoundingBox();
		const groups: Map<string, any> = new Map()
		const children: Map<string, any> = new Map()
		nodes.forEach((node: any) => {
			bbox.minX = Math.min(bbox.minX, node.x);
			bbox.minY = Math.min(bbox.minY, node.y);
			bbox.maxX = Math.max(bbox.maxX, node.x + node.width);
			bbox.maxY = Math.max(bbox.maxY, node.y + node.height);
			if (node.unknownData?.type === 'group') {
				groups.set(node.id, node)
			} else {
				children.set(node.id, node)
			}
		});

		// save the canvas bounds
		this.canvas_bounds = new BoundingBox(
			bbox.minX - this.settings.margin, 
			bbox.minY - this.settings.margin, 
			bbox.maxX + this.settings.margin,
			bbox.maxY + this.settings.margin)
		
		svg.attr(
			"viewBox",
			`${this.canvas_bounds.minX} ${this.canvas_bounds.minY} ${this.canvas_bounds.width()} ${this.canvas_bounds.height()}`
		)
			.attr("preserveAspectRatio", "xMidYMid meet")
			.attr("width", this.settings.width)
			.attr("height", this.settings.height);
		
		let bg = svg.append('g')
			.attr('id', 'minimap_bg')
		let fg = svg.append('g')
			.attr('id', 'minimap_fg')
		

		groups.forEach((n: any) => {
			const g = fg.append('g')
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
				const scale_x = this.settings.width / (bbox.maxX - bbox.minX)
				const scale_y = this.settings.height / (bbox.maxY - bbox.minY)
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
			const g = fg.append('g')
			const rect = g.append("rect");
			const props = Object.entries(n);
			for (const [k, v] of props) {
				if (k === 'x' || k === 'y' || k === 'width' || k === 'height' || k === 'id')
					rect.attr(k, v);
			}
			//rect.attr("stroke", "blue");
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
			fg
				.append("path")
				.attr("d", link)
				.attr("marker-end", "url(#arrowhead-end)")
				.attr("stroke", "grey")
				.attr("stroke-width", 8)
				.attr("fill", "none");

		})

		bg.append('rect')
			.attr('id', 'minimap_viewport')
			.attr('fill', 'none')

	}

	renderCanvasViewport(canvas: any) {
		if(!this.settings.drawActiveViewport)
			return
		if(!canvas)
			return
		let canvas_bbox = canvas.getViewportBBox()
		const svg = d3.select(canvas.wrapperEl.parentNode)
			.select('#_minimap_ > svg')
		
		svg.select('#minimap_viewport')
			.attr('x', canvas_bbox.minX)
			.attr('y', canvas_bbox.minY)
			.attr('width', canvas_bbox.maxX - canvas_bbox.minX)
			.attr('height', canvas_bbox.maxY - canvas_bbox.minY)
			.attr('fill', 'azure')
			.attr('fill-opacity', '0.1')
			.attr('stroke', 'orange')
			.attr('stroke-width', '12')
	}

	onunload() {
		this.unloadMinimap()
	}

	static onCanvasUpdate(_:any, ctx: CanvasMinimap) {
		ctx.renderCanvasViewport(ctx.getActiveCanvas())
	}

	dispatchCanvasEvent(type: CanvasEventType, e: any) {
		this.canvas_event.trigger(type, e, this)
	}

	// adapt from https://github.com/Quorafind/Obsidian-Collapse-Node/blob/master/src/canvasCollapseIndex.ts#L89
	patchCanvas(canvas:any) {
		let that = this
		if(canvas){
			const uninstaller = around(canvas.constructor.prototype, {
				markMoved: (next: any) =>
					function (e: any) {
						next.call(this, e);
						that.dispatchCanvasEvent('CANVAS_MOVED', e)
					},
				markDirty: (next: any) =>
					function (e: any) {
						next.call(this, e);
						that.dispatchCanvasEvent('CANVAS_DIRTY', e)
					},
				markViewportChanged: (next: any) =>
					function () {
						next.call(this);
						that.dispatchCanvasEvent('CANVAS_VIEWPORT_CHANGED', null)
					},
				requestFrame: (next: any) =>
					function (e: any) {
						next.call(this, e);
						that.dispatchCanvasEvent('CANVAS_TICK', null)
					},
			});
			this.register(uninstaller);
			this.canvas_patched = true;
		}
		// register event listeners
		this.canvas_event.on('CANVAS_TICK', CanvasMinimap.onCanvasUpdate)
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

			// remove canvas event listeners
			this.canvas_event.off('CANVAS_TICK', CanvasMinimap.onCanvasUpdate)
		}
	}
	setupMinimap() {
		if (!this.settings.enabled) return
		//let active_canvas = this.app.workspace.getActiveViewOfType("canvas")
		const active_canvas = this.getActiveCanvas()

		if (active_canvas) {
			this.patchCanvas(active_canvas)

			const container = d3.select(active_canvas.wrapperEl.parentNode)
			const toolbar = container.selectAll('.canvas-controls').filter(":not(#_minimap_toolbar_)")
			toolbar.style('display', 'flex') // restore toolbar if it was hidden
			const toolbar_item_rect = (toolbar.select('.canvas-control-item').node() as HTMLElement)?.getBoundingClientRect()

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
				const top_offset = this.settings.hijackToolbar ? toolbar_item_rect?.height + 4 : 0
				// position the minimap
				if (side === 'top-right') {
					div.style('top', `${top_offset}px`).style('right', '0')
				} else if (side === 'top-left') {
					div.style('top', `${top_offset}px`).style('left', '0')
				} else if (side === 'bottom-left') {
					div.style('bottom', '0').style('left', '0')
				} else if (side === 'bottom-right') {
					div.style('bottom', '0').style('right', '0')
				}

				// markers
				const svg = div.append('svg')
				const defs = svg.append("defs")
				defs
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
					const svg_nodes = Array.from(svg.selectAll('rect').filter(":not(#minimap_viewport)").nodes())

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
						const navigation_strategy = Keymap.isModifier(e, 'Ctrl') ? this.settings.secondaryNavigationStrategy : this.settings.primaryNavigationStrategy
						if(navigation_strategy === 'PAN'){
							active_canvas?.panTo(bbox.minX + (bbox.maxX - bbox.minX) / 2, bbox.minY + (bbox.maxY - bbox.minY) / 2)
						}else if(navigation_strategy === 'ZOOM'){
							active_canvas?.zoomToBbox(bbox)
						}
					}

				})
				container.on('click', (e: any) => {
					// locate rect of minimap
					//const [x, y] = d3.pointer(e)
					// cant register click on svg, so we dispatch click event to the svg /facepalm
					svg.node()?.dispatchEvent(new MouseEvent('click', {
						bubbles: false, clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey,
						altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey
					}))
				})


				// rearrange toolbar
				if(this.settings.hijackToolbar){
					if(container.select('#_minimap_toolbar_').empty()){
						let toolbar_clone = container.select('.canvas-controls').clone(true)
						
						container.append(() => toolbar_clone.node())
						toolbar_clone.attr('id', '_minimap_toolbar_').style('display', 'flex')
						
						// get minimap position
						setTimeout(()=>{
							const minimap_pos = new Vector2((minimap.node() as HTMLElement)?.offsetLeft, (minimap.node() as HTMLElement)?.offsetTop)
							toolbar_clone
							.style('position', 'absolute')
							.style('left', `${minimap_pos?.x}px`)
							.style('top', `${minimap_pos?.y - top_offset}px`)
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
					
					minimap_toolbar.selectAll('.canvas-control-item').select(function(d:any, i:number, nodes:any){
						d3.select(this).on('click', (e:any)=>{						
							toolbar.selectAll('.canvas-control-item').filter((_:any, idx:number) => idx == i ).dispatch('click')
						})
						return this;
					})
					// hide original toolbar
					toolbar.style('display', 'none')
				}else{
					// reset toolbar visibility
					toolbar.style('display', 'flex')
				}
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

		new Setting(containerEl)
			.setName('Hijack toolbar')
			.setDesc('Move the toolbar on top of the minimap')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.hijackToolbar)
				.onChange(async (value) => {
					this.plugin.settings.hijackToolbar = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Draw active viewport')
			.setDesc('Draw the active viewport on the minimap')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.drawActiveViewport)
				.onChange(async (value) => {
					this.plugin.settings.drawActiveViewport = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('Primary navigation strategy')
			.setDesc('Primary navigation strategy (Directly click on minimap)')
			.addDropdown(dropdown => dropdown
				.addOptions({
					'PAN': 'Pan',
					'ZOOM': 'Zoom',
					'NONE': 'None'
				})
				.setValue(this.plugin.settings.primaryNavigationStrategy)
				.onChange(async (value) => {
					this.plugin.settings.primaryNavigationStrategy = value as CanvasNavigationStrategy;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Secondary navigation strategy')
			.setDesc('Secondary navigation strategy (Ctrl + click on minimap)')
			.addDropdown(dropdown => dropdown
				.addOptions({
					'PAN': 'Pan',
					'ZOOM': 'Zoom',
					'NONE': 'None'
				})
				.setValue(this.plugin.settings.secondaryNavigationStrategy)
				.onChange(async (value) => {
					this.plugin.settings.secondaryNavigationStrategy = value as CanvasNavigationStrategy;
					await this.plugin.saveSettings();
				}));
	}
}
