# RHI Core: 纯函数计算、对齐与校验算法

本文档阐述了 AetherEngine `src/rhi/core` 核心纯函数工具库的职责范围与设计不变量。

---

## 1. 核心定位与设计哲学

`src/rhi/core` 聚集了所有与具体后端解耦的**纯函数（Pure Functions）**计算、硬件对齐算法、描述符转换与参数校验逻辑。

核心不变量：

1. **纯粹无副作用**：所有函数均为纯数学或纯数据转换函数，绝不读取全局状态、不操作 DOM、不持有 GPU 驱动句柄；
2. **提前截断非法输入**：将复杂的硬件对齐规则（如 WebGPU 256 字节行步长、Block 格式尺寸）固化为纯算法，在指令录制和 Lowering 之前快速失败（Fail-Fast）。

---

## 2. 源码模块与职责

| 文件                                                     | 核心算法与职责                                                                                                               |
| :------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| **[`texture-copy-layout.ts`](./texture-copy-layout.ts)** | 纯函数计算纹理数据拷贝布局，严格执行 WebGPU 规范要求的 **256 字节行步长（`bytesPerRow`）对齐** 与压缩纹理 Block 块尺寸计算。 |
| **[`adapter-validation.ts`](./adapter-validation.ts)**   | 纯函数比对 `DeviceRequest` 申请的特性与数值限制（Limits）是否超出当前 `AdapterCapabilities`，收集并返回结构化缺失清单。      |
| **[`capabilities.ts`](./capabilities.ts)**               | 构建不可变的 `AdapterCapabilities` / `DeviceCapabilities` 快照，定义默认数值限制与基准特性。                                 |
| **[`webgpu-compat.ts`](./webgpu-compat.ts)**             | 纯描述符转换工具，将便携 RHI 描述符纯粹映射为标准 WebGPU 字典格式。                                                          |
| **[`texture-dimensions.ts`](./texture-dimensions.ts)**   | 贴图各 Mip 级别尺寸、切片与包围盒纯计算。                                                                                    |
| **[`stats.ts`](./stats.ts)**                             | 纯函数聚合 RHI 命令统计信息（Draw Calls, Dispatches, Triangles）。                                                           |
| **[`resource-ref.ts`](./resource-ref.ts)**               | 资源代际与引用合法性纯验证。                                                                                                 |
