# Aladin.wx.js 技术文档

## 1. 文档目的

本文档用于说明 `utils/aladin-adapter/Aladin.wx.js` 相对 `aladin.lite` 在微信小程序环境中的适配方式、核心改动点、模块职责与已知边界，便于开源披露、二次维护与问题追踪。

## 2. 文件定位

- 核心文件：`utils/aladin-adapter/Aladin.wx.js`
- 数学与 HEALPix 支撑：`utils/aladin-adapter/HEALPixTileManager.js`
- 示例页面：`pages/aladin/aladin.js`

`Aladin.wx.js` 提供 `AladinWX` 类，负责以下能力：

- 管理微信小程序 `Canvas` 节点与 2D 绘图上下文
- 维护视场状态：`ra`、`dec`、`fov`
- 下载并缓存 HiPS 瓦片
- 完成天球坐标与屏幕坐标之间的投影转换
- 响应拖拽、双指缩放、跳转目标与图层切换

## 3. 与 aladin.lite 的主要差异

### 3.1 运行时环境适配

浏览器版 `aladin.lite` 依赖 DOM、HTMLCanvasElement、Image 与网络栈。微信小程序版做了以下替换：

- 构造函数直接接收 `wx.createSelectorQuery().fields({ node: true })` 返回的 `Canvas Node`
- 使用 `canvasNode.getContext('2d')` 获取上下文
- 使用 `canvas.createImage()` 和 `wx.downloadFile()` 加载远程瓦片
- 通过页面层转发触摸事件，不依赖浏览器 Pointer/Mouse 事件

### 3.2 画布尺寸策略

文件头部明确采用“逻辑像素即绘制像素”的策略：

- `canvas.width = width`
- `canvas.height = height`
- 不额外乘 DPR
- 避免 `ctx.scale()` 与 `ctx.setTransform()` 叠加导致纹理映射错位

这项策略直接服务于 `_drawTriangle()` 中的仿射贴图实现。

### 3.3 投影与坐标方向修正

微信版使用 `FixedHealpix.project()` / `FixedHealpix.unproject()` 统一做 SIN 投影。

关键点：

- 焦距公式固定为 `width / (2 * sin(fov / 2))`
- `project()` 中对 X/Y 做了方向修正，使天文视图方向与触摸交互一致
- `world2pix()` 与 `pix2world()` 全部走同一套数学路径，避免显示和命中计算分叉

### 3.4 HEALPix 算法修复

`Aladin.wx.js` 不直接实现 HEALPix，而是依赖 `HEALPixTileManager.js` 中的 `FixedHealpix`。当前样例里保留的关键修正包括：

- 修正 `ang2pix` / `pix2ang` 的 NESTED 编码转换
- 修正极区与赤道区域的面编号计算
- 使用二级孙像素中心外推方式求瓦片四角，降低跨面边界顶点跳变
- 补足 `project` / `unproject` 的方向一致性

这些修正是微信版能稳定绘制 HiPS 瓦片的基础。

## 4. 渲染流程

### 4.1 初始化

`new AladinWX(canvasNode, width, height, options)` 初始化后会立即：

1. 保存视图状态与开关
2. 初始化事件容器、瓦片缓存和加载中的请求表
3. 设置 survey 根地址
4. 异步预加载 `Allsky.jpg`
5. 调用 `_scheduleRender()`
6. 通过 `ready` 事件通知页面

### 4.2 调度渲染

`_scheduleRender()` 通过微任务节流，避免连续触摸时重复触发完整渲染。

`_render()` 的执行顺序：

1. 清空背景
2. 渲染低分辨率 `Allsky` 全景底图
3. 加载并绘制高分辨率 HiPS 瓦片
4. 按需绘制坐标网格（含赤经赤纬刻度标签）
5. 执行 `onAfterRender` 钩子

### 4.3 坐标网格与刻度标签

`_renderGrid()` 根据当前 FOV 自动选择合适的网格步长：

| FOV 范围   | 网格步长 |
|------------|----------|
| > 90°      | 30°      |
| 45°–90°    | 15°      |
| 15°–45°    | 10°      |
| 5°–15°     | 5°       |
| 1°–5°      | 1°       |
| < 1°       | 0.5°     |

