import * as vscode from 'vscode';
import {
    Engine,
    enclosingSymbolPosition,
    gotoDefinition,
    log,
    logExtensionState,
    outputChannel,
    prepareAny
} from './callHierarchy';
import { CallChainGraphProvider } from './graphView';

/* -------------------------------------------------------------------------- */
/*                                  命令实现                                   */
/* -------------------------------------------------------------------------- */

/**
 * 命令：显示函数调用链。
 * 用 VS Code 内置 Call Hierarchy API 获取光标所在函数，然后在图形面板中展示。
 */
async function showCallChain(graph: CallChainGraphProvider): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('请先打开一个 C 文件并将光标放在函数上。');
        return;
    }

    const document = editor.document;
    const position = editor.selection.active;

    log('----------------------------------------');
    log(`文档: ${document.uri.toString()}`);
    log(`languageId: ${document.languageId}`);
    log(`光标: line ${position.line}, char ${position.character}`);
    const wordAtCursor = document.getWordRangeAtPosition(position);
    log(`光标处单词: ${wordAtCursor ? document.getText(wordAtCursor) : '(无)'}`);
    logExtensionState();

    // 收集候选位置：cpptools 对 C 文件在「符号末尾」会查不到（issue #11338），
    // 因此依次尝试光标处、单词起始、单词内部、以及所在符号的 selectionRange。
    const candidates: Array<{ pos: vscode.Position; label: string }> = [];
    const seen = new Set<string>();
    const pushCandidate = (pos: vscode.Position | undefined, label: string) => {
        if (!pos) {
            return;
        }
        const key = `${pos.line}:${pos.character}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        candidates.push({ pos, label });
    };

    pushCandidate(position, '光标位置');
    if (wordAtCursor) {
        pushCandidate(wordAtCursor.start, '单词起始');
        pushCandidate(wordAtCursor.start.translate(0, 1), '单词内部');
    }
    pushCandidate(await enclosingSymbolPosition(document, position), '所在符号 selectionRange');

    // 语言服务器可能尚未解析完成，做若干次延迟重试
    let prepared: { items: vscode.CallHierarchyItem[]; engine: Engine } | undefined;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts && !prepared; attempt++) {
        if (attempt > 1) {
            log(`第 ${attempt} 次尝试（等待语言服务器解析）...`);
            await delay(800);
        }
        for (const candidate of candidates) {
            prepared = await tryPrepareAt(document.uri, candidate.pos, candidate.label);
            if (prepared) {
                break;
            }
        }
    }

    if (!prepared) {
        log('所有候选位置均未返回 CallHierarchyItem，判定为无可用 provider 或未解析完成。');
        const choice = await vscode.window.showWarningMessage(
            '未找到可分析的函数。可能原因：\n' +
            '1) 语言服务器尚未解析完成（稍等片刻后重试）；\n' +
            '2) 未安装/未启用支持 Call Hierarchy 的 C/C++ 扩展（C/C++ 或 clangd）；\n' +
            '3) 该文件未被语言服务器纳入分析（可尝试在项目根目录添加 compile_commands.json）。',
            '查看输出日志'
        );
        if (choice === '查看输出日志') {
            outputChannel.show(true);
        }
        return;
    }

    log(`选用根节点: ${prepared.items[0].name} @ ${prepared.items[0].uri.toString()}（引擎: ${prepared.engine}）`);
    await graph.show(prepared.items[0], prepared.engine);
}

/** 在指定位置尝试准备调用层次，并记录日志 */
async function tryPrepareAt(
    uri: vscode.Uri,
    position: vscode.Position,
    label: string
): Promise<{ items: vscode.CallHierarchyItem[]; engine: Engine } | undefined> {
    try {
        const prepared = await prepareAny(uri, position);
        log(`prepare @ ${label} (line ${position.line}, char ${position.character}) -> ` +
            (prepared ? `${prepared.items.length} 个（${prepared.engine}）` : '0 个'));
        return prepared;
    } catch (err) {
        log(`prepare @ ${label} 抛错: ${String(err)}`);
        return undefined;
    }
}

/** 延时 */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/*                                  激活/停用                                  */
/* -------------------------------------------------------------------------- */

export function activate(context: vscode.ExtensionContext): void {
    const graph = new CallChainGraphProvider(context.extensionUri);

    context.subscriptions.push(
        outputChannel,
        vscode.window.registerWebviewViewProvider(CallChainGraphProvider.viewType, graph, {
            webviewOptions: { retainContextWhenHidden: true }
        }),
        vscode.commands.registerCommand('cCallChain.showCallChain', () => showCallChain(graph)),
        vscode.commands.registerCommand('cCallChain.gotoDefinition', (item: vscode.CallHierarchyItem) =>
            gotoDefinition(item)
        )
    );
}

export function deactivate(): void {
    // 无需清理
}
