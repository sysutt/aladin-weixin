/**
 * HEALPix多瓦片管理器 - 修复版
 * 基于Aladin Lite原始HEALPix算法修复
 */

// 从Aladin Lite原始代码中提取的核心HEALPix算法
class FixedHealpix {
  constructor(order) {
    this.order = order;
    this.nside = Math.pow(2, order);
    this.init();
  }

  // 初始化HEALPix参数（来自Aladin Lite的HealpixIndex.init）
  init() {
    const tabmax = 0x100;
    this.ctab = new Array(tabmax);
    this.utab = new Array(tabmax);
    
    for (let m = 0; m < 0x100; ++m) {
      this.ctab[m] = ((m & 0x1) | ((m & 0x2) << 7) | ((m & 0x4) >> 1) | ((m & 0x8) << 6) |
        ((m & 0x10) >> 2) | ((m & 0x20) << 5) | ((m & 0x40) >> 3) | ((m & 0x80) << 4));
      this.utab[m] = ((m & 0x1) | ((m & 0x2) << 1) | ((m & 0x4) << 2) | ((m & 0x8) << 3) |
        ((m & 0x10) << 4) | ((m & 0x20) << 5) | ((m & 0x40) << 6) | ((m & 0x80) << 7));
    }

    this.nl2 = 2 * this.nside;
    this.nl3 = 3 * this.nside;
    this.nl4 = 4 * this.nside;
    this.npface = this.nside * this.nside;
    this.ncap = 2 * this.nside * (this.nside - 1);
    this.npix = 12 * this.npface;
    this.fact2 = 4.0 / this.npix;
    this.fact1 = (this.nside << 1) * this.fact2;
  }

  // 角度转弧度
  static deg2rad(d) {
    return d * Math.PI / 180;
  }

  // 弧度转角度
  static rad2deg(r) {
    return r * 180 / Math.PI;
  }

  /**
   * 修复的ang2pix_nest算法（来自Aladin Lite）
   * 将赤道坐标(RA, Dec)转换为HEALPix像素索引
   */
  ang2pix(raDeg, decDeg) {
    // 将赤道坐标转换为球面坐标
    const theta = Math.PI / 2 - FixedHealpix.deg2rad(decDeg); // colatitude in [0, π]
    let phi = FixedHealpix.deg2rad(raDeg); // longitude in [0, 2π]
    
    // 规范化phi到[0, 2π]
    if (phi >= 2 * Math.PI) phi -= 2 * Math.PI;
    if (phi < 0) phi += 2 * Math.PI;
    
    // 检查输入范围
    if (theta > Math.PI || theta < 0) {
      throw new Error(`theta must be between 0 and π, got ${theta}`);
    }
    if (phi > 2 * Math.PI || phi < 0) {
      throw new Error(`phi must be between 0 and 2π, got ${phi}`);
    }

    const z = Math.cos(theta);
    const za = Math.abs(z);
    const tt = phi / (Math.PI / 2); // in [0,4]
    const Z0 = 2.0 / 3.0; // 赤道区域边界

    let ipix, face_num, ix, iy;

    if (za <= Z0) { // 赤道区域
      const temp1 = this.nside * (0.5 + tt);
      const temp2 = this.nside * (z * 0.75);

      const jp = Math.floor(temp1 - temp2);
      const jm = Math.floor(temp1 + temp2);

      const ifp = jp >> this.order; // in {0,4}
      const ifm = jm >> this.order;
      
      if (ifp === ifm) { // faces 4 to 7
        face_num = (ifp === 4) ? 4 : ifp + 4;
      } else if (ifp < ifm) { // (half-)faces 0 to 3
        face_num = ifp;
      } else { // (half-)faces 8 to 11
        face_num = ifm + 8;
      }

      ix = jm & (this.nside - 1);
      iy = this.nside - (jp & (this.nside - 1)) - 1;
    } else { // 极地区域
      const ntt = Math.floor(tt);
      const tp = tt - ntt;
      const tmp = this.nside * Math.sqrt(3.0 * (1.0 - za));

      let jp = Math.floor(tp * tmp);
      let jm = Math.floor((1.0 - tp) * tmp);
      
      // 限制范围
      const NS_MAX = 16384;
      jp = Math.min(NS_MAX - 1, jp);
      jm = Math.min(NS_MAX - 1, jm);

      if (z >= 0) { // 北极
        face_num = ntt; // in {0,3}
        ix = this.nside - jm - 1;
        iy = this.nside - jp - 1;
      } else { // 南极
        face_num = ntt + 8; // in {8,11}
        ix = jp;
        iy = jm;
      }
    }

    // 转换为nest格式的像素索引
    ipix = this.xyf2nest(ix, iy, face_num);
    return ipix;
  }

