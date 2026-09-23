# C Call Chain

在 VS Code 底部面板以图形方式展示 C 函数的双向调用链（调用者 / 被调用者）。

## 功能特性

- 在 C 文件函数声明/定义处右键，选择「显示函数调用链」。
- 图形化展示：当前函数居中，左侧为调用者（Callers），右侧为被调用者（Callees），用带箭头的曲线连接。
- 单向多层展开：中心向两侧展开；左侧节点只继续向调用者方向、右侧节点只继续向被调用者方向展开。懒加载、按函数去重、结构上不成环。
- 跨文件分析（依赖语言服务器）。
- 宏调用近似展开：对 `#define` 定义的函数式宏做展开，补全经由宏的调用关系，避免调用链在宏处断开。
- 函数指针节点：把函数指针表达式（如 `B.func_ptr_a`、`C.func_ptr_a`）作为独立节点，建立链路「调用者 → B.func_ptr_a → func_a」。查看 `func_a` 的调用者会看到 `B.func_ptr_a` / `C.func_ptr_a`；展开这些指针节点会看到调用 `B.func_ptr_a(...)` 的函数。
- 固定缩放、可滚动/平移：节点文字始终清晰，调用者/被调用者很多时滚动查看，不自动缩小。

## 交互

| 操作 | 效果 |
| --- | --- |
| 单击节点 | 跳转到该函数定义（指针节点跳转到其赋值处） |
| 单击节点下方「＋」/「－」 | 展开 / 收起该节点的上一层/下一层 |
| 双击节点 | 以该节点为中心重新展开（下钻） |
| 「← 返回」 | 回到上一个中心函数 |
| 「居中」 | 将当前中心函数移回视野中央 |
| 「＋」/「－」 | 放大 / 缩小（不自动缩放） |
| 滚轮 | 上下滚动 |
| Shift + 滚轮 | 左右滚动 |
| 拖拽 | 平移 |
| 底部滚动条 | 左右拖动移动图形（内容超宽时出现） |

近似/派生出的节点以虚线边框标记：宏近似节点为橙色并带「宏」角标；函数指针节点为紫色（显示指针表达式）。对应的边为虚线。框图内只显示函数名或指针表达式，完整路径见悬停提示。

## 环境要求

- VS Code 1.74 及以上。
- 一个支持「调用层次（Call Hierarchy）」的 C/C++ 语言扩展：
  - `ms-vscode.cpptools`（微软 C/C++ 扩展），或
  - `llvm-vs-code-extensions.vscode-clangd`（clangd）。

## 安装

### 方法一：从 GitHub Releases 安装（推荐）

