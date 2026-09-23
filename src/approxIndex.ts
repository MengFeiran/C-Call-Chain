import * as vscode from 'vscode';
import { log, prepareAny } from './callHierarchy';

/** 一个函数式宏的定义 */
interface MacroDef {
    name: string;
    params: string[];
    body: string;
}

/** 函数定义位置 */
interface LocationRef {
    uri: vscode.Uri;
    position: vscode.Position;
}

/** 宏调用 */
interface Invocation {
    name: string;
    args: string[];
    start: number;
    end: number;
}

/** 从文本中解析出的函数体 */
interface FuncBody {
    name: string;
    nameOffset: number;
    bodyStart: number;
    bodyEnd: number;
}

/** 函数节点命中（用于宏近似） */
export interface ApproxHit {
    item: vscode.CallHierarchyItem;
    badge: string;
}

/** 函数指针节点命中 */
export interface PtrHit {
    /** 指针唯一键，例如 "B.func_ptr_a" 或 "local:<函数键>:p" */
    ptrKey: string;
    /** 展示名，例如 "B.func_ptr_a" */
    label: string;
    /** 声明/赋值位置（用于跳转），可能为空 */
    location?: LocationRef;
}

// 注意：函数式宏要求 ( 紧贴宏名；中间有空格属于对象式宏（宏体以 ( 开头）
const MACRO_DEFINE_RE = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)\(([^)]*)\)[ \t]*(.*)$/;
const FUNC_DEF_RE = /([A-Za-z_][\w\s\*]*?)\b([A-Za-z_]\w*)\s*\(([^;{}()]*)\)\s*\{/g;
const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'sizeof', 'return', 'do', 'else']);
const C_KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'return', 'sizeof', 'do', 'else',
    'case', 'default', 'typeof', 'defined', 'goto', 'break', 'continue',
    'void', 'int', 'char', 'short', 'long', 'float', 'double', 'unsigned',
    'signed', 'const', 'static', 'inline', 'struct', 'union', 'enum'
]);
const MAX_FILE_BYTES = 512 * 1024;
const READ_CONCURRENCY = 32;
const MAX_RESULTS = 200;

/**
 * 近似索引：后台扫描工作区 C/H 文件，提供内置 Call Hierarchy 可能缺失的两类关系：
 *
 * 1) 函数式宏：展开宏体后补全经由宏的调用（标记「宏」）。
 * 2) 函数指针：把函数指针表达式当作独立节点，建立
 *      指针 --(被赋值)--> 函数
 *      调用者函数 --(调用指针)--> 指针
 *    从而可以：func 的调用者里出现 `B.func_ptr_a`；展开 `B.func_ptr_a` 时看到调用它的函数。
 *    调用点与注册点变量名不同时（如 `l2_bit_heap_ops.free` 与 `heap->ops->free`），
 *    按「同族变量」模糊回退：成员名相同，且变量名互为前缀/后缀（如 `heap.ops` 与
 *    `l2_bit_heap_ops` 共享后缀 `ops`），避免把仅成员名相同的无关结构（如 libevent 的
 *    `evthread_lock_fns_.free`）混入。
 *
 * 完全基于文本解析，后台异步构建，不调用语言服务器。
 */
export class ApproxIndex {
    private readonly _onReady = new vscode.EventEmitter<void>();
    readonly onReady = this._onReady.event;

    // ---- 宏 ----
    private readonly macros = new Map<string, MacroDef>();
    private readonly macroOutgoing = new Map<string, Set<string>>();
    private readonly macroIncoming = new Map<string, Set<string>>();

    // ---- 通用 ----
    private readonly locations = new Map<string, LocationRef>();
    private readonly nameLocations = new Map<string, LocationRef[]>();
    private readonly itemCache = new Map<string, vscode.CallHierarchyItem | undefined>();

