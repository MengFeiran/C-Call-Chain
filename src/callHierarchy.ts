import * as vscode from 'vscode';

/**
 * 数据来源引擎：
 * - builtin  ：VS Code 通用 Call Hierarchy 命令（vscode.prepareCallHierarchy 等）
 * - cpptools ：微软 C/C++ 扩展专有命令（C_Cpp.PrepareCallHierarchy 等）兜底
 */
export type Engine = 'builtin' | 'cpptools';

/** 输出通道：用于打印诊断信息（查看方式：输出面板选择「C Call Chain」） */
export const outputChannel = vscode.window.createOutputChannel('C Call Chain');

/** 向输出通道写一行日志 */
export function log(message: string): void {
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

/** 延时 */
export function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** 打印已安装 C/C++ 语言扩展的存在与激活状态，用于诊断 */
export function logExtensionState(): void {
    const ids = [
        'ms-vscode.cpptools',
        'llvm-vs-code-extensions.vscode-clangd',
        'jeff-hykin.better-cpp-syntax'
    ];
    for (const id of ids) {
        const ext = vscode.extensions.getExtension(id);
        if (!ext) {
            log(`扩展 ${id}: 未安装`);
        } else {
            log(`扩展 ${id}: 已安装，${ext.isActive ? '已激活' : '未激活'}`);
        }
    }
}

/**
 * 通过 VS Code 内置命令调用 Call Hierarchy。
 *
 * 重要：VS Code 并未导出 `vscode.prepareCallHierarchy` 之类的命名空间函数，
 * 而是以「内置命令」形式提供（见 VS Code 源码 extHostApiCommands.ts）。
 * 命令 ID 分别是：
 *   - vscode.prepareCallHierarchy
 *   - vscode.provideIncomingCalls
 *   - vscode.provideOutgoingCalls
 */
async function prepareCallHierarchy(
    uri: vscode.Uri,
    position: vscode.Position
): Promise<vscode.CallHierarchyItem[] | undefined> {
    return vscode.commands.executeCommand<vscode.CallHierarchyItem[] | undefined>(
        'vscode.prepareCallHierarchy',
        uri,
        position
    );
}

/**
 * 依次尝试「通用内置 provider」与「cpptools 专有命令」准备调用层次。
 * 返回命中的引擎，供后续 incoming/outgoing 查询使用同一引擎。
 */
export async function prepareAny(
    uri: vscode.Uri,
    position: vscode.Position
): Promise<{ items: vscode.CallHierarchyItem[]; engine: Engine } | undefined> {
    // 1) 通用内置 provider
    try {
        const items = await prepareCallHierarchy(uri, position);
        if (items && items.length > 0) {
            return { items, engine: 'builtin' };
        }
    } catch (err) {
        log(`内置 prepare 抛错: ${String(err)}`);
    }

    // 2) cpptools 专有命令兜底
    if (vscode.extensions.getExtension('ms-vscode.cpptools')) {
        try {
            const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[] | undefined>(
                'C_Cpp.PrepareCallHierarchy',
                uri,
                position
            );
            if (items && items.length > 0) {
                return { items, engine: 'cpptools' };
            }
        } catch (err) {
            log(`C_Cpp.PrepareCallHierarchy 抛错: ${String(err)}`);
        }
    }

    return undefined;
}

/** 获取某函数的调用者（callers） */
export async function provideIncomingCalls(
    item: vscode.CallHierarchyItem,
    engine: Engine
): Promise<vscode.CallHierarchyIncomingCall[]> {
    const commandId = engine === 'cpptools' ? 'C_Cpp.CallHierarchyCallsTo' : 'vscode.provideIncomingCalls';
    const result = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[] | undefined>(
        commandId,
        item
    );
    return result ?? [];
}

/** 获取某函数调用的函数（callees） */
export async function provideOutgoingCalls(
    item: vscode.CallHierarchyItem,
    engine: Engine
): Promise<vscode.CallHierarchyOutgoingCall[]> {
    const commandId = engine === 'cpptools' ? 'C_Cpp.CallHierarchyCallsFrom' : 'vscode.provideOutgoingCalls';
    const result = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[] | undefined>(
        commandId,
        item
    );
    return result ?? [];
}

/**
 * 跳转到函数定义。
 * CallHierarchyItem 自带 uri 与 selectionRange（函数名范围），直接复用。
 */
export async function gotoDefinition(item: vscode.CallHierarchyItem): Promise<void> {
    if (!item) {
        return;
    }
    const document = await vscode.workspace.openTextDocument(item.uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });

    // selectionRange 指向函数名，优先使用；缺失时退回整个 range
    const range = item.selectionRange ?? item.range;

    // 光标定位到函数名所在行
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** 跳转到指定文件的某个位置（用于函数指针节点的声明/赋值处） */
export async function gotoLocation(uri: vscode.Uri, position: vscode.Position): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport
    );
}

/** 查找包含指定位置的最内层文档符号 */
function findSymbolAt(
    symbols: vscode.DocumentSymbol[] | undefined,
    position: vscode.Position
): vscode.DocumentSymbol | undefined {
    if (!symbols) {
        return undefined;
    }
    for (const symbol of symbols) {
        if (symbol.range.contains(position)) {
            return findSymbolAt(symbol.children, position) ?? symbol;
        }
    }
    return undefined;
}

/** 用文档符号提供者找到光标所在符号，返回其 selectionRange 起始位置（异步兜底） */
export async function enclosingSymbolPosition(
    document: vscode.TextDocument,
    position: vscode.Position
): Promise<vscode.Position | undefined> {
    try {
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            document.uri
        );
        return findSymbolAt(symbols, position)?.selectionRange.start;
    } catch {
        return undefined;
    }
}
