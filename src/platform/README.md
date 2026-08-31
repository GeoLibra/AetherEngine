# Platform 模块架构设计

## 1. 架构定位与设计哲学

`src/platform` 是 AetherEngine 的**跨平台宿主与窗口抽象层**。它的核心职责是为游戏循环与渲染系统提供确定性、强类型且平台无关的运行底座。

### 1.1 核心设计原则

1. **绝对隐藏平台私有细节（Opaque Identity）**：
   - 平台层负责管理浏览器 DOM `HTMLCanvasElement`、`OffscreenCanvas` 或原生桌面 OS Window 句柄。
   - 向上层（ECS、RenderGraph、Gameplay）只暴露轻量不透明的 **`SurfaceTarget`** (`{ readonly id: symbol; readonly kind: 'canvas' | 'native-window' }`)。
   - **不变量**：任何原生 DOM 节点、GL context 或 OS 窗口句柄绝不泄漏到 ECS 组件、RenderGraph 或序列化状态中。

2. **关注点分离（Separation of Concerns）**：
   - **`src/platform`** 拥有：宿主环境生命周期（`Host`）、窗口与画布度量（`HostWindow`、`WindowMetrics`）、高精度单调时钟（`MonotonicClock`）、系统级服务（`PlatformServiceRegistry`）。
   - **`src/rhi`** 拥有：GPU 适配器（`RHIAdapter`）、逻辑设备与队列（`RHIDevice`、`RHIQueue`）、可呈现表面状态机（`RHISurface`）与渲染管线/指令录制。
   - **两者接缝**：通过 `createBrowserGraphics` 完成安全探测、无害后端协商与上下文绑定。

3. **零开销与无头可测性（Zero-Overhead & Headless First）**：
   - 核心逻辑完全解耦于浏览器环境，在无 GPU、无 DOM 的 CI/Node 环境中可通过 `HeadlessHost` 和 `ManualClock` 进行 100% 确定性的单元测试与行为验证。

---

## 2. 引擎分层全景架构

```mermaid
flowchart TB
    %% -------------------- 第一层 --------------------
    subgraph L1 ["① 业务与场景数据层 (Gameplay & Scene)"]
        MainWorld["MainWorld (ECS 世界)<br/>Entities / Transform / Camera / Mesh"]
        Extract["Extract 阶段<br/>(提取不可变渲染数据快照)"]
        RenderWorld["RenderWorld (渲染世界)<br/>RenderViews / Phase Items / Draw Batches"]
        MainWorld -->|只读提取| Extract --> RenderWorld
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

    %% -------------------- 第三层 (平台宿主层) --------------------
    subgraph L3 ["③ 平台与画布宿主层 (src/platform)"]
        direction TB
        subgraph Hosts ["Host 宿主抽象"]
            BrowserHost["BrowserHost<br/>(RAF / DOM Canvas / DPI)"]
            NativeHost["NativeHost<br/>(OS Window / Native Bridge)"]
            HeadlessHost["HeadlessHost<br/>(ManualClock / Node CI)"]
        end
        SurfaceTargetNode["SurfaceTarget<br/>(Opaque 身份句柄：id + kind)"]
        Hosts --> SurfaceTargetNode
    end

    %% -------------------- 协商接缝 --------------------
    subgraph Seam ["引导协商接缝 (createBrowserGraphics)"]
        Negotiator["后端探测与无害协商<br/>(WebGPU 优先 -> WebGL2 优雅回退)"]
    end

    %% -------------------- 第四层 (RHI 门面) --------------------
    subgraph L4 ["④ RHI 统一便携契约层 (src/rhi/contracts & core)"]
        direction TB
        subgraph Contracts ["contracts/ (统一强类型接口)"]
            DeviceQueue["RHIDevice / RHIQueue<br/>(资源创建与队列提交)"]
            Encoders["RHICommandEncoder<br/>RHIRenderPassEncoder<br/>(命令录制)"]
            Resources["RHIBuffer / RHITexture<br/>RHIPipeline / RHIBindGroup<br/>(统一便携句柄)"]
            Surface["RHISurface<br/>(呈现目标)"]
        end
        CoreUtils["core/ 纯函数计算与验证<br/>(256B 对齐 / Format Block / 纯参数校验)"]
        Contracts -.->|底层纯函数支撑| CoreUtils
    end

    %% -------------------- 第五层 (RHI 后端实现) --------------------
    subgraph L5 ["⑤ RHI 后端实现层 (src/rhi backends)"]
        direction LR
        BackendWebGPU["WebGPU Backend<br/>(原生 1:1 薄 Lowering)"]
        BackendWebGL2["WebGL2 Backend<br/>(延迟命令流录制 / WGSL→GLSL)"]
        BackendNative["Native Backend<br/>(Dawn C++ 绑定)"]
        BackendNull["Null Backend<br/>(纯内存 Mock 验证)"]
    end

    %% -------------------- 第六层 --------------------
    subgraph L6 ["⑥ 底层图形 API 与硬件 (Hardware / Platform APIs)"]
        direction LR
        APIWebGPU["Browser WebGPU<br/>(GPUDevice / GPUQueue)"]
        APIWebGL2["Browser WebGL2<br/>(WebGL2RenderingContext)"]
        APIDawn["Native GPU 驱动<br/>(Vulkan / Metal / Direct3D 12)"]
        APINone["CPU 内存验证<br/>(Headless)"]
    end

    %% -------------------- 层间数据流动 --------------------
    RenderWorld -->|"驱动一帧渲染"| L2
    L3 --> Seam
    Seam --> L4
    SurfaceTargetNode --> Surface

    Executor -->|"1. 申请资源与创建 Encoder"| Contracts
    Executor -->|"2. finish 后提交 CommandBuffer"| DeviceQueue
    Surface -->|"acquireNextFrame 借出 Texture"| Executor
    Executor -->|"呈现渲染结果"| Surface

    L4 ===>|"统一多态分发到具体后端"| L5
    BackendWebGPU --> APIWebGPU
    BackendWebGL2 --> APIWebGL2
    BackendNative --> APIDawn
    BackendNull --> APINone
```