1. 前往 [Releases 页面](https://github.com/MengFeiran/C-Call-Chain/releases)
2. 下载最新版本的 `.vsix` 文件
3. 在 VS Code 中：
   - 打开命令面板（`Ctrl+Shift+P` / `Cmd+Shift+P`）
   - 输入 `Extensions: Install from VSIX...`
   - 选择下载的 `.vsix` 文件

### 方法二：从源码构建

```bash
# 克隆仓库
git clone https://github.com/MengFeiran/C-Call-Chain.git
cd C-Call-Chain

# 安装依赖
npm install

# 编译
npm run compile

# 打包为 .vsix 文件
npx @vscode/vsce package

# 安装生成的 .vsix 文件
code --install-extension c-call-chain-0.0.1.vsix
```

## 使用步骤

1. 打开一个 C 文件，将光标放在某个函数上（或直接右键函数名）。
2. 右键菜单选择「显示函数调用链」。
3. 底部面板会新增并聚焦「C 函数调用链」标签页，显示调用图。

## 工作原理

- 数据来源优先使用 VS Code 内置的 Call Hierarchy 命令：
  - `vscode.prepareCallHierarchy`
  - `vscode.provideIncomingCalls`
  - `vscode.provideOutgoingCalls`
- 当内置命令拿不到结果时，回退到微软 C/C++ 扩展的专有命令：
  - `C_Cpp.PrepareCallHierarchy`
  - `C_Cpp.CallHierarchyCallsTo`（调用者）
  - `C_Cpp.CallHierarchyCallsFrom`（被调用者）
- 近似索引：自建索引扫描工作区 `**/*.{c,h}`，提供两类内置 Call Hierarchy 可能缺失的关系：
  - 宏：识别函数式宏并做近似展开（实参替换、去掉 `##`、`#param` 置空、递归展开嵌套宏）。
  - 函数指针：把指针表达式作为节点，建立「指针 ↔ 被赋值函数」「调用者函数 ↔ 指针」关系。识别以下注册/调用写法：
    - 成员赋值：`B.func_ptr_a = func_a;`、`B->func_ptr_a = func_a;`
    - 指定初始化器：`ops_t B = { .func_ptr_a = func_a, ... };`
    - 普通函数指针变量：`void (*g_cb)(int);` 加 `g_cb = func_a;` 与 `g_cb(...)`
    - 调用：`B.func_ptr_a(...)`、`g_cb(...)`
    - 索引为工作区全局，注册位置与被注册函数可跨文件。
    - 调用点与注册点若使用**不同变量**（如 `l2_bit_heap_ops.free` 注册、`heap->ops->free(...)` 调用），先按完整表达式精确匹配，未命中时按**同族变量**回退连接：成员名相同，且变量名互为前缀/后缀（如 `heap.ops` 与 `l2_bit_heap_ops` 共享后缀 `ops`）。仅成员名相同而变量名无关的表达式（如 libevent 的 `evthread_lock_fns_.free`）不会混入，避免 `free`/`alloc` 这类通用成员名引入大量无关内容。
  - 索引**在后台异步构建**，不阻塞调用链展示；就绪后自动为已展开的节点补上近似节点/边。
  - 全程基于文本解析，**不调用语言服务器**，避免大项目下的卡顿。
- 图渲染：底部面板的 Webview 视图 + 手绘 SVG，无第三方运行时依赖。

## 设置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `cCallChain.enableMacroIndex` | `true` | 是否启用宏近似。超大项目可关闭以节省资源。 |
| `cCallChain.enableFnPtrIndex` | `true` | 是否启用函数指针近似。 |
| `cCallChain.fnPtrMemberThreshold` | `20` | 函数指针同族模糊回退的表达式数量上限：同成员名下、变量名互为前缀/后缀的表达式超过此值时视为过于通用，仅保留精确匹配。`0`/负数表示禁用回退。 |
| `cCallChain.macroIndexMaxFiles` | `2000` | 近似索引最多扫描的 C/H 文件数量。 |

## 目录结构

```
.
├─ package.json          # 插件清单：命令、右键菜单、面板视图
├─ tsconfig.json
├─ src/
│  ├─ extension.ts       # 激活、命令、光标定位
│  ├─ callHierarchy.ts   # Call Hierarchy 数据层（内置命令 + cpptools 兜底）
│  ├─ graphView.ts       # 面板 Webview 视图与图模型
│  └─ approxIndex.ts     # 近似索引：宏展开 + 函数指针节点
├─ media/
│  ├─ main.js            # SVG 调用图渲染与交互
│  └─ main.css
└─ sample/               # 测试样例（demo.c / util.h / util.c / app.c / fnptr.c）
```

## 已知限制

- 仅支持 C，暂不支持 C++。
- 调用关系依赖 C/C++ 语言扩展（`ms-vscode.cpptools` 或 clangd）提供 Call Hierarchy。
- 宏处理为启发式近似（正则 + 括号配平 + 文本展开），非完整预处理器；对象式宏不展开，复杂的 `##` 拼接不保证精确。
- 函数指针为文本近似：
  - 识别 `X.Y` / `X->Y`（含 `a.b.c` 链）、指定初始化器 `.member = func`、普通函数指针变量 `(*p)(...)`。
  - 调用点与注册点变量名不同时，按**同族变量**（同成员名 + 变量名互为前缀/后缀）回退连接；可由 `cCallChain.fnPtrMemberThreshold` 调整阈值，`0`/负数关闭回退（只保留精确匹配）。
  - 不支持带下标的表达式（如 `arr[i].fn`）；成员赋值仅当右侧是已知函数名时才登记，可能漏掉间接赋值。
- 近似索引首次构建需在后台扫描工作区，文件较多时耗时较长，但**不阻塞**调用链展示；构建完成后会缓存，后续即时可用。可通过 `cCallChain.enableMacroIndex` / `cCallChain.enableFnPtrIndex` 关闭，或用 `cCallChain.macroIndexMaxFiles` 限制扫描文件数。

## 许可证

本项目采用 MIT 许可证，详见仓库根目录的 `LICENSE` 文件。
