# AetherEngine RHI Subsystem: 架构全景与目录导航

本文档是 AetherEngine `src/rhi` 渲染硬件接口（Render Hardware Interface）子系统的顶层架构总览与导航索引。

---

## 目录

1. [系统全景与分层架构](#1-系统全景与分层架构)
   - [1.1 核心定位与设计哲学](#11-核心定位与设计哲学)
   - [1.2 自顶向下整体架构图](#12-自顶向下整体架构图)
   - [1.3 六层职责与核心数据流](#13-六层职责与核心数据流)
2. [一帧中的 RHI 调用生命周期](#2-一帧中的-rhi-调用生命周期)
3. [子目录专业文档索引](#3-子目录专业文档索引)
4. [源码目录结构与核心 API 速查表](#4-源码目录结构与核心-api-速查表)

---

## 1. 系统全景与分层架构

### 1.1 核心定位与设计哲学

在 AetherEngine 中，**RHI (Render Hardware Interface)** 是连接上层高层渲染系统与底层图形 API 的统一便携抽象层。

核心原则：

1. **统一的 WebGPU-like 接口**：上层系统（如 `RenderGraph`、`Material`、`Shader`）仅面向统一的类型契约编程，不通过 `if (backend === 'webgl2')` 切换公共 API；
2. **方法存在与能力可用分离**：统一的方法面（如 `createComputePipeline`）在所有后端均存在，若底层能力不支持，由 `DeviceCapabilities` 提前协商，误用时显式抛出强类型异常（`RHIUnsupportedOperationError`），绝不在底层做隐式静默偷换；
3. **世代（Generation）与生命周期安全**：所有 RHI 资源均附带 `deviceGeneration`，跨设备或已失效资源在边界即时拦截，杜绝悬空指针；
4. **纯函数验证先行**：对齐、格式尺寸、拷贝布局计算等均由纯函数在 Lowering 前完成验证，不依赖浏览器全局变量或驱动黑盒。

### 1.2 自顶向下整体架构图

```mermaid
flowchart TD
    %% -------------------- 第一层 --------------------
    subgraph L1 ["① 业务与场景数据层 (Gameplay & Scene)"]
        MainWorld["MainWorld (ECS 世界)<br/>Entities / Transform / Camera / Mesh"]
        Extract["Extract 阶段<br/>(提取不可变渲染数据快照)"]
        RenderWorld["RenderWorld (渲染世界)<br/>RenderViews / Phase Items / Draw Batches"]
        MainWorld -->|"只读提取"| Extract --> RenderWorld
    end

    %% -------------------- 第二层 --------------------
    subgraph L2 ["② 渲染编排与调度层 (Rendering & RenderGraph)"]
        direction LR
        Assets["Shader & Material 准备<br/>(WGSL 编译 / Uniform / 贴图上传)"]
        RG["RenderGraph<br/>(构建 Pass DAG / 计算资源生命周期与复用)"]
        Executor["RenderGraph Executor<br/>(按序遍历 Pass 执行回调)"]
        Assets --> RG
        RG --> Executor
    end

    %% -------------------- 第三层 --------------------
    subgraph L3 ["③ 平台与画布宿主层 (Platform & Surface)"]
        HostCanvas["Host Window / Canvas 宿主"]
        Adapter["Adapter & Device 协商<br/>(探测 Capabilities / FeaturePolicy 决策)"]
        HostCanvas --- Adapter
    end

    %% -------------------- 第四层 (RHI 门面) --------------------
    subgraph L4 ["④ RHI 统一便携契约层 (src/rhi/contracts & core)"]
        direction TB
        subgraph Contracts ["contracts/ (统一强类型接口)"]
            direction LR
            DeviceQueue["RHIDevice / RHIQueue<br/>(资源创建与队列提交)"]
            Encoders["RHICommandEncoder<br/>RHIRenderPassEncoder<br/>(命令录制)"]
            Resources["RHIBuffer / RHITexture<br/>RHIPipeline / RHIBindGroup<br/>(统一便携句柄)"]
            Surface["RHISurface<br/>(呈现目标)"]
        end
        CoreUtils["core/ 纯函数计算与验证<br/>(256B 对齐 / Format Block 计算 / webgpuCompat / 纯参数校验)"]
        Contracts -.->|"底层纯函数支撑"| CoreUtils
    end

    %% -------------------- 第五层 (RHI 后端实现) --------------------
    subgraph L5 ["⑤ RHI 后端实现层 (src/rhi backends)"]
        direction LR
        BackendWebGPU["WebGPU Backend<br/>(原生 1:1 薄 Lowering<br/>无二次解释 / 直调原生 Encoder)"]
        BackendWebGL2["WebGL2 Backend<br/>(延迟命令流录制<br/>StateVM 状态机缓存 / WGSL→GLSL)"]
        BackendNative["Native Backend<br/>(Dawn C++ 绑定<br/>桌面端原生运行时)"]
        BackendNull["Null Backend<br/>(纯内存 Mock / 契约测试<br/>无头 CI / Node 单元测试)"]
    end

    %% -------------------- 第六层 --------------------
    subgraph L6 ["⑥ 底层图形 API 与硬件 (Hardware / Platform APIs)"]
        direction LR
        APIWebGPU["Browser WebGPU<br/>(GPUDevice / GPUQueue)"]
        APIWebGL2["Browser WebGL2<br/>(WebGL2RenderingContext)"]
        APIDawn["Native GPU 驱动<br/>(Vulkan / Metal / Direct3D 12)"]
        APINone["CPU 内存验证<br/>(Headless)"]
    end

    %% -------------------- 层与层之间的清晰流动 --------------------
    RenderWorld -->|"驱动一帧渲染"| L2
    Adapter -->|"协商并创建"| DeviceQueue
    HostCanvas -->|"封装为"| Surface

    Executor -->|"1. 申请资源与创建 Encoder"| Contracts
    Executor -->|"2. finish 后提交 CommandBuffer"| DeviceQueue

    L4 ===>|"统一多态分发到具体后端"| L5

    BackendWebGPU --> APIWebGPU
    BackendWebGL2 --> APIWebGL2
    BackendNative --> APIDawn
    BackendNull --> APINone
```

### 1.3 六层职责与核心数据流

| 层级                 | 代表模块                                         | 核心职责                                                      | 一帧中的核心行为                                            |
| :------------------- | :----------------------------------------------- | :------------------------------------------------------------ | :---------------------------------------------------------- |
| **① 业务与场景层**   | `src/ecs/`                                       | 游戏逻辑权威、实体 Transform、组件状态                        | `Extract` 阶段将可变数据提取为不可变 `RenderWorld` 视图数据 |
| **② 渲染编排层**     | `src/render-graph/`, `src/rendering/`            | 构建 Pass 依赖图、管理 Transient 临时资源池、材质与着色器准备 | Executor 驱动 RHI 录制一帧所有 Pass 的绘制与计算指令        |
| **③ 平台宿主层**     | `src/platform/`                                  | 管理 Canvas 生命周期、探测硬件能力                            | 初始化 Adapter，根据策略创建 `RHIDevice` 与 `RHISurface`    |
| **④ RHI 契约与核心** | `src/rhi/contracts/`, `src/rhi/core/`            | **上层唯一依赖的 RHI 抽象**，纯接口定义与纯函数算法           | 提供与硬件解耦的句柄、编码器及 256 字节行对齐校验           |
| **⑤ RHI 后端实现**   | `src/rhi/webgpu/`, `webgl2/`, `null/`, `native/` | **具体图形 API 的 Lowering 引擎**                             | 将便携描述符和指令流翻译为底层驱动调用                      |
| **⑥ 硬件驱动层**     | 浏览器 / OS 驱动                                 | 底层图形渲染与硬件计算                                        | 执行 GPU 渲染并将画面输出到屏幕                             |

---

## 2. 一帧中的 RHI 调用生命周期

```mermaid
sequenceDiagram
    autonumber
    participant App as App / Platform
    participant RG as RenderGraph Executor
    participant Dev as RHIDevice
    participant Enc as RHICommandEncoder
    participant Pass as RHIRenderPassEncoder
    participant Queue as RHIQueue
    participant Surf as RHISurface

    App->>Surf: acquireNextFrame() -> 获得当前帧 RHISurfaceFrame
    RG->>Dev: createCommandEncoder({ label: "frame-encoder" })
    Dev-->>RG: Enc (RHICommandEncoder)

    loop 遍历 RenderGraph 中编译好的 Pass
        RG->>Enc: beginRenderPass(passDescriptor)
        Enc-->>RG: Pass (RHIRenderPassEncoder)
        RG->>Pass: setPipeline(renderPipeline)
        RG->>Pass: setBindGroup(0, bindGroup)
        RG->>Pass: setVertexBuffer(0, vertexBuffer)
        RG->>Pass: draw(vertexCount, instanceCount, ...)
        RG->>Pass: end()
    end

    RG->>Enc: finish() -> 获得 RHICommandBuffer
    Enc-->>RG: cmdBuffer
    RG->>Queue: submit([cmdBuffer])
    Queue-->>App: 返回 RHISubmission (包含 Fence / Epoch)
    App->>Surf: present(frame) -> 提交呈现到画布
```

---

## 3. 子目录专业文档索引

为了保持模块高内聚与职责清晰，RHI 各子系统的深度设计与实现指南已归档至对应子目录：

| 子目录           | 专门文档                                       | 核心内容概述                                                                                       |
| :--------------- | :--------------------------------------------- | :------------------------------------------------------------------------------------------------- |
| **`contracts/`** | [**契约层规范指南**](./contracts/README.md)    | 纯接口定义、5 级依赖层次图、硬件队列角色（Graphics/Compute/Transfer）、特性两阶段协商              |
| **`core/`**      | [**核心纯算法指南**](./core/README.md)         | 256 字节行对齐纯函数、Block 尺寸计算、描述符转换、适配器能力验证                                   |
| **`webgpu/`**    | [**WebGPU 后端实现指南**](./webgpu/README.md)  | 浏览器原生 1:1 薄 Lowering 机制、零中间 IR、异步管线编译、与 Native Dawn 的共享复用                |
| **`webgl2/`**    | [**WebGL2 后端实现指南**](./webgl2/README.md)  | 延迟命令回放（`WebGL2ReplayExecutor`）、`StateVM` 状态机缓存、FBO/VAO 动态池、WGSL $\to$ GLSL 修整 |
| **`native/`**    | [**Native Dawn 后端指南**](./native/README.md) | Google Dawn C++ 绑定、Tint 自动化 Shader 转译（MSL/HLSL/SPIR-V）、与 BabylonNative 对比            |
| **`null/`**      | [**Null 无头后端指南**](./null/README.md)      | 纯内存 Mock 设备、确定性状态机与生命周期验证、Node.js / CI 极速无头测试                            |

---

## 4. 源码目录结构与核心 API 速查表

```txt
src/rhi/
 ├── contracts/              # 纯接口契约层 (零外部依赖、纯类型定义) -> 详见 contracts/README.md
 ├── core/                   # 纯函数计算与验证算法 -> 详见 core/README.md
 ├── webgpu/                 # WebGPU 原生 1:1 薄 Lowering 实现 -> 详见 webgpu/README.md
 ├── webgl2/                 # WebGL2 延迟命令流与 StateVM 状态机实现 -> 详见 webgl2/README.md
 ├── native/                 # Dawn C++ 原生后端 -> 详见 native/README.md
 ├── null/                   # 无头内存 Mock 后端 (Node / Vitest 契约测试) -> 详见 null/README.md
 ├── README.md               # 本文档：顶层架构总览与全局导航
 └── index.ts                # RHI 公共模块统一导出入口
```
