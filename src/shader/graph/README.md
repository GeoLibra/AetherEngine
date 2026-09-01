# ShaderGraph 编译核心机制深度解析

本文档梳理自 AetherEngine 着色器子系统（Shader Subsystem）中 `ShaderGraphCompiler` 的核心算法实现，涵盖 DFS 环路检测、拓扑排序与 Merkle DAG 节点内容寻址缓存机制。

---

## 二、 DFS（深度优先搜索）的具体实现是怎样的？

在 `src/shader/graph/graph-compiler.ts` 中，DFS 采用的是编译器/图论中经典的 **三色标记法（Three-Color Marking）**：

```ts
const active = new Set<string>(); // 灰色：当前调用栈中的节点（正在访问）
const done = new Set<string>(); // 黑色：已完全遍历完子节点的节点（已处理）
// 白色（未访问）：不在 active 也不在 done 中的节点

const visit = (id: string): ShaderDiagnostic | undefined => {
  // 1. 环路检测：如果当前节点已经在调用栈里，说明沿依赖链绕了一圈回到了自己
  if (active.has(id))
    return graphDiagnostic('GRAPH_CYCLE', `ShaderGraph contains a cycle through "${id}".`);

  // 2. 剪枝优化：如果该节点已经被完全处理过，直接跳过
  if (done.has(id)) return undefined;

  // 3. 悬空节点检测：引用的节点在图定义中不存在
  const node = nodes.get(id);
  if (!node)
    return graphDiagnostic('GRAPH_MISSING_NODE', `ShaderGraph references missing node "${id}".`);

  active.add(id); // 标记为“访问中”（进栈）

  // 4. 深度优先递归访问所有前置输入依赖
  for (const dependency of Object.values(node.inputs ?? {})) {
    const error = visit(dependency);
    if (error) return error; // 遇到错误快速失败中断
  }

  active.delete(id); // 退出调用栈
  done.add(id); // 标记为“已处理完成”
  order.push(node); // 后序收集（拓扑排序的关键）
  return undefined;
};
```

- **执行起点**：从 `graph.outputs`（例如 `fragment: 'final_color'`）逆向往上游追溯。
- **环路自愈与报错**：只要存在 $A \rightarrow B \rightarrow A$ 的死循环连线，`active.has(id)` 会在毫秒级内捕获并精确报出循环节点，不会导致运行时栈溢出。

---

## 三、 拓扑排序是在干什么？

### 1. 核心目的：保证依赖前置（Dependency Ordering）

在着色器执行时，如果表达式 $C = A + B$，那么在生成代码时，**变量 $A$ 和 $B$ 必须在 $C$ 之前被计算和声明**。

拓扑排序的作用就是：**把网状交织的 DAG 节点打平为一个线性的执行序列，确保任何一个节点在计算时，其所有依赖的上游输入都已经计算完毕。**

```
   [ constant: A ]       [ constant: B ]
          \                     /
           \                   /
            v                 v
             [ add: sum (A + B) ]
                      |
                      v
            [ output: fragment ]
```

### 2. 代码中的巧妙之处（后序遍历推入）

因为 DFS 的递归特性是“先递归到底部（叶子节点），再逐层向上返回”，所以在回溯退栈时调用 `order.push(node)`：

1. 先把最底层的叶子节点（如 `constant: A` 和 `constant: B`）推入 `order`；
2. 再把 `add: sum` 推入 `order`；
3. 最后把 `output` 根节点推入 `order`。

最终得到的 `order` 数组就是天然的拓扑执行序列。接下来的代码生成阶段只需要写一个单遍循环：

```ts
for (const node of order) {
  // 此时可以 100% 保证 node.inputs 里引用的所有表达式已经存在于 expressions Map 中了！
}
```

---

## 四、 节点内容寻址 Hash 是怎么做的？

在 `src/shader/graph/graph-compiler.ts` 中引入 `src/core/hash.ts`，实现了一个类似 Git / 区块链的 **Merkle DAG（默克尔有向无环图）内容寻址机制**：

```ts
const hash = stableHash({
  kind: node.kind, // 节点种类（如 'add', 'constant', 'sin'）
  outputType: node.outputType, // 输出数据类型（如 'f32', 'vec3f'）
  dependencies: Object.entries(node.inputs ?? {})
    .sort(([a], [b]) => a.localeCompare(b)) // 1. 字典序排序，保证端口顺序变化不影响 Hash
    .map(([name, id]) => [name, nodeHashes.get(id)]), // 2. 关键：携带上游依赖节点的 Hash！
  value: node.value // 节点的静态数值
});
nodeHashes.set(node.id, hash);
```

### 工作流程分步：

1. **依赖传递性（Merkle Tree 特性）**：
   - 节点计算 Hash 时，放入的不是上游节点的 `id`（字符串名字），而是上游节点刚刚计算好的 **`nodeHashes.get(id)`**。
   - 这意味着：**一旦上游任何一个祖先节点发生修改，其 Hash 变化会一路向下级联扩散；反之，如果整个上游子图没变，当前节点的 Hash 就绝对不变。**

2. **跨平台确定性序列化与 64-bit FNV-1a**：
   - 在 `canonicalStringify` 中强制对 Object Key 进行 `.sort()`，杜绝了 JS 引擎对象遍历无序带来的 Hash 波动。
   - 采用 64 位 FNV-1a 算法计算出唯一的 16 位 16 进制字符串（如 `f3a1b89c02d4e712`）。

3. **局部缓存复用（O(1) 增量构建）**：
   ```ts
   const cached = this.nodeCache.get(hash);
   if (cached !== undefined) {
     expressions.set(node.id, cached); // 直接复用已有的 IR 节点
     reusedNodes++; // 统计命中缓存数
     continue;
   }
   // 只有未命中的节点才会执行下面的表达式构造逻辑
   ```

### 实际效果：

如果一个包含 200 个节点的复杂材质图，用户只是在边缘修改了一个常数，那么除受影响的极少数下游节点外，其余 190+ 个节点全部命中 `nodeCache` 零开销复用，使 Lowering 耗时降低至亚毫秒（Sub-millisecond）级。
