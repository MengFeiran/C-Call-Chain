import * as vscode from 'vscode';
import {
    Engine,
    gotoDefinition,
    gotoLocation,
    log,
    provideIncomingCalls,
    provideOutgoingCalls
} from './callHierarchy';
import { ApproxIndex, PtrHit } from './approxIndex';

/** 图中的一个节点（函数或函数指针） */
interface NodeModel {
    key: string;
    kind: 'function' | 'pointer';
    /** 函数节点的层次项 */
    item?: vscode.CallHierarchyItem;
    /** 函数指针节点的键与位置 */
    ptrKey?: string;
    ptrLocation?: { uri: vscode.Uri; position: vscode.Position };
    name: string;
    detail: string;
    /** 0 = 中心；负数 = 调用者侧；正数 = 被调用者侧 */
    column: number;
    expanded: boolean;
    loading: boolean;
    isRoot: boolean;
    /** 近似标记：'' / '宏' */
    badge: string;
    /** 展开时加入的邻居键集合（收起时据此裁剪） */
    neighbors: Set<string>;
}

/** 有向边：from 调用 to */
interface EdgeModel {
    from: string;
    to: string;
    approx: boolean;
}

/** 发送给 Webview 的节点数据 */
interface NodeDTO {
    key: string;
    kind: 'function' | 'pointer';
    name: string;
    detail: string;
    column: number;
    expanded: boolean;
    loading: boolean;
    isRoot: boolean;
    possible: boolean;
    badge: string;
}

interface GraphDTO {
    rootKey?: string;
    nodes: NodeDTO[];
    edges: EdgeModel[];
}

/**
 * 底部面板中的「调用图」Webview 视图。
 *
 * 布局：中心是当前函数，左侧为调用者，右侧为被调用者，用带箭头的曲线连接。
 * 函数指针会作为独立节点出现，形成链路：调用者 → B.func_ptr_a → func_a。
 */