  /**
   * 修复的pix2ang_nest算法（来自Aladin Lite）
   * 将HEALPix像素索引转换为赤道坐标
   */
  pix2ang(pix) {
    if (pix < 0 || pix > this.npix - 1) {
      throw new Error(`ipix out of range: ${pix} not in [0, ${this.npix - 1}]`);
    }

    const x = this.nest2xyf(pix);
    const ix = x.ix;
    const iy = x.iy;
    const face_num = x.face_num;

    // HEALPix常量
    const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4];
    const JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];

    const jr = ((JRLL[face_num] << this.order)) - ix - iy - 1;
    let nr, z, kshift;

    if (jr < this.nside) { // 北极区域
      nr = jr;
      z = 1.0 - nr * nr * this.fact2;
      kshift = 0;
    } else if (jr > this.nl3) { // 南极区域
      nr = this.nl4 - jr;
      z = nr * nr * this.fact2 - 1.0;
      kshift = 0;
    } else { // 赤道区域
      nr = this.nside;
      z = (this.nl2 - jr) * this.fact1;
      kshift = (jr - this.nside) & 1;
    }

    const theta = Math.acos(z);

    // 计算phi坐标
    let jp = (JPLL[face_num] * nr + ix - iy + 1 + kshift) / 2;
    if (jp > this.nl4) jp -= this.nl4;
    if (jp < 1) jp += this.nl4;

    let phi = (jp - (kshift + 1) * 0.50) * (Math.PI / 2 / nr);

    // 转换为赤道坐标
    const ra = FixedHealpix.rad2deg(phi);
    const dec = 90 - FixedHealpix.rad2deg(theta);

    return { ra: (ra % 360 + 360) % 360, dec };
  }

  // 辅助函数：xyf到nest格式转换
  // 修复：使用标准位交织算法，不使用BigInt
  xyf2nest(ix, iy, face_num) {
    if (ix < 0 || ix >= this.nside || iy < 0 || iy >= this.nside) {
      throw new Error(`ix or iy out of range: ix=${ix}, iy=${iy}, nside=${this.nside}`);
    }
    if (face_num < 0 || face_num >= 12) {
      throw new Error(`face_num out of range: ${face_num}`);
    }
    
    let pix = 0;
    // 位交织：x的位放在偶数位置，y的位放在奇数位置
    for (let k = 0; k < this.order; k++) {
      pix |= ((ix >> k) & 1) << (2 * k);      // x的位在位置 0, 2, 4...
      pix |= ((iy >> k) & 1) << (2 * k + 1);  // y的位在位置 1, 3, 5...
    }
    
    // face_num放在最高位
    return pix + (face_num << (2 * this.order));
  }

  // 辅助函数：nest到xyf格式转换
  nest2xyf(ipix) {
    if (ipix < 0 || ipix >= this.npix) {
      throw new Error(`ipix out of range: ${ipix} not in [0, ${this.npix - 1}]`);
    }
    
    const face_num = ipix >> (2 * this.order);
    const pix = ipix & (this.npface - 1);
    
    let ix = 0;
    let iy = 0;
    
    // 反位交织
    for (let k = 0; k < this.order; k++) {
      ix |= ((pix >> (2 * k)) & 1) << k;
      iy |= ((pix >> (2 * k + 1)) & 1) << k;
    }

    return { ix, iy, face_num };
  }

  /**
   * 将局部坐标 (ix, iy) 和面编号转换为赤道坐标
   * ix, iy 可以是浮点数（用于计算顶点）
   * 采用标准 HEALPix 变换公式
   */
  _xyfToRaDec(ix, iy, face_num) {
    const nside = this.nside;
    const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4];
    const JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];

    // jr is the normalized ring index
    const jr = JRLL[face_num] * nside - ix - iy - 1;
    let nr, z, kshift;

    if (jr < nside) {
      nr = jr;
      z = 1.0 - nr * nr * this.fact2;
      kshift = 0;
    } else if (jr > 3 * nside) {
      nr = 4 * nside - jr;
      z = nr * nr * this.fact2 - 1.0;
      kshift = 0;
    } else {
      nr = nside;
      z = (2 * nside - jr) * this.fact1;
      kshift = (jr - nside) & 1;
    }

    if (nr === 0) {
      return { ra: (JPLL[face_num] * 45), dec: z > 0 ? 90 : -90 };
    }

    // jp is the normalized pixel index within the ring
    let jp = (JPLL[face_num] * nr + ix - iy + 1 + kshift) / 2;
    if (jp > 4 * nside) jp -= 4 * nside;
    if (jp < 1) jp += 4 * nside;

    const phi = (jp - (kshift + 1) * 0.5) * (Math.PI / (2 * nr));
    const theta = Math.acos(Math.max(-1, Math.min(1, z)));
    
    const ra = FixedHealpix.rad2deg(phi);
    const dec = 90 - FixedHealpix.rad2deg(theta);

    return { ra: (ra % 360 + 360) % 360, dec };
  }

  /**
   * 获取瓦片的4个顶点坐标（使用二级子像素法）
   *
   * 原方法 _xyfToRaDec(ix±1, iy±1, face) 在 HEALPix 极区/赤道带边界
   * （Dec≈±41.8°，z=2/3）处，kshift 不连续导致顶点 RA 偏差数度至数十度，
   * 投影后产生明显拉伸/错位（如 M31 场景中 Npix169 错误渲染问题）。
   *
   * 修复：改用二级孙像素中心代替顶点。在 NESTED 编码中，像素 p 的所有后代
   * 与 p 属于同一 HEALPix 面，故不存在跨面 kshift 跳变。
   * 在 4×4 孙像素格中，4 个顶点方向对应的孙像素索引为：
   *   South tip (ix=0,iy=0) → 局部索引 0
   *   East  tip (ix=3,iy=0) → 局部索引 5
   *   North tip (ix=3,iy=3) → 局部索引 15
   *   West  tip (ix=0,iy=3) → 局部索引 10
   * 全局孙像素索引 = ipix*16 + 局部索引（NESTED 中 << 4 等价于父像素×16）。
   */
  getTileVertices(ipix) {
    // 1) 瓦片中心（始终正确）
    const center = this.pix2ang(ipix);

    // 2) 四个顶点方向的二级孙像素中心
    //    4×4 格中各方向孙像素的局部 NESTED 索引：
    //      South (0,0)→0, East (3,0)→5, North (3,3)→15, West (0,3)→10
    const hp2  = new FixedHealpix(this.order + 2);
    const base = ipix * 16;
    const gS = hp2.pix2ang(base + 0);
    const gE = hp2.pix2ang(base + 5);
    const gN = hp2.pix2ang(base + 15);
    const gW = hp2.pix2ang(base + 10);

    // 3) 线性外推到真实顶点
    //    孙像素中心在细格中位于 (0.5, 0.5)，瓦片中心在 (2, 2)，
    //    真实角点在 (0, 0)。从中心到孙像素的向量乘以 4/3 即到达角点。
    const K = 4 / 3;
    const extrap = (g) => {
      let dra = g.ra - center.ra;
      if (dra >  180) dra -= 360;
      if (dra < -180) dra += 360;
      return {
        ra:  ((center.ra + dra * K) % 360 + 360) % 360,
        dec: Math.max(-90, Math.min(90, center.dec + (g.dec - center.dec) * K)),
      };
    };

    return [extrap(gS), extrap(gE), extrap(gN), extrap(gW)];
  }

  /**
   * 获取邻接像素（基于角距离）
   * 修复微信小程序中的错误邻接搜索
   */
  getNeighboringPixels(centerPix, gridSize = 3) {
    const centerCoords = this.pix2ang(centerPix);
    const tileSizeDeg = 180 / Math.sqrt(12 * this.nside * this.nside);
    
    // 增加搜索密度以确保不漏掉瓦片
    const step = tileSizeDeg * 0.5;
    const radius = tileSizeDeg * (gridSize / 2);
    
    const neighbors = new Set();
    neighbors.add(Number(centerPix));
    
    for (let dra = -radius; dra <= radius; dra += step) {
      for (let ddec = -radius; ddec <= radius; ddec += step) {
        const ra = (centerCoords.ra + dra + 360) % 360;
        const dec = Math.max(-90, Math.min(90, centerCoords.dec + ddec));
        try {
          neighbors.add(Number(this.ang2pix(ra, dec)));
        } catch (e) {}
      }
    }
    
    return Array.from(neighbors);
  }

  /**
   * SIN (Orthographic) 投影 - 修复X/Y轴方向
   * 调整：根据测试结果，需要取反Y轴以确保Dec大的点显示在上方
   */
  static project(centerRa, centerDec, ra, dec) {
    const r0 = FixedHealpix.deg2rad(centerDec);
    const a0 = FixedHealpix.deg2rad(centerRa);
    const r = FixedHealpix.deg2rad(dec);
    const a = FixedHealpix.deg2rad(ra);

    let da = a - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    
    const x = Math.cos(r) * Math.sin(da);
    const y = Math.cos(r0) * Math.sin(r) - Math.sin(r0) * Math.cos(r) * Math.cos(da);
    const cos_c = Math.sin(r0) * Math.sin(r) + Math.cos(r0) * Math.cos(r) * Math.cos(da);
    
    // X取反：East（RA增大）→ 屏幕向左（天文学东西方向惯例）
    // Y取反：North（Dec增大）→ 屏幕向上（y轴向下时需取反）
    return { x: -x, y: -y, visible: cos_c > 0 };
  }

  /**
   * SIN 逆投影 - 与project保持一致
   */
  static unproject(centerRa, centerDec, x, y) {
    // 修复：X和Y都取反，与project保持一致
    x = -x;
    y = -y;
    const r0 = FixedHealpix.deg2rad(centerDec);
    const a0 = FixedHealpix.deg2rad(centerRa);
    const rho = Math.sqrt(x * x + y * y);
    if (rho > 1.0) return null;
    const c = Math.asin(Math.min(1.0, rho));
    const sinc = Math.sin(c);
    const cosc = Math.cos(c);
    let dec, ra;
    if (rho === 0) {
      dec = r0;
      ra = a0;
    } else {
      dec = Math.asin(cosc * Math.sin(r0) + (y * sinc * Math.cos(r0)) / rho);
      ra = a0 + Math.atan2(x * sinc, rho * Math.cos(r0) * cosc - y * Math.sin(r0) * sinc);
    }
    return { ra: (FixedHealpix.rad2deg(ra) % 360 + 360) % 360, dec: FixedHealpix.rad2deg(dec) };
  }
}