赤纬标签格式：`+30°`、`-15°30'`（度分制）
赤经标签格式：`12h`、`18h30m`（时角制）

标签绘制在画布可见范围内的网格线上，使用半透明蓝色文字，避免遮挡星图内容。

### 4.5 低分辨率背景

`_loadAllsky()` 会请求 `Norder3/Allsky.jpg`。这张图被拆成缩略图网格，在 `_renderAllsky()` 中以相同的四三角形方法贴回屏幕。

作用：

- 首屏避免长时间黑屏
- 高分辨率瓦片尚未到位时提供可用背景

### 4.6 高分辨率瓦片

`_renderTiles()` 的逻辑：

1. 按 FOV 计算适合的 HEALPix `order`
2. 对屏幕采样反投影，求出视场内可见像素集合
3. 并发加载瓦片，批次上限为 6
4. 计算每块瓦片的四角与中心
5. 做顶点焊接后调用 `_drawTileWithCachedCoords()` 绘制

## 5. 接缝控制策略

为降低 HiPS 瓦片之间的可见缝，当前实现同时采用了三层策略：

### 5.1 四三角形拆分

每块菱形瓦片不再用两三角形对角线切分，而是改为：

- South -> East -> Center
- East -> North -> Center
- North -> West -> Center
- West -> South -> Center

这样可以减轻两大三角形在对角线上的仿射不连续问题。

### 5.2 顶点焊接

`_renderTiles()` 中使用空间哈希缓存顶点，把相邻瓦片几乎重合的天球顶点映射到同一个屏幕像素结果，减少边缘错缝。

实现特征：

- 容差约 `0.001` 度
- 处理 RA `0/360` 环绕
- 使用量化网格做邻域查找

### 5.3 三角形外扩

`_drawTriangle()` 会在裁剪前把每个三角形顶点沿重心外推约 3 像素，形成轻微 overdraw，用于覆盖剩余拼接缝。

## 6. 事件与页面通信

页面通过 `pages/aladin/aladin.js` 调用以下公开接口：

- `gotoRaDec(ra, dec, fov)`
- `setFov(fov)`
- `world2pix(ra, dec)`
- `pix2world(x, y)`
- `on(event, handler)`
- `off(event, handler)`
- `dispose()`
- `onTouchStart(e)`
- `onTouchMove(e)`
- `onTouchEnd(e)`

当前事件类型：

- `ready`
- `positionChanged`
- `tilesLoading`
- `tilesLoaded`

## 7. Survey 与缓存策略

Survey 根地址由页面传入，例如：

- `https://alasky.cds.unistra.fr/DSS/DSSColor`
- `https://alasky.cds.unistra.fr/2MASS/Color`
- `https://alasky.cds.unistra.fr/SDSS/DR9/color`

缓存策略：

- `_tileCache` 缓存已完成加载的图像对象
- `_loadingTiles` 去重正在进行中的相同请求
- 切换 survey 时清空两类缓存，避免交叉污染

## 8. 已知边界

- 当前直接依赖远程 HiPS 服务，离线不可用
- `wx.downloadFile()` 的超时、失败重试和临时文件生命周期仍受小程序平台限制
- 画面接缝已大幅收敛，但在极端视场、极区或网络抖动时仍可能出现细微边缘误差
- 示例页只覆盖星图展示与基础交互，不包含业务层权限、账号、收藏、标注等能力

## 9. 开源维护建议

- 后续修改优先保持 `Aladin.wx.js` 与 `HEALPixTileManager.js` 的职责边界
- 如需继续优化接缝，建议先保留现有四三角形和顶点焊接框架，再针对容差和采样策略做实验
- 如果未来要支持更多 survey 或图层叠加，建议把图层与瓦片请求进一步模块化

## 10. 对外披露建议

如果你要在 GitHub 仓库首页说明本项目，建议明确写出：

- 本仓库是基于 `aladin.lite` 共享协议整理的微信小程序适配样例
- 开源范围仅包含适配层与测试页面
- 原业务项目中的其他页面、接口和配置未纳入本仓库
