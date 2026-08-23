# Null RHI Backend: 无头一致性验证实现指南

本文档阐述了 AetherEngine `src/rhi/null` 无头（Null/Mock）后端的架构定位、内存模拟机制与测试用途。

---

## 1. 核心定位与设计哲学

Null 后端是 AetherEngine 面向**无 GPU、无 DOM、无浏览器宿主环境（如 Node.js CI、自动化单元测试）**提供的纯内存模拟 RHI 实现。

核心设计哲学：

1. **100% 契约完整性**：严格实现 `contracts/` 中定义的全部接口（`RHIDevice`、`RHICommandEncoder`、`RHIRenderPipeline`、`RHIBuffer`、`RHITexture` 等）；
2. **确定性状态机与生命周期验证**：在内存中精确跟踪资源代际（Generation）、引用状态、绑定槽位与 RenderPass 附件状态；
3. **Fail-Fast 纯参数校验**：具备完整的格式合法性、对齐计算、管线布局与绑定组匹配验证（`pipeline-validation.ts`、`capability-validation.ts`），任何非法调用立即抛出强类型错误；
4. **零 GPU 依赖的极速 CI**：为上层 RenderGraph、Material 和 ECS 系统提供毫秒级、高并发的无头回归测试环境。

---

## 2. 源码结构与模块职责

```txt
src/rhi/null/
├── README.md                  # 本文档：架构定位与内存模拟机制
├── adapter.ts                 # NullAdapter (纯内存适配器与设备协商)
├── device.ts                  # NullDevice (纯内存设备门面与资源工厂)
├── queue.ts                   # NullQueue (模拟队列提交与 Fence)
├── command.ts                 # NullCommandEncoder (模拟命令录制)
├── passes.ts                  # NullRenderPassEncoder / NullComputePassEncoder
├── buffer.ts                  # NullBuffer (纯内存 ArrayBuffer 存储与读写追踪)
├── texture.ts                 # NullTexture (格式与尺寸元数据追踪)
├── pipelines.ts               # NullRenderPipeline / NullComputePipeline / PipelineLayout
├── bindings.ts                # NullBindGroup / NullBindGroupLayout
├── render-target.ts           # NullRenderTarget / NullSurface (模拟呈现目标)
├── submission.ts              # NullSubmission (模拟异步完成)
├── pipeline-validation.ts     # 管线与绑定匹配纯验证算法
└── capability-validation.ts   # 能力与特性纯验证算法
```