class HEALPixTileManager {
  constructor(options = {}) {
    this.survey = options.survey || 'https://alasky.cds.unistra.fr/P/DSS2/color/';
    this.order = options.order !== undefined ? options.order : 4;
    this.nside = Math.pow(2, this.order);
    this.healpix = new FixedHealpix(this.order);
    this.canvasRenderer = options.canvasRenderer || null;
    this.tileCache = new Map();
    this.loadingTiles = new Map();
  }

  getVisiblePixels(centerRa, centerDec, fov, canvasWidth, canvasHeight) {
    const pixels = new Set();
    const fovRad = FixedHealpix.deg2rad(fov);
    // 使用精确的 SIN 投影焦距
    const focalLength = canvasWidth / (2 * Math.sin(fovRad / 2));
    const tileSizeDeg = this._getTileSizeDeg(this.order);
    const tileSizePx = (tileSizeDeg / fov) * canvasWidth;
    const sampleStep = Math.max(10, Math.min(40, tileSizePx / 3));

    for (let x = -sampleStep; x <= canvasWidth + sampleStep; x += sampleStep) {
      for (let y = -sampleStep; y <= canvasHeight + sampleStep; y += sampleStep) {
        const px = (x - canvasWidth / 2) / focalLength;
        // 修复：与calculateTileDisplayPosition保持一致
        const py = (y - canvasHeight / 2) / focalLength;
        const coords = FixedHealpix.unproject(centerRa, centerDec, px, py);
        if (coords) {
          try {
            const pix = this.healpix.ang2pix(coords.ra, coords.dec);
            pixels.add(Number(pix));
          } catch (e) {}
        }
      }
    }
    
    // 将Set转换为数组并排序
    const pixelArray = Array.from(pixels);
    
    // 按照Dec降序（北在上），RA升序（西在左）排序
    pixelArray.sort((a, b) => {
      const coordsA = this.healpix.pix2ang(a);
      const coordsB = this.healpix.pix2ang(b);
      
      // 首先按Dec排序（降序：北在上）
      if (Math.abs(coordsA.dec - coordsB.dec) > 0.1) {
        return coordsB.dec - coordsA.dec;
      }
      
      // 然后按RA排序（升序：西在左）
      // 处理RA环绕问题
      let raDiff = coordsA.ra - coordsB.ra;
      if (raDiff > 180) raDiff -= 360;
      if (raDiff < -180) raDiff += 360;
      return raDiff;
    });
    
    return pixelArray;
  }