    // ---- 函数指针 ----
    /** 函数名 -> 它被赋值到的指针键集合 */
    private readonly funcToPtrs = new Map<string, Set<string>>();
    /** 指针键 -> 赋值给它的函数名集合 */
    private readonly ptrToFuncs = new Map<string, Set<string>>();
    /** 指针完整表达式 -> 调用它的函数键集合（精确匹配） */
    private readonly ptrCallersByExpr = new Map<string, Set<string>>();
    /** 成员名 -> 使用该成员名的指针表达式集合（含调用点与注册点，用于同族模糊回退） */
    private readonly memberExprs = new Map<string, Set<string>>();
    /** 函数键 -> 它调用的指针键集合 */
    private readonly funcPtrCalls = new Map<string, Set<string>>();
    /** 指针键 -> 声明/赋值位置 */
    private readonly ptrLocations = new Map<string, LocationRef>();
    /** 指针键 -> 展示名 */
    private readonly ptrLabels = new Map<string, string>();
    /** 所有已声明的函数指针变量名（(*name)(...) 形式），用于识别普通指针变量 */
    private readonly ptrDeclNames = new Set<string>();

    private building = false;
    private built = false;
    private macroEnabled = true;
    private fnPtrEnabled = true;
    /** 同族模糊回退合并的指针表达式数量上限，超过视为过于通用，仅保留精确匹配 */
    private relatedExprLimit = 20;

