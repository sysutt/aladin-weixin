/**
 * 星表叠加层（Catalog Overlay）
 *
 * 在 AladinWX 星图上渲染 SIMBAD / Gaia DR3 等天体目录数据，
 * 并管理视图改变时的自动刷新逻辑。
 *
 * 用法示例：
 *
 *   const { CatalogLayer } = require('./catalog-overlay');
 *
 *   // 创建 SIMBAD 图层
 *   const simbadLayer = new CatalogLayer('simbad', {
 *     name: 'SIMBAD',
 *     color: '#00ddff',
 *     sourceSize: 8,
 *     showLabels: false,
 *     typeColors: true,
 *     limit: 200
 *   });
 *   simbadLayer.attachTo(this._fovAladin);
 *   simbadLayer.onLoad = (sources, err) => {
 *     if (err) console.error(err);
 *     else this.setData({ simbadCount: sources.length });
 *   };
 *
 *   // 当视图更新时刷新
 *   simbadLayer.refresh(ra, dec, fovDeg);
 *
 *   // 切换可见性
 *   simbadLayer.setVisible(false);
 *
 *   // 查询某个天体并显示详情
 *   simbadLayer.hitTest(canvasX, canvasY, aladinWX, 10); // 返回最近天体或 null
 */

var tap = require('./tap-query');

// 球面大圆距离（度），用于后处理过滤 TAP 查询结果
function _angDist(ra1, dec1, ra2, dec2) {
  var d = Math.sin(dec1 * Math.PI / 180) * Math.sin(dec2 * Math.PI / 180)
        + Math.cos(dec1 * Math.PI / 180) * Math.cos(dec2 * Math.PI / 180)
          * Math.cos((ra2 - ra1) * Math.PI / 180);
  return Math.acos(Math.min(1, Math.max(-1, d))) * 180 / Math.PI;
}

// ─────────────────────────────────────────────────────────────────
// SIMBAD 类型 → 显示样式映射
// ─────────────────────────────────────────────────────────────────

var _typeStyle = {
  // 星系族
  'G':   { shape: 'rhomb',  color: '#5588ff' },
  'IG':  { shape: 'rhomb',  color: '#5588ff' },
  'GiC': { shape: 'rhomb',  color: '#5588ff' },
  'GiG': { shape: 'rhomb',  color: '#5588ff' },
  'AGN': { shape: 'rhomb',  color: '#aa66ff' },
  'Sy1': { shape: 'rhomb',  color: '#aa66ff' },
  'Sy2': { shape: 'rhomb',  color: '#aa66ff' },
  'BLL': { shape: 'rhomb',  color: '#cc44ff' },
  // 星云族
  'PN':  { shape: 'square', color: '#44ffaa' },
  'HII': { shape: 'square', color: '#ffaacc' },
  'Neb': { shape: 'square', color: '#aaffdd' },
  'EmN': { shape: 'square', color: '#ffccaa' },
  'RNe': { shape: 'square', color: '#ddffaa' },
  'SNR': { shape: 'square', color: '#ff4444' },
  // 星团族
  'GlC': { shape: 'circle', color: '#ffdd44' },
  'OCl': { shape: 'plus',   color: '#ddff44' },
  'OpC': { shape: 'plus',   color: '#ddff44' },
  'Cl*': { shape: 'plus',   color: '#ddff44' },
  // 恒星（默认）
  '_star': { shape: 'cross', color: '#ffffff' },
  // 未知
  '_default': { shape: 'cross', color: '#aaaaaa' }
};

function _getSimbadStyle(otype) {
  if (!otype) return _typeStyle['_default'];
  var t = otype.trim();
  if (_typeStyle[t]) return _typeStyle[t];
  // 粗分类：以常见前缀判断
  if (t.length >= 1) {
    if (t === 'G' || t[0] === 'G' && t.length <= 3) return _typeStyle['G'];
    if (t === 'GiG' || t === 'IG' || t === 'AGN') return _typeStyle['AGN'];
    if (t === 'PN' || t === 'HII' || t === 'Neb' || t === 'SNR') return _typeStyle[t] || _typeStyle['Neb'];
    if (t === 'GlC') return _typeStyle['GlC'];
    if (t === 'OpC' || t === 'Cl*' || t === 'OCl') return _typeStyle['OCl'];
    // 一般恒星类型（大多数包含 * 或以 * 结尾）
    if (t.indexOf('*') !== -1) return _typeStyle['_star'];
  }
  return _typeStyle['_default'];
}

// ─────────────────────────────────────────────────────────────────
// CatalogOverlay — 持有数据并负责 canvas 渲染
// ─────────────────────────────────────────────────────────────────