  /**
   * 将像素转换为赤道坐标(RA, Dec)
   * 使用修复后的FixedHealpix算法
   */
  _pixelToRaDec(pix, order) {
    // 如果order不同，创建新的FixedHealpix实例
    let healpix = this.healpix;
    if (order !== this.order) {
      healpix = new FixedHealpix(order);
    }
    
    try {
      const result = healpix.pix2ang(pix);
      console.log(`[HEALPixTileManager] 像素${pix} (order=${order}) -> RA=${result.ra.toFixed(2)}°, Dec=${result.dec.toFixed(2)}°`);
      return result;
    } catch (error) {
      console.error(`_pixelToRaDec错误: ${error.message}, pix=${pix}, order=${order}`);
      // 返回默认值
      return { ra: 0, dec: 0 };
    }
  }

  /**
   * 将赤道坐标(RA, Dec)转换为像素
   * 使用修复后的FixedHealpix算法
   * 关键修复：确保坐标转换正确
   */
  _raDecToPixel(ra, dec, nside) {
    const order = Math.log2(nside);
    
    // 如果order不同，创建新的FixedHealpix实例
    let healpix = this.healpix;
    if (order !== this.order) {
      healpix = new FixedHealpix(order);
    }
    
    try {
      // 规范化坐标
      const normRa = ((ra % 360) + 360) % 360;
      const normDec = Math.max(-90, Math.min(90, dec));
      
      console.log(`[HEALPixTileManager._raDecToPixel] 输入: RA=${ra}°, Dec=${dec}°, nside=${nside}, order=${order}`);
      console.log(`[HEALPixTileManager._raDecToPixel] 规范化: RA=${normRa}°, Dec=${normDec}°`);
      
      const pix = healpix.ang2pix(normRa, normDec);
      
      // 验证转换结果
      const backCoords = healpix.pix2ang(pix);
      console.log(`[HEALPixTileManager._raDecToPixel] 结果: 像素${pix} -> RA=${backCoords.ra.toFixed(2)}°, Dec=${backCoords.dec.toFixed(2)}°`);
      
      // 检查转换是否合理
      const raDiff = Math.abs(backCoords.ra - normRa);
      const decDiff = Math.abs(backCoords.dec - normDec);
      const wrappedRaDiff = Math.min(raDiff, 360 - raDiff);
      
      if (wrappedRaDiff > 10 || decDiff > 10) {
        console.warn(`[HEALPixTileManager._raDecToPixel] 警告: 坐标转换误差较大! dRa=${wrappedRaDiff.toFixed(2)}°, dDec=${decDiff.toFixed(2)}°`);
      }
      
      return pix;
    } catch (error) {
      console.error(`_raDecToPixel错误: ${error.message}, ra=${ra}, dec=${dec}, nside=${nside}`);
      // 返回默认值
      return 0;
    }
  }