    /** 启动后台构建（非阻塞，可重复调用） */
    ensureBuilt(): void {
        if (this.built || this.building) {
            return;
        }
        const config = vscode.workspace.getConfiguration('cCallChain');
        this.macroEnabled = config.get<boolean>('enableMacroIndex', true);
        this.fnPtrEnabled = config.get<boolean>('enableFnPtrIndex', true);
        this.relatedExprLimit = config.get<number>('fnPtrMemberThreshold', 20);
        if (!this.macroEnabled && !this.fnPtrEnabled) {
            this.built = true;
            return;
        }
        this.building = true;
        void vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'C 调用链：正在后台建立近似索引（不影响查看调用链）',
                cancellable: true
            },
            (progress, token) => this.build(progress, token)
        ).then(() => {
            this.building = false;
            this.built = true;
            log(`近似索引就绪: ${this.macros.size} 个宏, ${this.ptrLabels.size} 个函数指针`);
            this._onReady.fire();
        });
    }

    /* ---------------------------------------------------------------------- */
    /*                                 宏近似                                  */
    /* ---------------------------------------------------------------------- */

    async macroCallees(item: vscode.CallHierarchyItem): Promise<ApproxHit[]> {
        if (!this.ensureReady() || !this.macroEnabled) {
            return [];
        }
        return this.resolveNames(this.macroOutgoing.get(keyOf(item)), '宏');
    }

    async macroCallers(item: vscode.CallHierarchyItem): Promise<ApproxHit[]> {
        if (!this.ensureReady() || !this.macroEnabled) {
            return [];
        }
        return this.resolveKeys(this.macroIncoming.get(baseName(item.name)), '宏');
    }

    /* ---------------------------------------------------------------------- */
    /*                              函数指针节点                               */
    /* ---------------------------------------------------------------------- */

    /** 本函数被赋值到的函数指针节点（用于「调用者」方向） */
    async ptrEntitiesOfFunction(item: vscode.CallHierarchyItem): Promise<PtrHit[]> {
        if (!this.ensureReady() || !this.fnPtrEnabled) {
            return [];
        }
        return this.ptrHits(this.funcToPtrs.get(baseName(item.name)));
    }

    /** 本函数体内调用的函数指针节点（用于「被调用者」方向） */
    async ptrCallsInFunction(item: vscode.CallHierarchyItem): Promise<PtrHit[]> {
        if (!this.ensureReady() || !this.fnPtrEnabled) {
            return [];
        }
        return this.ptrHits(this.funcPtrCalls.get(keyOf(item)));
    }

    /** 调用某函数指针的函数（展开指针节点的「调用者」） */
    async ptrCallersOfPointer(ptrKey: string): Promise<ApproxHit[]> {
        if (!this.ensureReady() || !this.fnPtrEnabled) {
            return [];
        }
        // 精确匹配 + 同族回退：只合并变量名与本指针相关的表达式，
        // 避免仅成员名相同的无关结构（如 libevent 的 evthread_lock_fns_.free）被混入
        const keys = new Set<string>();
        for (const expr of this.relatedExprs(ptrKey)) {
            for (const k of this.ptrCallersByExpr.get(expr) ?? []) {
                keys.add(k);
            }
        }
        return this.resolveKeys(keys, '');
    }

    /** 被赋值给某函数指针的函数（展开指针节点的「被调用者」） */
    async ptrCalleesOfPointer(ptrKey: string): Promise<ApproxHit[]> {
        if (!this.ensureReady() || !this.fnPtrEnabled) {
            return [];
        }
        // 精确匹配 + 同族回退（规则见 relatedExprs）
        const names = new Set<string>();
        for (const expr of this.relatedExprs(ptrKey)) {
            for (const n of this.ptrToFuncs.get(expr) ?? []) {
                names.add(n);
            }
        }
        return this.resolveNames(names, '');
    }

    /**
     * 与 ptrKey 同「变量族」的指针表达式（含自身）：成员名相同，且变量名与
     * ptrKey 的变量名互为前缀/后缀（如 l2_bit_heap_ops 与 heap.ops 共享后缀 ops，
     * 与 bit_heap_ops 互为前缀/后缀）。数量超过上限时视为过于通用，仅保留精确匹配。
     */
    private relatedExprs(ptrKey: string): string[] {
        const member = memberName(ptrKey);
        const related: string[] = [];
        for (const expr of this.memberExprs.get(member) ?? []) {
            if (!isSameFamily(expr, ptrKey)) {
                continue;
            }
            related.push(expr);
            if (related.length > this.relatedExprLimit) {
                return [ptrKey];
            }
        }
        if (!related.includes(ptrKey)) {
            related.push(ptrKey);
        }
        return related;
    }

    private ptrHits(keys: Set<string> | undefined): PtrHit[] {
        if (!keys || keys.size === 0) {
            return [];
        }
        const result: PtrHit[] = [];
        for (const ptrKey of keys) {
            result.push({
                ptrKey,
                label: this.ptrLabels.get(ptrKey) ?? ptrKey,
                location: this.ptrLocations.get(ptrKey)
            });
            if (result.length >= MAX_RESULTS) {
                break;
            }
        }
        return result;
    }

    /* ---------------------------------------------------------------------- */
    /*                                 辅助                                    */
    /* ---------------------------------------------------------------------- */

    private ensureReady(): boolean {
        if (!this.built) {
            this.ensureBuilt();
            return false;
        }
        return true;
    }

    private async resolveNames(names: Set<string> | undefined, badge: string): Promise<ApproxHit[]> {
        if (!names || names.size === 0) {
            return [];
        }
        const result: ApproxHit[] = [];
        for (const name of names) {
            const refs = this.nameLocations.get(name) ?? [];
            const ref = refs.find(r => r.uri.fsPath.toLowerCase().endsWith('.c')) ?? refs[0];
            if (!ref) {
                continue;
            }
            const resolved = await this.resolveAt(ref);
            if (resolved) {
                result.push({ item: resolved, badge });
            }
            if (result.length >= MAX_RESULTS) {
                break;
            }
        }
        return result;
    }

    private async resolveKeys(keys: Set<string> | undefined, badge: string): Promise<ApproxHit[]> {
        if (!keys || keys.size === 0) {
            return [];
        }
        const result: ApproxHit[] = [];
        for (const key of keys) {
            const ref = this.locations.get(key);
            if (!ref) {
                continue;
            }
            const resolved = await this.resolveAt(ref);
            if (resolved) {
                result.push({ item: resolved, badge });
            }
            if (result.length >= MAX_RESULTS) {
                break;
            }
        }
        return result;
    }

    private async resolveAt(ref: LocationRef): Promise<vscode.CallHierarchyItem | undefined> {
        const cacheKey = `${ref.uri.toString()}#${ref.position.line}:${ref.position.character}`;
        if (this.itemCache.has(cacheKey)) {
            return this.itemCache.get(cacheKey);
        }
        let item: vscode.CallHierarchyItem | undefined;
        try {
            const prepared = await prepareAny(ref.uri, ref.position);
            item = prepared?.items[0];
        } catch {
            item = undefined;
        }
        this.itemCache.set(cacheKey, item);
        return item;
    }

    /* ---------------------------------------------------------------------- */
    /*                                 构建索引                                */
    /* ---------------------------------------------------------------------- */

    private async build(progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('cCallChain');
            const maxFiles = config.get<number>('macroIndexMaxFiles', 2000);

            const files = await vscode.workspace.findFiles('**/*.{c,h}', '**/node_modules/**', maxFiles);
            progress.report({ message: `读取 ${files.length} 个文件…` });

            const entries: Array<{ uri: vscode.Uri; text: string }> = [];
            let done = 0;
            await mapLimit(files, READ_CONCURRENCY, async uri => {
                const text = await readText(uri);
                if (text !== undefined) {
                    entries.push({ uri, text });
                }
                done++;
                if (done % 200 === 0) {
                    progress.report({ message: `读取文件 ${done}/${files.length}…` });
                }
            });

            if (token.isCancellationRequested) {
                return;
            }

            // 第一遍：宏定义（用原始文本，宏体可能含字符串/注释）
            for (const entry of entries) {
                try {
                    this.parseMacros(entry.text);
                } catch (err) {
                    log(`解析宏失败 ${entry.uri.toString()}: ${String(err)}`);
                }
            }

            // 之后统一用「去注释/字符串」的文本做结构分析
            for (const entry of entries) {
                entry.text = sanitizeC(entry.text);
            }

            // 收集所有函数指针变量声明名（(*name)(...) 形式，含全局与局部）
            for (const entry of entries) {
                this.collectPointerDecls(entry.text);
            }

            // 第二遍：函数体（宏调用、函数指针调用）
            let index = 0;
            for (const entry of entries) {
                if (token.isCancellationRequested) {
                    return;
                }
                try {
                    this.indexFunctions(entry.uri, entry.text);
                } catch (err) {
                    log(`分析函数失败 ${entry.uri.toString()}: ${String(err)}`);
                }
                index++;
                if (index % 200 === 0) {
                    progress.report({ message: `分析函数 ${index}/${entries.length}…` });
                }
            }

            // 第三遍：文件作用域的「成员函数指针赋值」（需要已知函数名做过滤）
            for (const entry of entries) {
                if (token.isCancellationRequested) {
                    return;
                }
                try {
                    this.indexMemberAssignments(entry.uri, entry.text);
                } catch (err) {
                    log(`分析函数指针赋值失败 ${entry.uri.toString()}: ${String(err)}`);
                }
            }

            const sample: string[] = [];
            for (const [func, ptrs] of this.funcToPtrs) {
                if (sample.length >= 5) {
                    break;
                }
                sample.push(`${func} <- {${Array.from(ptrs).join(', ')}}`);
            }
            log(`近似索引统计: 文件 ${entries.length}, 宏 ${this.macros.size}, ` +
                `函数指针声明 ${this.ptrDeclNames.size}, 指针表达式 ${this.ptrLabels.size}, ` +
                `函数->指针 ${this.funcToPtrs.size}, 指针->函数 ${this.ptrToFuncs.size}, ` +
                `指针调用点函数 ${this.ptrCallersByExpr.size}`);
            log(`函数->指针示例: ${sample.length ? sample.join('; ') : '(空)'}`);
        } catch (err) {
            log(`近似索引构建失败: ${String(err)}`);
        }
    }

    private parseMacros(text: string): void {
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const m = MACRO_DEFINE_RE.exec(lines[i]);
            if (!m) {
                continue;
            }
            let body = m[3];
            let j = i;
            while (body.endsWith('\\') && j + 1 < lines.length) {
                body = body.slice(0, -1);
                j++;
                body += lines[j];
            }
            const params = m[2].trim() === ''
                ? []
                : m[2].split(',').map(s => s.trim()).filter(Boolean);
            this.macros.set(m[1], { name: m[1], params, body });
            i = j;
        }
    }

    /** 分析函数：记录函数位置、宏调用、函数指针调用、局部函数指针 */
    private indexFunctions(uri: vscode.Uri, sanitized: string): void {
        const lineStarts = computeLineStarts(sanitized);

        for (const fn of findFunctionBodies(sanitized)) {
            if (this.macros.has(fn.name)) {
                continue;
            }
            const position = positionAt(lineStarts, fn.nameOffset);
            const key = keyFor(uri, fn.name);

            const list = this.nameLocations.get(fn.name) ?? [];
            list.push({ uri, position });
            this.nameLocations.set(fn.name, list);
            this.locations.set(key, { uri, position });

            const body = sanitized.slice(fn.bodyStart, fn.bodyEnd + 1);

            // 宏近似
            if (this.macroEnabled) {
                const callees = this.macroCalleesInText(body);
                if (callees.size > 0) {
                    for (const callee of callees) {
                        addToSet(this.macroOutgoing, key, callee);
                        addToSet(this.macroIncoming, callee, key);
                    }
                }
            }

            // 函数指针近似
            if (this.fnPtrEnabled) {
                this.indexPointerUsageInFunction(key, body);
            }
        }
    }

    /** 收集所有函数指针变量声明名：(*name)(...) */
    private collectPointerDecls(text: string): void {
        const re = /\(\s*\*\s*([A-Za-z_]\w*)\s*\)\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            this.ptrDeclNames.add(m[1]);
        }
    }

    /** 在函数体内索引函数指针用法 */
    private indexPointerUsageInFunction(funcKey: string, body: string): void {
        let m: RegExpExecArray | null;

        // 1) 成员访问指针调用： B.func_ptr_a(...) / B->func_ptr_a(...)
        const memberCallRe = /([A-Za-z_]\w*(?:\s*(?:\.|->)\s*[A-Za-z_]\w*)+)\s*\(/g;
        while ((m = memberCallRe.exec(body)) !== null) {
            const ptrKey = normalizePtrExpr(m[1]);
            this.registerPtr(ptrKey, ptrKey);
            addToSet(this.ptrCallersByExpr, ptrKey, funcKey);
            addToSet(this.funcPtrCalls, funcKey, ptrKey);
            // 调用点也纳入同族集合，供注册节点反向查找调用者
            addToSet(this.memberExprs, memberName(ptrKey), ptrKey);
        }

        // 2) 普通函数指针变量调用： name(...)（name 已在任意位置声明为函数指针）
        const plainCallRe = /\b([A-Za-z_]\w*)\s*\(/g;
        while ((m = plainCallRe.exec(body)) !== null) {
            const name = m[1];
            if (!this.ptrDeclNames.has(name)) {
                continue;
            }
            this.registerPtr(name, name);
            addToSet(this.ptrCallersByExpr, name, funcKey);
            addToSet(this.funcPtrCalls, funcKey, name);
            addToSet(this.memberExprs, name, name);
        }
    }

    /**
     * 索引函数指针的「注册」位置（扫描整个文件，不限于函数体内）：
     * 1) 成员赋值：   B.func_ptr_a = func_a;
     * 2) 普通指针赋值：g_cb = func_a;（g_cb 已声明为函数指针）
     * 3) 指定初始化器：ops_t B = { .func_ptr_a = func_a, ... };
     */
    private indexMemberAssignments(uri: vscode.Uri, sanitized: string): void {
        const lineStarts = computeLineStarts(sanitized);
        let m: RegExpExecArray | null;

        // 1) 成员赋值
        const memberAssignRe = /([A-Za-z_]\w*(?:\s*(?:\.|->)\s*[A-Za-z_]\w*)+)\s*=\s*&?\s*([A-Za-z_]\w*)\s*;/g;
        while ((m = memberAssignRe.exec(sanitized)) !== null) {
            const ptrKey = normalizePtrExpr(m[1]);
            this.recordPtrTarget(ptrKey, ptrKey, m[2], uri, positionAt(lineStarts, m.index));
        }

        // 2) 普通函数指针变量赋值
        const plainAssignRe = /\b([A-Za-z_]\w*)\s*=\s*&?\s*([A-Za-z_]\w*)\s*;/g;
        while ((m = plainAssignRe.exec(sanitized)) !== null) {
            if (!this.ptrDeclNames.has(m[1])) {
                continue;
            }
            this.recordPtrTarget(m[1], m[1], m[2], uri, positionAt(lineStarts, m.index));
        }

        // 3) 指定初始化器：var = { .member = func, ... }
        const initRe = /([A-Za-z_]\w*)\s*=\s*\{([^{}]*)\}/g;
        while ((m = initRe.exec(sanitized)) !== null) {
            const varName = m[1];
            const body = m[2];
            const fieldRe = /\.\s*([A-Za-z_]\w*)\s*=\s*&?\s*([A-Za-z_]\w*)/g;
            let f: RegExpExecArray | null;
            while ((f = fieldRe.exec(body)) !== null) {
                const ptrKey = varName + '.' + f[1];
                this.recordPtrTarget(ptrKey, ptrKey, f[2], uri, positionAt(lineStarts, m.index));
            }
        }
    }

    /** 记录「指针 -> 函数」及反向关系；仅当目标为已知函数时登记，避免误判 */
    private recordPtrTarget(
        ptrKey: string,
        label: string,
        funcName: string,
        uri: vscode.Uri,
        position: vscode.Position
    ): void {
        if (!this.nameLocations.has(funcName)) {
            return;
        }
        this.registerPtr(ptrKey, label);
        addToSet(this.ptrToFuncs, ptrKey, funcName);
        addToSet(this.funcToPtrs, funcName, ptrKey);
        if (!this.ptrLocations.has(ptrKey)) {
            this.ptrLocations.set(ptrKey, { uri, position });
        }
    }

    /** 登记指针表达式：记录展示名，并按成员名归集（供同族模糊回退遍历） */
    private registerPtr(ptrKey: string, label: string): void {
        if (!this.ptrLabels.has(ptrKey)) {
            this.ptrLabels.set(ptrKey, label);
        }
        addToSet(this.memberExprs, memberName(ptrKey), ptrKey);
    }

    private macroCalleesInText(text: string): Set<string> {
        const result = new Set<string>();
        for (const inv of this.findInvocations(text)) {
            const def = this.macros.get(inv.name);
            if (!def) {
                continue;
            }
            let expanded = '';
            try {
                expanded = this.expand(def, inv.args, 0);
            } catch {
                continue; // 单个宏展开异常不影响其它
            }
            for (const name of extractCallNames(expanded)) {
                if (this.macros.has(name) || def.params.includes(name)) {
                    continue;
                }
                result.add(name);
            }
        }
        return result;
    }

    /* ---------------------------------------------------------------------- */
    /*                                 宏展开                                  */
    /* ---------------------------------------------------------------------- */

    private expand(def: MacroDef, args: string[], depth: number): string {
        if (depth > 8) {
            return '';
        }
        let body = def.body;
        def.params.forEach((param, index) => {
            body = replaceIdentifier(body, param, (args[index] ?? '').trim());
        });
        body = body.replace(/##/g, '');
        body = body.replace(/#\s*[A-Za-z_]\w*/g, '""');
        return this.expandNested(body, depth + 1);
    }

    private expandNested(text: string, depth: number): string {
        if (depth > 8) {
            return text;
        }
        const invocations = this.findInvocations(text);
        let result = text;
        for (let k = invocations.length - 1; k >= 0; k--) {
            const inv = invocations[k];
            const def = this.macros.get(inv.name);
            if (!def) {
                continue;
            }
            const expanded = this.expand(def, inv.args, depth + 1);
            result = result.slice(0, inv.start) + ' ' + expanded + ' ' + result.slice(inv.end);
        }
        return result;
    }

    private findInvocations(text: string): Invocation[] {
        const result: Invocation[] = [];
        const re = /([A-Za-z_]\w*)\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const name = m[1];
            if (!this.macros.has(name)) {
                continue;
            }
            const openParen = m.index + m[0].length - 1;
            const parsed = parseArgs(text, openParen);
            if (!parsed) {
                continue;
            }
            result.push({ name, args: parsed.args, start: m.index, end: parsed.end });
            re.lastIndex = parsed.end;
        }
        return result;
    }
}

/* -------------------------------------------------------------------------- */
/*                                  工具函数                                   */
/* -------------------------------------------------------------------------- */

/** 去掉函数名中的参数列表：cpptools 返回的 name 形如 "func_a(int x)" */
function baseName(name: string): string {
    const index = name.indexOf('(');
    return index >= 0 ? name.slice(0, index).trim() : name;
}

function keyOf(item: vscode.CallHierarchyItem): string {
    return keyFor(item.uri, baseName(item.name));
}

function keyFor(uri: vscode.Uri, name: string): string {
    return `${uri.toString()}#${name}`;
}

/** 规范化指针表达式：去空白，把 -> 统一为 . */
function normalizePtrExpr(s: string): string {
    return s.replace(/\s+/g, '').replace(/->/g, '.');
}

/** 指针的「可调用名」：成员名或变量名（去掉结构变量前缀） */
function memberName(ptrKey: string): string {
    const key = ptrKey.startsWith('ptr:') ? ptrKey.slice(4) : ptrKey;
    const dot = key.lastIndexOf('.');
    return dot >= 0 ? key.slice(dot + 1) : key;
}

/** 指针表达式的变量部分（最后一个成员之前）；普通变量即其本身 */
function varPartOf(expr: string): string {
    const dot = expr.lastIndexOf('.');
    return dot >= 0 ? expr.slice(0, dot) : expr;
}

/** 变量链的最后一个分量：heap.ops -> ops */
function lastComponentOf(v: string): string {
    const dot = v.lastIndexOf('.');
    return dot >= 0 ? v.slice(dot + 1) : v;
}

/** 较短者是较长者的前缀或后缀（较短者至少 3 个字符，避免过短片段误判） */
function hasAffinity(a: string, b: string): boolean {
    if (a === b) {
        return true;
    }
    const short = a.length <= b.length ? a : b;
    const long = a.length <= b.length ? b : a;
    if (short.length < 3) {
        return false;
    }
    return long.startsWith(short) || long.endsWith(short);
}

/**
 * 两个指针表达式是否同「变量族」：成员名相同，且变量名（或其最后一个分量）
 * 互为前缀/后缀。例如 l2_bit_heap_ops.free 与 heap.ops.free（共享后缀 ops）、
 * 与 bit_heap_ops.free（互为前缀/后缀）同族；与 evthread_lock_fns_.free 不同族。
 */
function isSameFamily(a: string, b: string): boolean {
    if (a === b) {
        return true;
    }
    if (memberName(a) !== memberName(b)) {
        return false;
    }
    const va = varPartOf(a);
    const vb = varPartOf(b);
    return hasAffinity(va, vb) || hasAffinity(lastComponentOf(va), lastComponentOf(vb));
}

function addToSet<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
    let set = map.get(key);
    if (!set) {
        set = new Set();
        map.set(key, set);
    }
    set.add(value);
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (open) {
        return open.getText();
    }
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.byteLength > MAX_FILE_BYTES) {
            return undefined;
        }
        return new TextDecoder('utf-8').decode(bytes);
    } catch {
        return undefined;
    }
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const count = Math.min(limit, items.length);
    for (let w = 0; w < count; w++) {
        workers.push((async () => {
            while (cursor < items.length) {
                const index = cursor++;
                await fn(items[index]);
            }
        })());
    }
    await Promise.all(workers);
}

