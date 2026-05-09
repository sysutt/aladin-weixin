/**
 * 天文星图渲染引擎 - 微信小程序版
 * 基于 HiPS (Hierarchical Progressive Survey) 协议
 *
 * 关键设计决策：
 *  - 接受 Canvas Node 对象（不是 ID），避免异步选择器竞争
 *  - canvas.width/height = 逻辑像素，不乘以 DPR，避免 setTransform 和 ctx.scale 的冲突
 *  - 所有坐标计算统一使用 SIN 投影，焦距 = width / (2*sin(fov/2))
 */

const { FixedHealpix } = require('./HEALPixTileManager');

// HiPS 瓦片图像角点映射（JPEG/PNG 格式，相对于图像坐标 x 向右 y 向下）：
//   tile (0,   0  ) = South 顶点
//   tile (512, 0  ) = West  顶点
//   tile (512, 512) = North 顶点
//   tile (0,   512) = East  顶点
// HEALPix getTileVertices 返回顺序：v[0]=South, v[1]=East, v[2]=North, v[3]=West
const TILE_SIZE = 512;

// Allsky.jpg 布局常量（Norder3，按 HiPS 标准）：
//   npix = 12×4³ = 768；缩略图尺寸 = 512/2³ = 64；每行 = floor(√768) = 27
const ALLSKY_ORDER        = 3;
const ALLSKY_THUMB        = 64;   // 每张缩略图的像素边长
const ALLSKY_TILES_PER_ROW = 27;  // Allsky.jpg 中每行排列的瓦片数

class AladinWX {
  /**
   * @param {Object} canvasNode  wx.createSelectorQuery().fields({node:true}) 得到的 Canvas 节点
   * @param {number} width       逻辑像素宽度
   * @param {number} height      逻辑像素高度
   * @param {Object} options
   */
  constructor(canvasNode, width, height, options = {}) {
    this.canvas = canvasNode;
    this.ctx    = canvasNode.getContext('2d');
    this.width  = width;
    this.height = height;

    // 设置 Canvas 物理尺寸（不乘 DPR，避免 setTransform 混乱）
    canvasNode.width  = width;
    canvasNode.height = height;

    // 视图状态
    this.ra  = options.ra  !== undefined ? options.ra  : 0;
    this.dec = options.dec !== undefined ? options.dec : 0;
    this.fov = options.fov !== undefined ? options.fov : 60;

    // 功能开关
    this.showGrid = options.showGrid || false;

    // 事件
    this._listeners = {};

    // 瓦片缓存（URL → Canvas Image 对象）
    this._tileCache    = new Map();
    this._loadingTiles = new Map();

    // Survey URL（末尾不带斜杠）
    this._survey = (options.survey || 'https://alasky.cds.unistra.fr/DSS/DSSColor').replace(/\/$/, '');

    // Allsky 低分辨率背景图（加载完成前为 null）
    this._allskyImg = null;

    // 渲染节流
    this._renderRequested = false;

    // 触摸状态
    this._touch = null;

    // 渲染后回调（外部可注入，用于在星图上叠加自定义内容）
    this.onAfterRender = null;

    // 预加载 Allsky 背景，加载成功后触发一次重渲染
    this._loadAllsky();

    // 初始化并渲染
    this._scheduleRender();

    // 通知外部就绪
    setTimeout(() => this._emit('ready', {}), 0);
  }

  // ─────────────────────────────────────────────────────────────────
  //  公开 API
  // ─────────────────────────────────────────────────────────────────

  gotoRaDec(ra, dec, fov) {
    this.ra  = ((ra % 360) + 360) % 360;
    this.dec = Math.max(-90, Math.min(90, dec));
    if (fov !== undefined) this.fov = Math.max(0.1, Math.min(180, fov));
    this._scheduleRender();
    this._emit('positionChanged', { ra: this.ra, dec: this.dec, fov: this.fov });
  }

  setFov(fov) {
    this.fov = Math.max(0.1, Math.min(180, fov));
    this._scheduleRender();
    this._emit('positionChanged', { ra: this.ra, dec: this.dec, fov: this.fov });
  }

  /** 赤道坐标 → 画布像素；visible=false 表示在背半球，坐标仍然返回（供裁剪使用） */
  world2pix(ra, dec) {
    const fl = this._focalLength();
    const p  = FixedHealpix.project(this.ra, this.dec, ra, dec);
    return {
      x: this.width  / 2 + p.x * fl,
      y: this.height / 2 + p.y * fl,
      visible: p.visible,
    };
  }