  /**
   * 加载瓦片，包含 order 以确保缓存正确
   */
  async loadTile(pix, order = null) {
    const tileOrder = order !== null ? order : this.order;
    const cacheKey = `${tileOrder}_${pix}`;

    if (this.tileCache.has(cacheKey)) {
      return this.tileCache.get(cacheKey);
    }

    if (this.loadingTiles.has(cacheKey)) {
      return this.loadingTiles.get(cacheKey);
    }

    const url = this._getTileUrl(pix, tileOrder);
    console.log(`[HEALPixTileManager] 加载瓦片: ${url}`);
    
    const promise = this._fetchTile(url);
    this.loadingTiles.set(cacheKey, promise);

    try {
      const texture = await promise;
      this.tileCache.set(cacheKey, texture);
      this.loadingTiles.delete(cacheKey);
      return texture;
    } catch (error) {
      this.loadingTiles.delete(cacheKey);
      throw error;
    }
  }

  /**
   * 批量加载瓦片
   * 关键：传递当前order参数，确保所有瓦片使用相同的order
   */
  async loadTiles(pixels, order = null) {
    const promises = pixels.map(pix => this.loadTile(pix, order));
    return Promise.all(promises);
  }

  /**
   * 获取瓦片URL
   * 使用HEALPix标准像素级瓦片格式
   * 关键：使用传入的order参数，而不是this.order
   */
  _getTileUrl(pix, order = null) {
    // 优先使用传入的order参数，如果没有则使用this.order
    const tileOrder = order !== null ? order : this.order;
    
    console.log(`[HEALPixTileManager._getTileUrl] pix=${pix}, this.order=${this.order}, 传入order=${order}, 使用order=${tileOrder}`);
    
    // 获取survey参数并进行标准化转换
    let surveyPath = this.survey;
    
    // 处理不同的survey格式
    if (surveyPath.startsWith('http')) {
      // 已经是完整URL，移除末尾斜杠
      surveyPath = surveyPath.endsWith('/') ? surveyPath.slice(0, -1) : surveyPath;
    } else {
      // 是简短的survey标记(如 P/DSS2/color)，需要转换为实际的服务器路径
      // P/DSS2/color -> DSS/DSSColor
      const surveyMapping = {
        'P/DSS2/color': 'DSS/DSSColor',
        'P/DSS': 'DSS/DSS2',
        'P/2MASS/color': 'skyview/2mass-j',
        // 添加更多映射规则...
      };
      
      surveyPath = surveyMapping[surveyPath] || surveyPath;
      
      // 添加基础URL
      const baseUrl = 'https://alasky.cds.unistra.fr/';
      surveyPath = `${baseUrl}${surveyPath}`;
    }
    
    // HEALPix标准像素级瓦片格式
    const dir = Math.floor(pix / 10000) * 10000;
    const tileUrl = `${surveyPath}/Norder${tileOrder}/Dir${dir}/Npix${pix}.jpg`;
    
    console.log(`[HEALPixTileManager._getTileUrl] 最终URL: ${tileUrl}`);
    return tileUrl;
  }