export class CallChainGraphProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'cCallChain.view';

    private view?: vscode.WebviewView;
    private ready = false;
    private lastGraph?: GraphDTO;

    private readonly nodes = new Map<string, NodeModel>();
    private readonly edges = new Map<string, EdgeModel>();
    private readonly approxIndex = new ApproxIndex();
    private engine: Engine = 'builtin';
    private rootKey?: string;
    private current?: vscode.CallHierarchyItem;
    private history: vscode.CallHierarchyItem[] = [];

    constructor(private readonly extensionUri: vscode.Uri) {
        this.approxIndex.onReady(() => {
            void this.refreshApproxLinks();
        });
    }

    /** 近似索引就绪后，为已展开的节点补充近似邻居 */
    private async refreshApproxLinks(): Promise<void> {
        const before = this.nodes.size;
        try {
            for (const node of Array.from(this.nodes.values())) {
                if (!node.expanded) {
                    continue;
                }
                if (node.column <= 0) {
                    await this.addApproxCallers(node);
                }
                if (node.column >= 0) {
                    await this.addApproxCallees(node);
                }
            }
        } catch (err) {
            log(`补充近似节点失败: ${String(err)}`);
        }
        log(`近似索引就绪后刷新: 节点 ${before} -> ${this.nodes.size}`);
        this.postGraph();
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        this.ready = false;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };
        webviewView.webview.html = this.getHtml(webviewView.webview);
        webviewView.webview.onDidReceiveMessage(msg => this.onMessage(msg));
        webviewView.onDidDispose(() => {
            if (this.view === webviewView) {
                this.view = undefined;
                this.ready = false;
            }
        });
    }

    /** 以某函数为根，展示调用图（清空历史） */
    async show(item: vscode.CallHierarchyItem, engine: Engine): Promise<void> {
        this.engine = engine;
        this.current = item;
        this.history = [];
        await this.resetTo(item);
        await vscode.commands.executeCommand(`${CallChainGraphProvider.viewType}.focus`);
    }

    private async resetTo(item: vscode.CallHierarchyItem): Promise<void> {
        this.nodes.clear();
        this.edges.clear();
        const key = nodeKey(item);
        this.rootKey = key;
        this.nodes.set(key, {
            key,
            kind: 'function',
            item,
            name: item.name,
            detail: detailOf(item),
            column: 0,
            expanded: false,
            loading: false,
            isRoot: true,
            badge: '',
            neighbors: new Set<string>()
        });
        this.postGraph();
        await this.expandNode(key);
    }

    private async resetToPointer(hit: PtrHit): Promise<void> {
        this.nodes.clear();
        this.edges.clear();
        const key = 'ptr:' + hit.ptrKey;
        this.rootKey = key;
        this.nodes.set(key, {
            key,
            kind: 'pointer',
            ptrKey: hit.ptrKey,
            ptrLocation: hit.location,
            name: hit.label,
            detail: '函数指针',
            column: 0,
            expanded: false,
            loading: false,
            isRoot: true,
            badge: '',
            neighbors: new Set<string>()
        });
        this.postGraph();
        await this.expandNode(key);
    }

    /**
     * 懒加载并展开某节点。
     * 单向展开：中心节点（column 0）同时展开两侧；左侧节点只向调用者方向、
     * 右侧节点只向被调用者方向展开。
     */
    private async expandNode(key: string): Promise<void> {
        const node = this.nodes.get(key);
        if (!node || node.loading || node.expanded) {
            return;
        }
        node.loading = true;
        this.postGraph();

        try {
            const tasks: Promise<void>[] = [];
            if (node.column <= 0) {
                tasks.push(this.addCallers(node));
            }
            if (node.column >= 0) {
                tasks.push(this.addCallees(node));
            }
            await Promise.all(tasks);
            node.expanded = true;
        } catch (err) {
            log(`展开节点失败: ${String(err)}`);
        }

        node.loading = false;
        this.postGraph();
    }

    /** 调用者方向：真实调用者（函数节点）+ 近似 */
    private async addCallers(node: NodeModel): Promise<void> {
        if (node.kind === 'function' && node.item) {
            const calls = await provideIncomingCalls(node.item, this.engine);
            for (const call of calls) {
                this.addFunctionNeighbor(node, call.from, 'in');
            }
        }
        await this.addApproxCallers(node);
    }

    /** 被调用者方向：真实被调用者（函数节点）+ 近似 */
    private async addCallees(node: NodeModel): Promise<void> {
        if (node.kind === 'function' && node.item) {
            const calls = await provideOutgoingCalls(node.item, this.engine);
            for (const call of calls) {
                this.addFunctionNeighbor(node, call.to, 'out');
            }
        }
        await this.addApproxCallees(node);
    }

    private async addApproxCallers(node: NodeModel): Promise<boolean> {
        let changed = false;
        if (node.kind === 'pointer' && node.ptrKey) {
            for (const hit of await this.approxIndex.ptrCallersOfPointer(node.ptrKey)) {
                this.addFunctionNeighbor(node, hit.item, 'in', hit.badge, true);
                changed = true;
            }
            return changed;
        }
        if (node.item) {
            for (const hit of await this.approxIndex.macroCallers(node.item)) {
                this.addFunctionNeighbor(node, hit.item, 'in', hit.badge);
                changed = true;
            }
            // 本函数被赋值到的函数指针 → 指针节点（形成 指针 -> 本函数）
            for (const ptr of await this.approxIndex.ptrEntitiesOfFunction(node.item)) {
                this.addPointerNeighbor(node, ptr, 'in');
                changed = true;
            }
        }
        return changed;
    }

    private async addApproxCallees(node: NodeModel): Promise<boolean> {
        let changed = false;
        if (node.kind === 'pointer' && node.ptrKey) {
            for (const hit of await this.approxIndex.ptrCalleesOfPointer(node.ptrKey)) {
                this.addFunctionNeighbor(node, hit.item, 'out', hit.badge, true);
                changed = true;
            }
            return changed;
        }
        if (node.item) {
            for (const hit of await this.approxIndex.macroCallees(node.item)) {
                this.addFunctionNeighbor(node, hit.item, 'out', hit.badge);
                changed = true;
            }
            // 本函数体内调用的函数指针 → 指针节点（形成 本函数 -> 指针）
            for (const ptr of await this.approxIndex.ptrCallsInFunction(node.item)) {
                this.addPointerNeighbor(node, ptr, 'out');
                changed = true;
            }
        }
        return changed;
    }

    /** 加入函数邻居并连边 */
    private addFunctionNeighbor(
        node: NodeModel,
        item: vscode.CallHierarchyItem,
        direction: 'in' | 'out',
        badge: string = '',
        approx: boolean = badge !== ''
    ): void {
        const key = nodeKey(item);
        if (!this.nodes.has(key)) {
            this.nodes.set(key, {
                key,
                kind: 'function',
                item,
                name: item.name,
                detail: detailOf(item),
                column: node.column + (direction === 'in' ? -1 : 1),
                expanded: false,
                loading: false,
                isRoot: false,
                badge,
                neighbors: new Set<string>()
            });
        }
        node.neighbors.add(key);
        this.link(node, key, direction, approx);
    }

    /** 加入函数指针邻居并连边 */
    private addPointerNeighbor(node: NodeModel, ptr: PtrHit, direction: 'in' | 'out'): void {
        const key = 'ptr:' + ptr.ptrKey;
        if (!this.nodes.has(key)) {
            this.nodes.set(key, {
                key,
                kind: 'pointer',
                ptrKey: ptr.ptrKey,
                ptrLocation: ptr.location,
                name: ptr.label,
                detail: '函数指针',
                column: node.column + (direction === 'in' ? -1 : 1),
                expanded: false,
                loading: false,
                isRoot: false,
                badge: '',
                neighbors: new Set<string>()
            });
        }
        node.neighbors.add(key);
        this.link(node, key, direction, true);
    }

    /** 连边：from 调用 to */
    private link(node: NodeModel, neighborKey: string, direction: 'in' | 'out', approx: boolean): void {
        const from = direction === 'in' ? neighborKey : node.key;
        const to = direction === 'in' ? node.key : neighborKey;
        const edgeKey = `${from} -> ${to}`;
        if (!this.edges.has(edgeKey)) {
            this.edges.set(edgeKey, { from, to, approx });
        }
    }

    /** 仅保留从根出发、经由已展开节点可达的节点与边 */
    private computeVisible(): { nodes: NodeDTO[]; edges: EdgeModel[] } {
        if (!this.rootKey || !this.nodes.has(this.rootKey)) {
            return { nodes: [], edges: [] };
        }
        const visible = new Set<string>();
        const queue: string[] = [this.rootKey];
        visible.add(this.rootKey);
        while (queue.length > 0) {
            const key = queue.shift() as string;
            const node = this.nodes.get(key);
            if (!node || !node.expanded) {
                continue;
            }
            for (const neighbor of node.neighbors) {
                if (!visible.has(neighbor) && this.nodes.has(neighbor)) {
                    visible.add(neighbor);
                    queue.push(neighbor);
                }
            }
        }
        const nodes: NodeDTO[] = [];
        for (const key of visible) {
            const n = this.nodes.get(key);
            if (n) {
                nodes.push({
                    key: n.key,
                    kind: n.kind,
                    name: n.name,
                    detail: n.detail,
                    column: n.column,
                    expanded: n.expanded,
                    loading: n.loading,
                    isRoot: n.isRoot,
                    possible: n.kind === 'pointer' || n.badge !== '',
                    badge: n.badge
                });
            }
        }
        const edges = Array.from(this.edges.values()).filter(
            e => visible.has(e.from) && visible.has(e.to)
        );
        return { nodes, edges };
    }

    private postGraph(): void {
        const visible = this.computeVisible();
        this.lastGraph = {
            rootKey: this.rootKey,
            nodes: visible.nodes,
            edges: visible.edges
        };
        if (this.ready && this.view) {
            void this.view.webview.postMessage({ type: 'graph', data: this.lastGraph });
        }
    }

    /** 收起某节点（其子节点中不再被其它已展开节点引用的部分会被裁剪） */
    private collapseNode(key: string): void {
        const node = this.nodes.get(key);
        if (node) {
            node.expanded = false;
            this.postGraph();
        }
    }

    private async onMessage(msg: unknown): Promise<void> {
        if (!msg || typeof msg !== 'object') {
            return;
        }
        const message = msg as { type?: string; key?: string };
        switch (message.type) {
            case 'ready':
                this.ready = true;
                if (this.lastGraph && this.view) {
                    void this.view.webview.postMessage({ type: 'graph', data: this.lastGraph });
                }
                break;
            case 'expand':
                if (message.key) {
                    await this.expandNode(message.key);
                }
                break;
            case 'toggle':
                if (message.key) {
                    const node = this.nodes.get(message.key);
                    if (node) {
                        if (node.expanded) {
                            this.collapseNode(message.key);
                        } else {
                            await this.expandNode(message.key);
                        }
                    }
                }
                break;
            case 'open': {
                const node = this.nodes.get(message.key ?? '');
                if (!node) {
                    break;
                }
                if (node.kind === 'pointer') {
                    if (node.ptrLocation) {
                        await gotoLocation(node.ptrLocation.uri, node.ptrLocation.position);
                    }
                } else if (node.item) {
                    await gotoDefinition(node.item);
                }
                break;
            }
            case 'recenter': {
                const node = this.nodes.get(message.key ?? '');
                if (!node) {
                    break;
                }
                if (this.current) {
                    this.history.push(this.current);
                }
                if (node.kind === 'pointer' && node.ptrKey) {
                    await this.resetToPointer({
                        ptrKey: node.ptrKey,
                        label: node.name,
                        location: node.ptrLocation
                    });
                } else if (node.item) {
                    this.current = node.item;
                    await this.resetTo(node.item);
                }
                break;
            }
            case 'back': {
                const prev = this.history.pop();
                if (prev) {
                    this.current = prev;
                    await this.resetTo(prev);
                }
                break;
            }
            default:
                break;
        }
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css')
        );
        const csp = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} data:`,
            `style-src ${webview.cspSource}`,
            `script-src 'nonce-${nonce}'`
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link href="${styleUri}" rel="stylesheet">
<title>C 函数调用链</title>
</head>
<body>
<div id="toolbar">
  <button id="back" title="返回上一中心函数">← 返回</button>
  <button id="center" title="将当前中心函数移回视野中央">居中</button>
  <button id="zoomOut" title="缩小">－</button>
  <button id="zoomIn" title="放大">＋</button>
  <span id="hint">单击跳转 · 点 + 向外展开 · 双击居中 · 滚轮滚动 / Shift+滚轮左右 / 拖拽平移</span>
</div>
<div id="canvas">
  <svg id="svg" xmlns="http://www.w3.org/2000/svg"><g id="viewport"></g></svg>
  <div class="empty" id="empty">右键 C 函数 → “显示函数调用链”</div>
</div>
<div id="hscroll"><div id="hthumb"></div></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

/** 函数唯一键：文件 + 函数名起始位置 + 名称 */
function nodeKey(item: vscode.CallHierarchyItem): string {
    const start = item.selectionRange.start;
    return `${item.uri.toString()}#${start.line}:${start.character}:${item.name}`;
}

/** 节点副标题：相对路径:行号（仅用于提示，不在框图中显示） */
function detailOf(item: vscode.CallHierarchyItem): string {
    const rel = vscode.workspace.asRelativePath(item.uri, false);
    return `${rel}:${item.selectionRange.start.line + 1}`;
}

/** 生成一次性随机 nonce，用于 CSP */
function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