  /** 画布像素 → 赤道坐标 */
  pix2world(x, y) {
    const fl = this._focalLength();
    return FixedHealpix.unproject(
      this.ra, this.dec,
      (x - this.width  / 2) / fl,
      (y - this.height / 2) / fl,
    );
  }

  on(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
    return this;
  }

  off(event, handler) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(h => h !== handler);
  }

  dispose() {
    // 将 ctx 置空：_render() 开头检测 if (!ctx) return，
    // 可终止所有尚在 Promise 微任务队列中的待执行渲染，避免覆盖主画布内容
    this.ctx = null;
    this._allskyImg = null;
    this._tileCache.clear();
    this._loadingTiles.clear();
    this.onAfterRender = null;
  }

  // ─────────────────────────────────────────────────────────────────
  //  触摸处理（由页面转发）
  // ─────────────────────────────────────────────────────────────────

  onTouchStart(e) {
    const touches = e.touches;
    if (touches.length === 1) {
      this._touch = {
        type: 'pan',
        x: touches[0].clientX,
        y: touches[0].clientY,
        ra: this.ra,
        dec: this.dec,
      };
    } else if (touches.length === 2) {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      this._touch = {
        type: 'pinch',
        dist: Math.sqrt(dx * dx + dy * dy),
        fov: this.fov,
      };
    }
  }

  onTouchMove(e) {
    if (!this._touch) return;
    const touches = e.touches;

    if (this._touch.type === 'pan' && touches.length === 1) {
      const dx = touches[0].clientX - this._touch.x;
      const dy = touches[0].clientY - this._touch.y;
      const fl   = this._focalLength();
      // dx 向右 → RA 增大（视图向东平移，星场跟随手指向右）
      // dy 向下 → Dec 增大（视图向北平移，星场跟随手指向下）
      const dra  =  dx / fl * (180 / Math.PI) / Math.cos(FixedHealpix.deg2rad(this._touch.dec));
      const ddec =  dy / fl * (180 / Math.PI);
      this.ra  = ((this._touch.ra  + dra + 360) % 360);
      this.dec = Math.max(-90, Math.min(90, this._touch.dec + ddec));
      this._scheduleRender();

    } else if (this._touch.type === 'pinch' && touches.length === 2) {
      const dx   = touches[0].clientX - touches[1].clientX;
      const dy   = touches[0].clientY - touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const ratio = this._touch.dist / Math.max(dist, 1);
      this.fov = Math.max(0.1, Math.min(180, this._touch.fov * ratio));
      this._scheduleRender();
    }
  }

  onTouchEnd() {
    if (this._touch) {
      this._touch = null;
      this._emit('positionChanged', { ra: this.ra, dec: this.dec, fov: this.fov });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  //  内部渲染
  // ─────────────────────────────────────────────────────────────────

  _scheduleRender() {
    if (this._renderRequested) return;
    this._renderRequested = true;
    // 下一帧渲染（避免连续触摸时多次 await）
    Promise.resolve().then(() => {
      this._renderRequested = false;
      this._render();
    });
  }

  async _render() {
    const ctx = this.ctx;
    if (!ctx) return;

    // 清空背景
    ctx.fillStyle = '#000510';
    ctx.fillRect(0, 0, this.width, this.height);

    // Allsky 低分辨率背景（瓦片加载前呈现模糊星空，避免黑屏）
    this._renderAllsky(ctx);

    // 渲染星图瓦片（高分辨率，覆盖在 Allsky 之上）
    await this._renderTiles(ctx);

    // 可选：坐标网格
    if (this.showGrid) this._renderGrid(ctx);

    // 渲染后回调（例如：叠加 AstroBin 参考图像）
    if (typeof this.onAfterRender === 'function') this.onAfterRender(ctx);
  }

  async _renderTiles(ctx) {
    const order = this._calcOrder();
    const hp    = new FixedHealpix(order);

    // 计算可见像素列表
    const pixels = this._getVisiblePixels(hp);
    if (pixels.length === 0) return;

    this._emit('tilesLoading', { count: pixels.length });

    // 并发加载瓦片（最多同时 6 个）
    const BATCH = 6;
    const results = [];
    for (let i = 0; i < pixels.length; i += BATCH) {
      const batch = pixels.slice(i, i + BATCH).map(pix => this._loadTile(pix, order));
      results.push(...await Promise.allSettled(batch));
    }

    // 顶点焊接：确保相邻瓦片的共享顶点使用完全相同的屏幕坐标
    // 使用空间哈希来合并相近的顶点（容差 0.001 度 ≈ 3.6 角秒）
    const vertexCache = new Map();
    const TOLERANCE_DEG = 0.001; // 约 3.6 角秒的容差
    let cacheHits = 0;
    let cacheMisses = 0;
    
    const findOrCreatePixel = (ra, dec) => {
      // 空间哈希：将坐标量化为网格单元
      const gridSize = TOLERANCE_DEG;
      const gridRa = Math.floor(ra / gridSize);
      const gridDec = Math.floor(dec / gridSize);
      
      // 检查 3x3 邻域内的所有单元
      for (let dra = -1; dra <= 1; dra++) {
        for (let ddec = -1; ddec <= 1; ddec++) {
          const key = `${gridRa + dra},${gridDec + ddec}`;
          if (vertexCache.has(key)) {
            const cached = vertexCache.get(key);
            // 精确检查距离
            let dRa = Math.abs(cached.ra - ra);
            if (dRa > 180) dRa = 360 - dRa; // 处理 RA 的 0/360 环绕
            const dDec = Math.abs(cached.dec - dec);
            if (dRa < TOLERANCE_DEG && dDec < TOLERANCE_DEG) {
              cacheHits++;
              if (this._debugTiles && cacheHits <= 20) {
                console.log(`[VertexCache] Hit! RA=${ra.toFixed(6)}, Dec=${dec.toFixed(6)}, dRA=${dRa.toFixed(6)}, dDec=${dDec.toFixed(6)}`);
              }
              return cached.pixel;
            }
          }
        }
      }
      
      // 未找到，创建新条目
      cacheMisses++;
      const pixel = this.world2pix(ra, dec);
      const key = `${gridRa},${gridDec}`;
      vertexCache.set(key, { ra, dec, pixel });
      if (this._debugTiles && cacheMisses <= 20) {
        console.log(`[VertexCache] Miss. RA=${ra.toFixed(6)}, Dec=${dec.toFixed(6)}, cache size=${vertexCache.size}`);
      }
      return pixel;
    };

    // 绘制已加载的瓦片
    for (let i = 0; i < pixels.length; i++) {
      const r = results[i];
      if (!r || r.status !== 'fulfilled' || !r.value) continue;
      const img      = r.value;
      const vertices = hp.getTileVertices(pixels[i]);
      const center   = hp.pix2ang(pixels[i]);
      
      // 使用空间哈希焊接顶点
      const cachedVertices = vertices.map(v => findOrCreatePixel(v.ra, v.dec));
      const cachedCenter = findOrCreatePixel(center.ra, center.dec);
      
      this._drawTileWithCachedCoords(ctx, img, cachedVertices, cachedCenter);
    }

    this._emit('tilesLoaded', {});
  }

  /**
   * 绘制单块瓦片（4 扇形三角形，以瓦片中心为公共顶点）
   *
   * HiPS 角点映射（image 坐标，u 向右 v 向下）：
   *   v[0]=South → (0,   0  )    center → (T/2, T/2)
   *   v[1]=East  → (0,   T  )
   *   v[2]=North → (T,   T  )
   *   v[3]=West  → (T,   0  )
   *
   * 将菱形瓦片拆成围绕中心的 4 个小三角形，消除原 2 三角形方案中
   * South→North 对角线两侧仿射变换不连续导致的可见缝隙（X 形痕迹）。
   */
  _drawTile(ctx, img, skyVertices, tileCenter) {
    const T = TILE_SIZE, H = T / 2;

    const c  = skyVertices.map(v => this.world2pix(v.ra, v.dec));
    if (c.every(p => !p.visible)) return;

    const cn = this.world2pix(tileCenter.ra, tileCenter.dec);
    const ok = p => p.visible;

    // S→E→C  image(0,0)→(0,T)→(T/2,T/2)
    if (ok(c[0]) && ok(c[1]) && ok(cn))
      this._drawTriangle(ctx, img,
        c[0].x, c[0].y,  c[1].x, c[1].y,  cn.x, cn.y,
        0, 0,             0, T,             H, H);

    // E→N→C  image(0,T)→(T,T)→(T/2,T/2)
    if (ok(c[1]) && ok(c[2]) && ok(cn))
      this._drawTriangle(ctx, img,
        c[1].x, c[1].y,  c[2].x, c[2].y,  cn.x, cn.y,
        0, T,             T, T,             H, H);

    // N→W→C  image(T,T)→(T,0)→(T/2,T/2)
    if (ok(c[2]) && ok(c[3]) && ok(cn))
      this._drawTriangle(ctx, img,
        c[2].x, c[2].y,  c[3].x, c[3].y,  cn.x, cn.y,
        T, T,             T, 0,             H, H);

    // W→S→C  image(T,0)→(0,0)→(T/2,T/2)
    if (ok(c[3]) && ok(c[0]) && ok(cn))
      this._drawTriangle(ctx, img,
        c[3].x, c[3].y,  c[0].x, c[0].y,  cn.x, cn.y,
        T, 0,             0, 0,             H, H);
  }

  /**
   * 使用预缓存的屏幕坐标绘制瓦片（4三角形方案 - 精确纹理映射）
   * cachedVertices: 已计算好的 world2pix 结果数组 [S, E, N, W]
   * cachedCenter: 已计算好的中心点 world2pix 结果
   */
  _drawTileWithCachedCoords(ctx, img, cachedVertices, cachedCenter) {
    const T = TILE_SIZE;
    const H = T / 2;
    
    if (cachedVertices.every(p => !p.visible)) return;
    
    const c = cachedVertices; // [S, E, N, W]
    const cn = cachedCenter;
    const ok = p => p.visible;

    // 4个三角形：S-E-C, E-N-C, N-W-C, W-S-C
    // 使用精确的纹理坐标，不进行任何扩展
    
    // S-E-C: South(0,0), East(0,T), Center(H,H)
    if (ok(c[0]) && ok(c[1]) && ok(cn)) {
      this._drawTriangle(ctx, img,
        c[0].x, c[0].y,  c[1].x, c[1].y,  cn.x, cn.y,
        0, 0,             0, T,             H, H);
    }
    
    // E-N-C: East(0,T), North(T,T), Center(H,H)
    if (ok(c[1]) && ok(c[2]) && ok(cn)) {
      this._drawTriangle(ctx, img,
        c[1].x, c[1].y,  c[2].x, c[2].y,  cn.x, cn.y,
        0, T,             T, T,             H, H);
    }
    
    // N-W-C: North(T,T), West(T,0), Center(H,H)
    if (ok(c[2]) && ok(c[3]) && ok(cn)) {
      this._drawTriangle(ctx, img,
        c[2].x, c[2].y,  c[3].x, c[3].y,  cn.x, cn.y,
        T, T,             T, 0,             H, H);
    }
    
    // W-S-C: West(T,0), South(0,0), Center(H,H)
    if (ok(c[3]) && ok(c[0]) && ok(cn)) {
      this._drawTriangle(ctx, img,
        c[3].x, c[3].y,  c[0].x, c[0].y,  cn.x, cn.y,
        T, 0,             0, 0,             H, H);
    }
    
    // 调试模式
    if (this._debugTiles) {
      this._drawTileDebug4(ctx, c, cn);
    }
  }
  
  /**
   * 8三角形调试绘制
   */
  _drawTileDebug8(ctx, vertices, center, mids) {
    const c = vertices;
    const cn = center;
    const m = mids;
    const ok = p => p && p.visible !== false;
    
    ctx.save();
    
    // 绘制瓦片外边框（菱形）
    ctx.strokeStyle = 'rgba(0, 255, 0, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (ok(c[0])) ctx.moveTo(c[0].x, c[0].y);
    if (ok(c[1])) ctx.lineTo(c[1].x, c[1].y);
    if (ok(c[2])) ctx.lineTo(c[2].x, c[2].y);
    if (ok(c[3])) ctx.lineTo(c[3].x, c[3].y);
    ctx.closePath();
    ctx.stroke();
    
    // 绘制中心到顶点的线（4条）
    ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
    ctx.lineWidth = 1;
    if (ok(cn)) {
      for (let i = 0; i < 4; i++) {
        if (ok(c[i])) {
          ctx.beginPath();
          ctx.moveTo(cn.x, cn.y);
          ctx.lineTo(c[i].x, c[i].y);
          ctx.stroke();
        }
      }
    }
    
    // 绘制中点（青色圆点）
    ctx.fillStyle = 'rgba(0, 255, 255, 0.8)';
    for (let i = 0; i < 4; i++) {
      if (ok(m[i])) {
        ctx.beginPath();
        ctx.arc(m[i].x, m[i].y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    
    ctx.restore();
  }
  
  /**
   * 4三角形调试绘制：显示菱形边框、中心点和顶点
   */
  _drawTileDebug4(ctx, vertices, center) {
    const c = vertices;
    const cn = center;
    const ok = p => p && p.visible !== false;
    
    ctx.save();
    
    // 绘制瓦片边框（菱形：S-E-N-W）
    ctx.strokeStyle = 'rgba(0, 255, 0, 0.8)'; // 绿色表示4三角形模式
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (ok(c[0])) ctx.moveTo(c[0].x, c[0].y);
    if (ok(c[1])) ctx.lineTo(c[1].x, c[1].y);
    if (ok(c[2])) ctx.lineTo(c[2].x, c[2].y);
    if (ok(c[3])) ctx.lineTo(c[3].x, c[3].y);
    ctx.closePath();
    ctx.stroke();
    
    // 绘制中心到各顶点的线（显示4个三角形划分）
    ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)'; // 红色
    ctx.lineWidth = 1;
    if (ok(cn)) {
      for (let i = 0; i < 4; i++) {
        if (ok(c[i])) {
          ctx.beginPath();
          ctx.moveTo(cn.x, cn.y);
          ctx.lineTo(c[i].x, c[i].y);
          ctx.stroke();
        }
      }
    }
    
    // 绘制顶点（黄色圆点）
    ctx.fillStyle = 'rgba(255, 255, 0, 0.8)';
    for (let i = 0; i < 4; i++) {
      if (ok(c[i])) {
        ctx.beginPath();
        ctx.arc(c[i].x, c[i].y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    
    // 绘制中心点（蓝色圆点）
    if (ok(cn)) {
      ctx.fillStyle = 'rgba(0, 0, 255, 0.8)';
      ctx.beginPath();
      ctx.arc(cn.x, cn.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    
    ctx.restore();
  }
  
  /**
   * 调试绘制：显示瓦片边框和顶点位置
   */
  _drawTileDebug(ctx, vertices) {
    const c = vertices;
    const ok = p => p && p.visible !== false;
    
    ctx.save();
    
    // 绘制瓦片边框（红色）
    ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ok(c[0])) ctx.moveTo(c[0].x, c[0].y);
    if (ok(c[1])) ctx.lineTo(c[1].x, c[1].y);
    if (ok(c[2])) ctx.lineTo(c[2].x, c[2].y);
    if (ok(c[3])) ctx.lineTo(c[3].x, c[3].y);
    ctx.closePath();
    ctx.stroke();
    
    // 绘制顶点（黄色圆点）
    ctx.fillStyle = 'rgba(255, 255, 0, 0.8)';
    for (let i = 0; i < 4; i++) {
      if (ok(c[i])) {
        ctx.beginPath();
        ctx.arc(c[i].x, c[i].y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    
    ctx.restore();
  }

  /**
   * 仿射纹理三角形渲染
   * (x0,y0),(x1,y1),(x2,y2) — 画布像素
   * (u0,v0),(u1,v1),(u2,v2) — 纹理像素
   *
   * 注意：setTransform 会替换当前整个 CTM，
   * 因此必须在没有 ctx.scale(dpr,dpr) 的情况下使用。
   */
  /**
   * 仿射纹理三角形渲染
   * (x0..x2, y0..y2) — 画布像素坐标
   * (u0..u2, v0..v2) — 纹理图像坐标（与 imgSz 同量纲）
   * imgSx/imgSy/imgSz — 可选，从 img 中截取的子区域（用于 Allsky 缩略图）；
   *                     默认截取整张图 (0, 0, TILE_SIZE)
   */
  _drawTriangle(ctx, img, x0, y0, x1, y1, x2, y2, u0, v0, u1, v1, u2, v2, imgSx, imgSy, imgSz) {
    imgSx = imgSx !== undefined ? imgSx : 0;
    imgSy = imgSy !== undefined ? imgSy : 0;
    imgSz = imgSz !== undefined ? imgSz : TILE_SIZE;

    const det = u0 * (v1 - v2) + u1 * (v2 - v0) + u2 * (v0 - v1);
    if (Math.abs(det) < 1e-6) return;

    const a = (x0 * (v1 - v2) + x1 * (v2 - v0) + x2 * (v0 - v1)) / det;
    const b = (y0 * (v1 - v2) + y1 * (v2 - v0) + y2 * (v0 - v1)) / det;
    const c = (u0 * (x1 - x2) + u1 * (x2 - x0) + u2 * (x0 - x1)) / det;
    const d = (u0 * (y1 - y2) + u1 * (y2 - y0) + u2 * (y0 - y1)) / det;
    const e = (x0 * (u1 * v2 - u2 * v1) + x1 * (u2 * v0 - u0 * v2) + x2 * (u0 * v1 - u1 * v0)) / det;
    const f = (y0 * (u1 * v2 - u2 * v1) + y1 * (u2 * v0 - u0 * v2) + y2 * (u0 * v1 - u1 * v0)) / det;

    ctx.save();
    
    // 抗接缝：将三角形向外扩展 1 像素（overdraw），覆盖相邻瓦片的接缝间隙
    // 计算三角形的中心
    const cx = (x0 + x1 + x2) / 3;
    const cy = (y0 + y1 + y2) / 3;
    
    // 将每个顶点向外推 3 像素（远离中心方向），增加overdraw覆盖接缝
    const extend = (px, py) => {
      const dx = px - cx;
      const dy = py - cy;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-6) return { x: px, y: py };
      return { x: px + (dx / len) * 3, y: py + (dy / len) * 3 };
    };
    
    const p0 = extend(x0, y0);
    const p1 = extend(x1, y1);
    const p2 = extend(x2, y2);
    
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.closePath();
    ctx.clip();
    ctx.setTransform(a, b, c, d, e, f);
    // 9-参数 drawImage：从 img 的 (imgSx,imgSy,imgSz,imgSz) 截取并绘制到图像坐标 (0,0,imgSz,imgSz)
    ctx.drawImage(img, imgSx, imgSy, imgSz, imgSz, 0, 0, imgSz, imgSz);
    ctx.restore();
  }

  // ─────────────────────────────────────────────────────────────────
  //  坐标网格
  // ─────────────────────────────────────────────────────────────────

  _renderGrid(ctx) {
    const step = this._gridStep();
    ctx.strokeStyle = 'rgba(100, 150, 255, 0.35)';
    ctx.lineWidth   = 1;

    const ra0  = Math.floor(this.ra  / step) * step - step * 2;
    const dec0 = Math.floor(this.dec / step) * step - step * 2;

    // 赤纬线（等 Dec 圈）
    for (let dec = dec0; dec <= dec0 + step * 6; dec += step) {
      if (dec < -90 || dec > 90) continue;
      this._drawRaLine(ctx, dec);
    }

    // 赤经线（等 RA 半圆）
    for (let ra = ra0; ra <= ra0 + step * 6; ra += step) {
      this._drawDecLine(ctx, ((ra % 360) + 360) % 360);
    }

    // ── 绘制赤经赤纬刻度标签 ──────────────────────────────────────────────
    this._drawGridLabels(ctx, step, ra0, dec0);
  }

  /**
   * 在网格线上绘制赤经赤纬刻度标签
   */
  _drawGridLabels(ctx, step, ra0, dec0) {
    ctx.save();
    ctx.font = '10px sans-serif';

    // ── 在赤纬线（等 Dec 圈）上标注赤纬值 ──────────────────────────────────
    for (let dec = dec0; dec <= dec0 + step * 6; dec += step) {
      if (dec < -90 || dec > 90) continue;
      const label = this._formatDecLabel(dec);
      // 取画布中心 RA 处的点来标注
      const p = this.world2pix(this.ra, dec);
      if (p.visible && p.x >= 0 && p.x <= this.width && p.y >= 0 && p.y <= this.height) {
        ctx.fillStyle = 'rgba(100, 150, 255, 0.7)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(label, p.x, p.y - 4);
      }
    }

    // ── 在赤经线（等 RA 半圆）上标注赤经值 ──────────────────────────────────
    for (let ra = ra0; ra <= ra0 + step * 6; ra += step) {
      const raNorm = ((ra % 360) + 360) % 360;
      const label = this._formatRaLabel(raNorm);
      // 取画布中心 Dec 处的点来标注
      const p = this.world2pix(raNorm, this.dec);
      if (p.visible && p.x >= 0 && p.x <= this.width && p.y >= 0 && p.y <= this.height) {
        ctx.fillStyle = 'rgba(100, 150, 255, 0.7)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, p.x + 4, p.y);
      }
    }

    ctx.restore();
  }

  /**
   * 格式化赤纬标签（如 +30°, -15°）
   */
  _formatDecLabel(dec) {
    const sign = dec >= 0 ? '+' : '-';
    const abs = Math.abs(dec);
    const d = Math.floor(abs);
    const m = Math.round((abs - d) * 60);
    if (m === 0) return `${sign}${d}°`;
    return `${sign}${d}°${m}'`;
  }

  /**
   * 格式化赤经标签（如 12h, 18h）
   */
  _formatRaLabel(ra) {
    const hours = ra / 15;
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    if (m === 0) return `${h}h`;
    return `${h}h${m}m`;
  }

  _drawRaLine(ctx, dec) {
    const STEPS = 60;
    let started = false;
    ctx.beginPath();
    for (let i = 0; i <= STEPS; i++) {
      const ra = this.ra - this.fov * 1.5 + (i / STEPS) * this.fov * 3;
      const p  = this.world2pix(ra, dec);
      if (!p.visible) { started = false; continue; }
      if (!started) { ctx.moveTo(p.x, p.y); started = true; }
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  _drawDecLine(ctx, ra) {
    const STEPS = 60;
    let started = false;
    ctx.beginPath();
    for (let i = 0; i <= STEPS; i++) {
      const dec = -90 + (i / STEPS) * 180;
      const p   = this.world2pix(ra, dec);
      if (!p.visible) { started = false; continue; }
      if (!started) { ctx.moveTo(p.x, p.y); started = true; }
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  _gridStep() {
    if (this.fov > 90) return 30;
    if (this.fov > 45) return 15;
    if (this.fov > 15) return 10;
    if (this.fov >  5) return  5;
    if (this.fov >  1) return  1;
    return 0.5;
  }

  // ─────────────────────────────────────────────────────────────────
  //  Allsky 低分辨率背景
  // ─────────────────────────────────────────────────────────────────

  /** 异步下载 Allsky.jpg；完成后触发一次重渲染以显示模糊背景 */
  _loadAllsky() {
    const url = `${this._survey}/Norder${ALLSKY_ORDER}/Allsky.jpg`;
    this._fetchTile(url).then(img => {
      if (!this.ctx) return; // 已 dispose
      this._allskyImg = img;
      this._scheduleRender();
    }).catch(() => {
      // 加载失败时静默忽略，保持黑色背景
    });
  }

  /** 同步渲染 Allsky 低分辨率背景（在高分辨率瓦片加载前呈现模糊星空） */
  _renderAllsky(ctx) {
    if (!this._allskyImg) return;
    const hp3    = new FixedHealpix(ALLSKY_ORDER);
    const pixels = this._getVisiblePixels(hp3);
    for (const ipix of pixels) {
      const vertices = hp3.getTileVertices(ipix);
      const center   = hp3.pix2ang(ipix);
      const col = ipix % ALLSKY_TILES_PER_ROW;
      const row = Math.floor(ipix / ALLSKY_TILES_PER_ROW);
      this._drawAllskyTile(ctx, ipix, vertices, center, col * ALLSKY_THUMB, row * ALLSKY_THUMB);
    }
  }

  /**
   * 绘制单张 Allsky 缩略图，复用 4 扇形三角形方法
   * imgSx/imgSy: 缩略图在 Allsky.jpg 中的左上角坐标
   */
  _drawAllskyTile(ctx, ipix, skyVertices, tileCenter, imgSx, imgSy) {
    const T = ALLSKY_THUMB, H = T / 2;
    const c  = skyVertices.map(v => this.world2pix(v.ra, v.dec));
    if (c.every(p => !p.visible)) return;
    const cn = this.world2pix(tileCenter.ra, tileCenter.dec);
    const ok = p => p.visible;

    if (ok(c[0]) && ok(c[1]) && ok(cn))
      this._drawTriangle(ctx, this._allskyImg,
        c[0].x, c[0].y, c[1].x, c[1].y, cn.x, cn.y,
        0, 0,           0, T,            H, H,
        imgSx, imgSy, T);
    if (ok(c[1]) && ok(c[2]) && ok(cn))
      this._drawTriangle(ctx, this._allskyImg,
        c[1].x, c[1].y, c[2].x, c[2].y, cn.x, cn.y,
        0, T,           T, T,            H, H,
        imgSx, imgSy, T);
    if (ok(c[2]) && ok(c[3]) && ok(cn))
      this._drawTriangle(ctx, this._allskyImg,
        c[2].x, c[2].y, c[3].x, c[3].y, cn.x, cn.y,
        T, T,           T, 0,            H, H,
        imgSx, imgSy, T);
    if (ok(c[3]) && ok(c[0]) && ok(cn))
      this._drawTriangle(ctx, this._allskyImg,
        c[3].x, c[3].y, c[0].x, c[0].y, cn.x, cn.y,
        T, 0,           0, 0,            H, H,
        imgSx, imgSy, T);
  }

  // ─────────────────────────────────────────────────────────────────
  //  瓦片加载
  // ─────────────────────────────────────────────────────────────────

  async _loadTile(pix, order) {
    const key = `${order}/${pix}`;
    if (this._tileCache.has(key)) return this._tileCache.get(key);
    if (this._loadingTiles.has(key)) return this._loadingTiles.get(key);

    const url     = this._tileUrl(pix, order);
    const promise = this._fetchTile(url);
    this._loadingTiles.set(key, promise);
    try {
      const img = await promise;
      this._tileCache.set(key, img);
      return img;
    } catch (e) {
      console.warn(`[StarMap] 瓦片加载失败: ${url}`, e.message);
      return null;
    } finally {
      this._loadingTiles.delete(key);
    }
  }

  _fetchTile(url) {
    return new Promise((resolve, reject) => {
      wx.downloadFile({
        url,
        timeout: 15000,
        success: (res) => {
          if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
          const img  = this.canvas.createImage();
          img.onload = () => resolve(img);
          img.onerror = (err) => reject(new Error(`Image load failed: ${JSON.stringify(err)}`));
          img.src = res.tempFilePath;
        },
        fail: (err) => reject(new Error(err.errMsg || 'downloadFile failed')),
      });
    });
  }

  _tileUrl(pix, order) {
    const dir = Math.floor(pix / 10000) * 10000;
    return `${this._survey}/Norder${order}/Dir${dir}/Npix${pix}.jpg`;
  }

  // ─────────────────────────────────────────────────────────────────
  //  HEALPix 工具
  // ─────────────────────────────────────────────────────────────────

  /** 根据 FOV 选择合适的 HEALPix order（少瓦片策略：减少拼接缝）
   *  公式 -1 使瓦片数约为原来的 1/4，视场内通常保持 6–12 块瓦片
   *  FOV 60° → order 1, FOV 10° → order 3, FOV 5° → order 4, FOV 1° → order 6
   */
  _calcOrder() {
    const o = Math.round(Math.log2(180 / this.fov) - 1);
    return Math.max(1, Math.min(9, o));
  }

  _focalLength() {
    return this.width / (2 * Math.sin(FixedHealpix.deg2rad(this.fov / 2)));
  }

  /** 采样屏幕像素反投影，找出视场内所有 HEALPix 瓦片 */
  _getVisiblePixels(hp) {
    const fl   = this._focalLength();
    const step = Math.max(15, Math.min(35, Math.min(this.width, this.height) / 12));

    // 底部额外扩展一个瓦片高度：由于 correctedDec 将 Aladin 中心北移，
    // canvas 底部对应的天区可能刚好落在瓦片南缘附近，标准步进会漏检。
    // 用实际 nside 和焦距计算一个瓦片的像素高度作为额外采样范围。
    const tileDeg    = 180 / Math.sqrt(12 * hp.nside * hp.nside);
    const tilePixels = Math.ceil(tileDeg * (Math.PI / 180) * fl);

    // 始终包含中心像素，确保至少有一块瓦片
    const seen = new Set();
    try { seen.add(hp.ang2pix(this.ra, this.dec)); } catch (_) {}

    for (let sx = -step; sx <= this.width + step; sx += step) {
      for (let sy = -step; sy <= this.height + step + tilePixels; sy += step) {
        const coords = FixedHealpix.unproject(
          this.ra, this.dec,
          (sx - this.width  / 2) / fl,
          (sy - this.height / 2) / fl,
        );
        if (!coords) continue;
        try {
          seen.add(hp.ang2pix(coords.ra, coords.dec));
        } catch (_) { /* ignore boundary pixels */ }
      }
    }

    return Array.from(seen);
  }

  // ─────────────────────────────────────────────────────────────────
  //  事件系统
  // ─────────────────────────────────────────────────────────────────

  _emit(event, data) {
    const handlers = this._listeners[event];
    if (handlers) handlers.forEach(h => h({ ...data, aladin: this }));
  }
}

// ─── 工厂函数（向后兼容旧 aladin-test 页面的调用方式） ───────────────────────
const A = {
  aladin: (canvasNode, width, height, options) => new AladinWX(canvasNode, width, height, options),
};

module.exports = { AladinWX, A };