/**
 * @param {Object} options
 * @param {string}  options.name           - 图层名称
 * @param {string}  [options.color]        - 统一颜色（不按类型着色时使用）
 * @param {number}  [options.sourceSize=7] - 标记尺寸（像素）
 * @param {string}  [options.shape]        - 固定形状（null=按类型自动）
 * @param {boolean} [options.showLabels]   - 是否显示名称标签
 * @param {boolean} [options.typeColors]   - 是否按 SIMBAD 类型着色
 * @param {number}  [options.labelMinSize] - 视场角小于此值时才显示标签（度）
 */
function CatalogOverlay(options) {
  options = options || {};
  this.name        = options.name        || 'Catalog';
  this._color      = options.color       || '#00ddff';
  this.sourceSize  = options.sourceSize  || 7;
  this._shape      = options.shape       || null;
  this.showLabels  = options.showLabels  || false;
  this.typeColors  = options.typeColors  || false;
  this.labelMinSize = options.labelMinSize || 2;  // 视场 < 2° 才显示标签

  this.sources     = [];
  this.visible     = true;
  this._aladin     = null;
  this._prevHook   = null;
}

/**
 * 将此叠加层绑定到 AladinWX 实例。
 * 通过链式 onAfterRender 保留已有的回调。
 */
CatalogOverlay.prototype.attachTo = function(aladinWX) {
  this._aladin    = aladinWX;
  var prev        = aladinWX.onAfterRender;
  this._prevHook  = prev;
  var self        = this;
  aladinWX.onAfterRender = function(ctx) {
    if (prev && typeof prev === 'function') prev.call(this, ctx);
    if (self.visible && self.sources.length > 0) {
      self._render(ctx, aladinWX);
    }
  };
};

CatalogOverlay.prototype.setVisible = function(v) {
  this.visible = !!v;
  if (this._aladin) this._aladin._scheduleRender();
};

CatalogOverlay.prototype.clear = function() {
  this.sources = [];
  if (this._aladin) this._aladin._scheduleRender();
};

/** 替换整个数据集并重渲染 */
CatalogOverlay.prototype.replace = function(arr) {
  this.sources = (arr || []).filter(function(s) {
    return isFinite(s.ra) && isFinite(s.dec);
  });
  if (this._aladin) this._aladin._scheduleRender();
};

/** 追加数据 */
CatalogOverlay.prototype.addSources = function(arr) {
  var valid = (arr || []).filter(function(s) {
    return isFinite(s.ra) && isFinite(s.dec);
  });
  this.sources = this.sources.concat(valid);
  if (this._aladin) this._aladin._scheduleRender();
};

/**
 * 命中测试：在 canvas 坐标 (x, y) 附近 hitRadius 像素内查找最近天体。
 * @returns {Object|null} source 对象或 null
 */
