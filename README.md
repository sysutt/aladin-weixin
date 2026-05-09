# aladin-weixin

作者：sysutt(从前有个T)

基于 `aladin.lite` 共享协议整理的微信小程序开源样例仓库，包含：

- 适配微信小程序 Canvas 2D 的 `Aladin.wx.js`
- 修正后的 HEALPix 计算与投影逻辑
- 一个可直接在微信开发者工具中打开的 `pages/aladin` 测试页面

## 目录结构

```text
.
|- app.js
|- app.json
|- app.wxss
|- docs/
|  `- aladin-wx-technical.md
|- pages/
|  `- aladin/
|     |- aladin.js
|     |- aladin.json
|     |- aladin.wxml
|     `- aladin.wxss
`- utils/
   `- aladin-adapter/
      |- Aladin.wx.js
      `- HEALPixTileManager.js
```

## 本地运行

1. 使用微信开发者工具打开当前项目目录
2. 选择"小程序"项目
3. 如未配置 AppID，可先使用测试号或 `touristappid`
4. 进入 `pages/aladin/aladin` 页面查看星图

## 功能特性

- **HiPS 瓦片渲染**：基于 HEALPix 分层渐进式巡天协议，支持 DSS、2MASS、SDSS 等多种巡天数据源
- **触摸交互**：单指拖拽平移、双指缩放
- **坐标网格**：赤经/赤纬网格线，带角度刻度标签（如 `+30°`、`12h`）
- **Allsky 低分辨率背景**：首屏快速显示模糊星空，避免黑屏等待
- **顶点焊接**：空间哈希算法消除相邻瓦片间的拼接缝隙
- **四三角形纹理映射**：以瓦片中心为公共顶点拆分 4 个三角形，消除对角线仿射不连续
- **事件系统**：`ready`、`positionChanged`、`tilesLoading`、`tilesLoaded` 事件通知
- **渲染后钩子**：`onAfterRender` 回调，支持叠加自定义内容（如 AstroBin 参考图像）

## 开源说明

这个仓库只保留了与 `aladin.lite` 微信小程序适配和测试页直接相关的文件，未包含原业务小程序中的其他页面、接口、登录逻辑与私有配置。

`Aladin.wx.js` 的技术说明见 `docs/aladin-wx-technical.md`。

## 许可协议

本项目与 `aladin.lite` 保持一致，采用 `GNU GPL v3.0` 许可协议。完整文本见 `LICENSE`。