  /**
   * 从URL获取瓦片
   * 使用wx-canvas-adapter.js的loadTexture方法来加载纹理
   * 这样可以确保获得正确的Canvas 2D Image对象
   */
  async _fetchTile(url) {
    try {
      // 检查是否有canvasRenderer可用
      if (!this.canvasRenderer) {
        console.warn('HEALPixTileManager: 没有canvasRenderer，尝试直接下载文件');
        return await this._fetchTileFallback(url);
      }
      
      // 使用canvasRenderer的loadTexture方法加载纹理
      // 这会返回包含正确Image对象的纹理
      const texture = await this.canvasRenderer.loadTexture(url);
      
      if (texture && texture.image) {
        console.log(`瓦片加载成功: ${url}, 尺寸: ${texture.width}x${texture.height}`);
        return texture;
      } else {
        console.warn(`瓦片加载失败: ${url}，使用回退方案`);
        return await this._fetchTileFallback(url);
      }
    } catch (error) {
      console.error(`Failed to load tile ${url}:`, error);
      
      // 添加重试机制
      console.log(`尝试重新加载瓦片: ${url}`);
      try {
        // 等待1秒后重试
        await new Promise(resolve => setTimeout(resolve, 1000));
        return await this._fetchTile(url);
      } catch (retryError) {
        console.error(`瓦片重试加载失败: ${url}`, retryError);
        throw retryError;
      }
    }
  }