CatalogOverlay.prototype.hitTest = function(x, y, aladinWX, hitRadius) {
  hitRadius = hitRadius || 10;
  var best = null, bestDist = Infinity;
  for (var i = 0; i < this.sources.length; i++) {
    var s = this.sources[i];
    var p = aladinWX.world2pix(s.ra, s.dec);
    if (!p.visible) continue;
    var dx = p.x - x, dy = p.y - y;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d < hitRadius && d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
};

CatalogOverlay.prototype._render = function(ctx, aladin) {
  var size    = this.sourceSize;
  var sources = this.sources;
  var showLbl = this.showLabels && aladin.fov <= this.labelMinSize;

  // 像素格去重：格子边长 = max(size*1.5, 6)，同格只画一个标记（选中天体豁免）
  var cellSz  = Math.max(size * 1.5, 6);
  var drawnCells = {};

  ctx.save();
  ctx.lineWidth = 1.2;

  for (var i = 0; i < sources.length; i++) {
    var s = sources[i];
    var p = aladin.world2pix(s.ra, s.dec);
    if (!p.visible) continue;
    if (p.x < -20 || p.x > aladin.width + 20 || p.y < -20 || p.y > aladin.height + 20) continue;

    if (!s._selected) {
      var cellKey = (Math.round(p.x / cellSz) | 0) + ',' + (Math.round(p.y / cellSz) | 0);
      if (drawnCells[cellKey]) continue;
      drawnCells[cellKey] = true;
    }

    var color = this._color;
    var shape = this._shape;

    if (this.typeColors && s.type) {
      var st = _getSimbadStyle(s.type);
      color  = st.color;
      if (!shape) shape = st.shape;
    }
    if (!shape) {
      shape = (s._catalog === 'gaia') ? 'circle' : 'cross';
    }

    // Gaia: 按星等调整标记大小（亮星更大）
    var drawSize = size;
    if (s._catalog === 'gaia' && s.mag != null) {
      var magScale = Math.max(0.5, Math.min(2.0, (14 - s.mag) * 0.2 + 1));
      drawSize = size * magScale;
    }

    if (s._selected) {
      // 选中状态：外圈高亮环 + 橙色标记
      ctx.strokeStyle = '#ff8c00';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, drawSize + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = '#ff8c00';
      this._drawMarker(ctx, p.x, p.y, shape, drawSize * 1.4);
    } else {
      ctx.strokeStyle = color;
      this._drawMarker(ctx, p.x, p.y, shape, drawSize);
    }

    if (showLbl && s.name) {
      var lbl = s.name.length > 16 ? s.name.slice(0, 15) + '…' : s.name;
      ctx.fillStyle   = color;
      ctx.font        = '9px sans-serif';
      ctx.textAlign   = 'left';
      ctx.globalAlpha = 0.8;
      ctx.fillText(lbl, p.x + drawSize * 0.7 + 2, p.y + 4);
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
};

CatalogOverlay.prototype._drawMarker = function(ctx, x, y, shape, size) {
  var h = size / 2;
  ctx.beginPath();
  switch (shape) {
    case 'circle':
      ctx.arc(x, y, h, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'cross':
      ctx.moveTo(x - h, y - h); ctx.lineTo(x + h, y + h);
      ctx.moveTo(x + h, y - h); ctx.lineTo(x - h, y + h);
      ctx.stroke();
      break;
    case 'plus':
      ctx.moveTo(x, y - h); ctx.lineTo(x, y + h);
      ctx.moveTo(x - h, y); ctx.lineTo(x + h, y);
      ctx.stroke();
      break;
    case 'square':
      ctx.strokeRect(x - h, y - h, size, size);
      break;
    case 'rhomb':
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h, y);
      ctx.lineTo(x, y + h);
      ctx.lineTo(x - h, y);
      ctx.closePath();
      ctx.stroke();
      break;
    default:
      ctx.moveTo(x - h, y - h); ctx.lineTo(x + h, y + h);
      ctx.moveTo(x + h, y - h); ctx.lineTo(x - h, y + h);
      ctx.stroke();
  }
};

// ─────────────────────────────────────────────────────────────────
// CatalogLayer — 管理查询生命周期（防抖 + 视图刷新）
// ─────────────────────────────────────────────────────────────────

/**
 * 封装一个完整的目录图层，包含：
 *   1. CatalogOverlay（渲染）
 *   2. 防抖自动刷新（视图移动后 600ms 重新查询）
 *   3. 重叠视图检测（视图变化量不足时跳过查询）
 *
 * @param {'simbad'|'gaia'} catalogType
 * @param {Object} options  同时作为 CatalogOverlay 和查询选项传入
 */
function CatalogLayer(catalogType, options) {
  options        = options || {};
  this.type      = catalogType;
  this.options   = options;
  this.overlay   = new CatalogOverlay(options);

  this._aladin        = null;
  this._loading       = false;
  this._debounceTimer = null;
  this._lastRa        = null;
  this._lastDec       = null;
  this._lastFov       = null;

  /** 查询完成后的回调：function(sources, error) */
  this.onLoad = null;
  /** 查询开始时的回调：function() */
  this.onLoadStart = null;
}

CatalogLayer.prototype.attachTo = function(aladinWX) {
  this._aladin = aladinWX;
  this.overlay.attachTo(aladinWX);
};

CatalogLayer.prototype.setVisible = function(v) {
  this.overlay.setVisible(v);
};

/** 清空数据 */
CatalogLayer.prototype.clear = function() {
  this.overlay.clear();
  this._lastRa = this._lastDec = this._lastFov = null;
};

/** 获取当前已加载的数据 */
Object.defineProperty(CatalogLayer.prototype, 'sources', {
  get: function() { return this.overlay.sources; }
});

/**
 * 请求刷新数据。内部带防抖（600ms）和视图变化检测。
 * 在 AladinWX 的 positionChanged 事件中调用此方法：
 *   aladin.on('positionChanged', (e) => layer.refresh(e.ra, e.dec, e.fov));
 *
 * @param {number} ra
 * @param {number} dec
 * @param {number} fov  视场角（度）
 * @param {boolean} [force=false]  强制刷新，跳过变化量检测
 */
CatalogLayer.prototype.refresh = function(ra, dec, fov, force) {
  // 如果视图变化量不超过上次 FOV 的 20%，跳过
  if (!force && this._lastFov != null) {
    var dRa  = Math.abs(ra  - this._lastRa);
    var dDec = Math.abs(dec - this._lastDec);
    var threshold = this._lastFov * 0.2;
    var fovChanged = Math.abs(fov - this._lastFov) / this._lastFov > 0.25;
    if (!fovChanged && dRa < threshold && dDec < threshold) return;
  }

  var self = this;
  clearTimeout(this._debounceTimer);
  this._debounceTimer = setTimeout(function() {
    self._doQuery(ra, dec, fov);
  }, 600);
};

CatalogLayer.prototype._doQuery = function(ra, dec, fov) {
  if (this._loading) return;
  this._loading = true;
  this._lastRa  = ra;
  this._lastDec = dec;
  this._lastFov = fov;

  if (typeof this.onLoadStart === 'function') this.onLoadStart();

  // 搜索半径 = FOV/2 × 1.2（留少量余量，避免边缘数据缺失）
  var radius = fov / 2 * 1.2;
  var opts   = Object.assign({}, this.options);

  var self = this;
  var promise = (this.type === 'simbad')
    ? tap.querySimbad(ra, dec, radius, opts)
    : tap.queryGaiaDR3(ra, dec, radius, opts);

  promise.then(function(sources) {
    self._loading = false;
    // 防御性过滤：剔除投影超出查询半径的天体（RA=0°/360° 边界处 TAP 服务可能
    // 将圆圈两侧都纳入结果，但旧查询缓存可能混入当前视场之外的天体）
    var maxDist = radius * 1.5;
    sources = sources.filter(function(s) {
      return _angDist(ra, dec, s.ra, s.dec) <= maxDist;
    });
    self.overlay.replace(sources);
    if (typeof self.onLoad === 'function') self.onLoad(sources, null);
  }).catch(function(err) {
    self._loading = false;
    if (typeof self.onLoad === 'function') self.onLoad([], err);
  });
};

/**
 * 命中测试（透传给 overlay）
 */
CatalogLayer.prototype.hitTest = function(x, y, hitRadius) {
  if (!this._aladin) return null;
  return this.overlay.hitTest(x, y, this._aladin, hitRadius);
};

// ─────────────────────────────────────────────────────────────────
// 工具：从 source 对象生成可读的详情文字
// ─────────────────────────────────────────────────────────────────

/**
 * 格式化单个天体的详细信息（用于弹窗/侧边栏显示）
 * @param {Object} source  标准化 source 对象
 * @returns {Object}  { title, lines: [{label, value}, ...] }
 */
function formatSourceDetail(source) {
  var lines = [];

  if (source.type)  lines.push({ label: '类型', value: source.type });
  lines.push({ label: '赤经', value: _fmtRa(source.ra) });
  lines.push({ label: '赤纬', value: _fmtDec(source.dec) });
  if (source.mag != null) lines.push({ label: '亮度', value: source.mag.toFixed(2) + ' mag' });

  if (source.parallax != null) {
    lines.push({ label: '视差', value: source.parallax.toFixed(3) + ' mas' });
    if (source.parallaxError != null) {
      lines.push({ label: '视差误差', value: '±' + source.parallaxError.toFixed(3) + ' mas' });
    }
    // 距离（仅视差 > 0 且信噪比 > 2 才计算）
    if (source.parallax > 0 && (!source.parallaxSnr || source.parallaxSnr > 2)) {
      var dist = tap.parallaxToDistance(source.parallax);
      if (dist) {
        lines.push({ label: '距离', value: dist.pc.toFixed(1) + ' pc ≈ ' + dist.ly.toFixed(1) + ' 光年' });
      }
    }
  }

  if (source.pmra != null && source.pmdec != null) {
    lines.push({
      label: '自行',
      value: 'μα=' + source.pmra.toFixed(2) + '  μδ=' + source.pmdec.toFixed(2) + ' mas/yr'
    });
  }

  return {
    title: source.name || '未知天体',
    lines: lines
  };
}

function _fmtRa(ra) {
  var h  = Math.floor(ra / 15);
  var rm = (ra / 15 - h) * 60;
  var m  = Math.floor(rm);
  var s  = (rm - m) * 60;
  return _pad(h) + 'h ' + _pad(m) + 'm ' + s.toFixed(2) + 's';
}

function _fmtDec(dec) {
  var sign = dec < 0 ? '-' : '+';
  var abs  = Math.abs(dec);
  var d    = Math.floor(abs);
  var dm   = (abs - d) * 60;
  var m    = Math.floor(dm);
  var s    = (dm - m) * 60;
  return sign + _pad(d) + '° ' + _pad(m) + "' " + s.toFixed(1) + '"';
}

function _pad(n) { return n < 10 ? '0' + n : '' + n; }

// ─────────────────────────────────────────────────────────────────
// 导出
// ─────────────────────────────────────────────────────────────────

module.exports = {
  CatalogOverlay:    CatalogOverlay,
  CatalogLayer:      CatalogLayer,
  formatSourceDetail: formatSourceDetail
};