function sanitizeC(text: string): string {
    let out = '';
    let i = 0;
    const n = text.length;
    while (i < n) {
        const c = text[i];
        const c2 = text[i + 1];
        if (c === '/' && c2 === '/') {
            while (i < n && text[i] !== '\n') {
                out += ' ';
                i++;
            }
        } else if (c === '/' && c2 === '*') {
            out += '  ';
            i += 2;
            while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
                out += text[i] === '\n' ? '\n' : ' ';
                i++;
            }
            if (i < n) {
                out += '  ';
                i += 2;
            }
        } else if (c === '"' || c === "'") {
            const quote = c;
            out += ' ';
            i++;
            while (i < n && text[i] !== quote) {
                if (text[i] === '\\') {
                    out += '  ';
                    i += 2;
                    continue;
                }
                out += text[i] === '\n' ? '\n' : ' ';
                i++;
            }
            if (i < n) {
                out += ' ';
                i++;
            }
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

function findFunctionBodies(text: string): FuncBody[] {
    const result: FuncBody[] = [];
    const re = new RegExp(FUNC_DEF_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const name = m[2];
        if (CONTROL_KEYWORDS.has(name)) {
            continue;
        }
        const openBrace = m.index + m[0].length - 1;
        const closeBrace = matchBrace(text, openBrace);
        if (closeBrace < 0) {
            continue;
        }
        result.push({
            name,
            nameOffset: m.index + m[0].indexOf(name),
            bodyStart: openBrace,
            bodyEnd: closeBrace
        });
        re.lastIndex = closeBrace + 1;
    }
    return result;
}

function matchBrace(text: string, open: number): number {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (c === '{') {
            depth++;
        } else if (c === '}') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

function computeLineStarts(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            starts.push(i + 1);
        }
    }
    return starts;
}

function positionAt(lineStarts: number[], offset: number): vscode.Position {
    let lo = 0;
    let hi = lineStarts.length - 1;
    let line = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lineStarts[mid] <= offset) {
            line = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return new vscode.Position(line, offset - lineStarts[line]);
}

function extractCallNames(text: string): string[] {
    const result: string[] = [];
    const re = /([A-Za-z_]\w*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const name = m[1];
        if (C_KEYWORDS.has(name)) {
            continue;
        }
        result.push(name);
    }
    return result;
}

function parseArgs(text: string, open: number): { args: string[]; end: number } | undefined {
    let depth = 0;
    let current = '';
    const args: string[] = [];
    for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(') {
            depth++;
            if (depth === 1) {
                continue;
            }
        } else if (ch === ')') {
            depth--;
            if (depth === 0) {
                args.push(current);
                return { args, end: i + 1 };
            }
        } else if (ch === ',' && depth === 1) {
            args.push(current);
            current = '';
            continue;
        }
        if (depth >= 1) {
            current += ch;
        }
    }
    return undefined;
}

/** 转义正则特殊字符 */
function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 按标识符边界替换文本中的单词；非标识符参数直接跳过，避免构造非法正则 */
function replaceIdentifier(text: string, word: string, replacement: string): string {
    if (!/^[A-Za-z_]\w*$/.test(word)) {
        return text;
    }
    const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'g');
    return text.replace(re, replacement);
}