  /**
   * 回退方案：直接下载文件并创建Image对象
   * 当没有canvasRenderer可用时使用
   */
  async _fetchTileFallback(url) {
    try {
      // 使用wx.downloadFile下载文件到本地临时路径
      const downloadResult = await new Promise((resolve, reject) => {
        wx.downloadFile({
          url: url,
          success: (res) => {
            if (res.statusCode === 200) {
              resolve(res);
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          },
          fail: (err) => reject(err),
          timeout: 10000  // 增加超时时间到10秒
        });
      });

      const filePath = downloadResult.tempFilePath;
      
      // 尝试创建Canvas Image对象
      // 注意：这需要Canvas上下文，如果没有则返回简化对象
      if (typeof wx.createCanvasContext !== 'undefined') {
        try {
          // 尝试使用微信小程序的Canvas API创建Image
          const ctx = wx.createCanvasContext('aladin-canvas');
          const img = ctx.createImage();
          
          return new Promise((resolve, reject) => {
            // 检查是否是 http://tmp/ 格式的路径
            if (filePath.startsWith('http://tmp/')) {
              // 使用文件系统API读取为base64
              try {
                const fs = wx.getFileSystemManager();
                const fileData = fs.readFileSync(filePath, 'base64');
                const dataUrl = `data:image/jpeg;base64,${fileData}`;
                img.src = dataUrl;
              } catch (fsError) {
                console.error(`文件系统读取失败: ${url}`, fsError);
                reject(new Error(`图像加载失败: ${url}`));
                return;
              }
            } else {
              img.src = filePath;
            }
            
            img.onload = () => {
              console.log(`瓦片加载成功（回退方案）: ${url}, 尺寸: ${img.width}x${img.height}`);
              resolve({
                src: url,
                filePath: filePath,
                image: img,  // Canvas Image对象
                url: url,
                width: img.width || 512,
                height: img.height || 512,
                complete: true,
                loaded: true
              });
            };
            
            img.onerror = (err) => {
              console.error(`瓦片加载失败（回退方案）: ${url}`, err);
              reject(new Error(`图像加载失败: ${url}`));
            };
            
            // 设置超时
            setTimeout(() => {
              if (!img.complete) {
                console.warn(`瓦片加载超时（回退方案）: ${url}`);
                reject(new Error(`图像加载超时: ${url}`));
              }
            }, 10000);
          });
        } catch (ctxError) {
          console.warn(`无法创建Canvas上下文: ${ctxError.message}，使用简化对象`);
          // 继续使用简化对象
        }
      }
      
      // 如果无法创建Canvas Image对象，返回简化对象
      console.log(`瓦片加载成功（简化对象）: ${url}`);
      return {
        src: url,
        filePath: filePath,
        image: null,  // 没有Image对象
        url: url,
        width: 512,
        height: 512,
        complete: true,
        loaded: true
      };
      
    } catch (error) {
      console.error(`回退方案加载失败: ${url}`, error);
      throw error;
    }
  }

  /**
   * 清空缓存
   */
  clearCache() {
    this.tileCache.clear();
    this.loadingTiles.clear();
  }

  /**
   * 计算瓦片在canvas上的显示位置及其顶点
   * 修复：扩展瓦片边界以消除缝隙
   */
  calculateTileDisplayPosition(tilePix, centerRa, centerDec, canvasWidth, canvasHeight, fov) {
    const vertices = this.healpix.getTileVertices(tilePix);
    const fovRad = FixedHealpix.deg2rad(fov);
    const focalLength = canvasWidth / (2 * Math.sin(fovRad / 2));

    const projectedVertices = vertices.map(v => {
      const p = FixedHealpix.project(centerRa, centerDec, v.ra, v.dec);
      return {
        x: canvasWidth / 2 + p.x * focalLength,
        y: canvasHeight / 2 + p.y * focalLength,  // 修复：project已经取反Y，这里不再取反
        visible: p.visible
      };
    });

    if (projectedVertices.every(v => !v.visible)) return null;

    // 计算边界框
    const minX = Math.min(...projectedVertices.map(v => v.x));
    const maxX = Math.max(...projectedVertices.map(v => v.x));
    const minY = Math.min(...projectedVertices.map(v => v.y));
    const maxY = Math.max(...projectedVertices.map(v => v.y));
    
    // 扩展边界以消除缝隙（扩展1像素）
    const expandAmount = 1.0;
    const expandedMinX = minX - expandAmount;
    const expandedMaxX = maxX + expandAmount;
    const expandedMinY = minY - expandAmount;
    const expandedMaxY = maxY + expandAmount;
    
    // 创建扩展后的顶点（用于纹理映射）
    const expandedVertices = [
      { x: expandedMinX, y: expandedMinY }, // 左下
      { x: expandedMaxX, y: expandedMinY }, // 右下
      { x: expandedMaxX, y: expandedMaxY }, // 右上
      { x: expandedMinX, y: expandedMaxY }  // 左上
    ];

    return {
      vertices: projectedVertices, // 原始顶点（用于计算）
      expandedVertices: expandedVertices, // 扩展后的顶点（用于绘制）
      minX: expandedMinX,
      maxX: expandedMaxX,
      minY: expandedMinY,
      maxY: expandedMaxY
    };
  }

  _getTileSizeDeg(order) {
    const nside = Math.pow(2, order);
    return 180 / Math.sqrt(12 * nside * nside);
  }
}

module.exports = { HEALPixTileManager, FixedHealpix };