---

## 3. 子目录职责划分

按照 `AGENTS.md` 规范中的**子系统聚类规则**，`src/platform` 划分为以下高内聚子目录：

| 子目录          | 核心职责                                              | 主要导出符号                                                                                                              |
| :-------------- | :---------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| **`core/`**     | 平台通用基础抽象、窗口度量与调度器帧边界接缝          | `PlatformWindow`, `WindowMetrics`, `HostBoundaryRunner`, `MutablePlatformServiceRegistry`, `createPlatformServiceToken`   |
| **`browser/`**  | 浏览器环境宿主、DOM 事件/RAF 适配与图形协商引导器     | `BrowserHost`, `BrowserWindowPort`, `BrowserPlatformPort`, `createBrowserGraphics`, `BrowserGraphicsBootstrapError`       |
| **`headless/`** | 无头/CI/Node 运行宿主与手动单调时钟                   | `HeadlessHost`, `ManualClock`, `HeadlessHostOptions`                                                                      |
| **`native/`**   | 原生移动/桌面端宿主、VSync 垂直同步调度与原生系统服务 | `NativeHost`, `NativeRunner`, `NativeFilesystemServiceToken`, `NativeSensorsServiceToken`, `registerNativeServiceModules` |
| **`types/`**    | 平台层不可变强类型契约定义                            | `Host`, `HostWindow`, `SurfaceTarget`, `WindowMetrics`, `BrowserGraphicsSession`, `BrowserGraphicsLoss` 等                |

---

## 4. 一帧生命周期与数据流

```mermaid
sequenceDiagram
    autonumber
    participant Host as Platform Host / Window
    participant Runner as HostBoundaryRunner
    participant App as App Schedule
    participant Surf as RHISurface
    participant RG as RenderGraph Executor
    participant Queue as RHIQueue

    Note over Host: 1. 收集并合并 Resize / DPI / Focus 事件
    Host->>Runner: 触发帧调度回调 (RAF / VSync / Step)
    Runner->>Host: commitFrameBoundary() -> generation 递增 (若有变更)

    Runner->>App: 驱动 App Update / Extract / Prepare 阶段

    Note over Surf,RG: 2. 呈现目标帧租借
    RG->>Surf: acquireNextFrame() -> 取得当帧 RHISurfaceFrame
    RG->>RG: 编译并录制 Pass 指令 (绑定 SurfaceTexture)
    RG->>Queue: submit([commandBuffer])

    alt 渲染成功
        RG->>Surf: frame.present() -> 画面输出到屏幕
    else 录制或提交异常
        RG->>Surf: frame.release() -> 确保生命周期收敛且不发生双重释放
    end
```

---

## 5. 核心不变量与 Fail-Fast 规范

1. **画布上下文唯一绑定（Context Exclusivity）**：
   - 目标 Canvas 只能绑定一种 Context（WebGPU 或 WebGL2）。在后端探测阶段，`createBrowserGraphics` 仅对环境与独立临时 Canvas 探测能力，**严禁提前在目标 Canvas 上调用 `getContext`**。
2. **窗口度量合并（Metrics Coalescing）**：
   - 连续的 Resize 事件在帧边界前暂存为 `pendingMetrics`，仅在 `commitFrameBoundary()` 时生效并递增 `generation`，避免拖拽缩放时每像素高频重建 GPU 资源。
3. **SurfaceFrame 线性所有权**：
   - 每次 `acquire` 产生的 `RHISurfaceFrame` 具有严格的线性生命周期，最终路径必须且只能是 `present()` 或 `release()` 之一。
