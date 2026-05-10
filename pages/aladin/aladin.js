// pages/aladin/aladin.js
const { AladinWX } = require('../../utils/aladin-adapter/Aladin.wx');
const { CatalogLayer, formatSourceDetail } = require('../../utils/aladin-adapter/catalog-overlay');

// ── 常用天体快捷目标 ──────────────────────────────────────────────────────────
const TARGETS = [
  { name: 'M31',   label: 'M31 仙女座',   ra: 10.68,  dec: 41.27,  fov: 5 },
  { name: 'M42',   label: 'M42 猎户',     ra: 83.82,  dec: -5.39,  fov: 3 },
  { name: 'M45',   label: 'M45 昴星团',   ra: 56.87,  dec: 24.12,  fov: 4 },
  { name: 'M51',   label: 'M51 涡状星系', ra: 202.47, dec: 47.20,  fov: 1 },
  { name: 'M81',   label: 'M81 波德星系', ra: 148.89, dec: 69.07,  fov: 2 },
  { name: 'GC',    label: '银河中心',     ra: 266.42, dec: -29.0,  fov: 8 },
  { name: 'IC434', label: 'IC434 马头',   ra: 85.25,  dec: -2.46,  fov: 2 },
  { name: 'M101',  label: 'M101 风车',    ra: 210.80, dec: 54.35,  fov: 2 },
];

// ── Survey 配置 ──────────────────────────────────────────────────────────────
const SURVEYS = {
  DSS:   'https://alasky.cds.unistra.fr/DSS/DSSColor',
  '2MASS':'https://alasky.cds.unistra.fr/2MASS/Color',
  SDSS:  'https://alasky.cds.unistra.fr/SDSS/DR9/color',
};

Page({
  // ── 数据 ────────────────────────────────────────────────────────────────────
  data: {
    ready:        false,
    tilesLoading: false,
    canvasW: 375,
    canvasH: 667,
    ra:       '0.000',
    dec:      '0.000',
    fov:      '60.0',
    showGrid: false,
    survey:   'DSS',
    targets:  TARGETS,
    currentTarget:  '',
    targetScrollX:  0,

    // ── 星表叠加层 ──
    catalogSimbadOn:    false,
    catalogGaiaOn:      false,
    catalogSimbadCount: 0,
    catalogGaiaCount:   0,
    catalogLoading:     false,
    showCatalogDetail:  false,
    catalogSourceDetail: null,
  },

  // ── 生命周期 ─────────────────────────────────────────────────────────────────

  onLoad(options) {
    const sys = wx.getSystemInfoSync();
    this.setData({ canvasW: sys.windowWidth, canvasH: sys.windowHeight });
    this._initRa  = options.ra  !== undefined ? parseFloat(options.ra)  : 10.68;
    this._initDec = options.dec !== undefined ? parseFloat(options.dec) : 41.27;
    this._initFov = options.fov !== undefined ? parseFloat(options.fov) : 5;
  },

  onReady() {
    const query = wx.createSelectorQuery().in(this);
    query.select('#starmap').fields({ node: true, size: true }).exec(res => {
      if (!res || !res[0] || !res[0].node) {
        wx.showToast({ title: '画布初始化失败', icon: 'none' });
        return;
      }
      const { node, width, height } = res[0];
      this._initAladin(node, width || this.data.canvasW, height || this.data.canvasH);
    });
  },

  onUnload() {
    if (this._aladin) { this._aladin.dispose(); this._aladin = null; }
    if (this._catalogSimbad) { this._catalogSimbad.clear(); this._catalogSimbad = null; }
    if (this._catalogGaia)   { this._catalogGaia.clear();   this._catalogGaia   = null; }
  },

  // ── 初始化星图引擎 ───────────────────────────────────────────────────────────

  _initAladin(node, w, h) {
    this._aladin = new AladinWX(node, w, h, {
      ra:       this._initRa,
      dec:      this._initDec,
      fov:      this._initFov,
      showGrid: this.data.showGrid,
      survey:   SURVEYS[this.data.survey],
    });

    this._initCatalogLayers();

    this._aladin.on('ready', () => {
      this.setData({
        ready: true,
        ra:  this._aladin.ra.toFixed(3),
        dec: this._aladin.dec.toFixed(3),
        fov: this._aladin.fov.toFixed(2),
      });
    });

    this._aladin.on('positionChanged', ({ ra, dec, fov }) => {
      this.setData({
        ra:  ra.toFixed(3),
        dec: dec.toFixed(3),
        fov: fov.toFixed(2),
      });
      // 仅在图层开启时刷新（带内部防抖）
      if (this._catalogSimbad && this.data.catalogSimbadOn) this._catalogSimbad.refresh(ra, dec, fov);
      if (this._catalogGaia   && this.data.catalogGaiaOn)   this._catalogGaia.refresh(ra, dec, fov);
    });

    this._aladin.on('tilesLoading', () => this.setData({ tilesLoading: true }));
    this._aladin.on('tilesLoaded',  () => this.setData({ tilesLoading: false }));
  },

  // ── 触摸事件 ────────────────────────────────────────────────────────────────

  onTouchStart(e) {
    this._aladin && this._aladin.onTouchStart(e);
    // 记录 tap 起始点（用于星表命中测试）
    if (e.touches && e.touches[0]) {
      this._tapStartX    = e.touches[0].x;
      this._tapStartY    = e.touches[0].y;
      this._tapStartTime = Date.now();
    }
  },
  onTouchMove(e) { this._aladin && this._aladin.onTouchMove(e); },
  onTouchEnd(e) {
    this._aladin && this._aladin.onTouchEnd(e);
    // 短触点（< 300ms，移动 < 10px）触发星表命中测试
    if (this._tapStartTime != null && Date.now() - this._tapStartTime < 300) {
      var t = e.changedTouches && e.changedTouches[0];
      if (t) {
        var dx = t.x - this._tapStartX, dy = t.y - this._tapStartY;
        if (dx * dx + dy * dy < 100) this._onCanvasTap(t.x, t.y);
      }
    }
    this._tapStartTime = null;
  },

  // ── 缩放 ─────────────────────────────────────────────────────────────────────

  zoomIn()  { this._aladin && this._aladin.setFov(this._aladin.fov * 0.6); },
  zoomOut() { this._aladin && this._aladin.setFov(this._aladin.fov / 0.6); },
  resetFov(){ this._aladin && this._aladin.setFov(60); },

  // ── 快捷目标跳转 ─────────────────────────────────────────────────────────────

  gotoTarget(e) {
    if (!this._aladin) return;
    const { ra, dec, fov, name } = e.currentTarget.dataset;
    this._aladin.gotoRaDec(parseFloat(ra), parseFloat(dec), parseFloat(fov));
    this.setData({ currentTarget: name });
  },

  // ── 网格切换 ─────────────────────────────────────────────────────────────────

  toggleGrid() {
    if (!this._aladin) return;
    const next = !this.data.showGrid;
    this._aladin.showGrid = next;
    this._aladin._scheduleRender();
    this.setData({ showGrid: next });
  },

  // ── Survey 切换 ──────────────────────────────────────────────────────────────

  _setSurvey(name) {
    if (!this._aladin) return;
    this._aladin._survey = SURVEYS[name].replace(/\/$/, '');
    this._aladin._tileCache.clear();
    this._aladin._loadingTiles.clear();
    this._aladin._scheduleRender();
    this.setData({ survey: name, currentTarget: '' });
  },
  surveyDSS()   { this._setSurvey('DSS');   },
  survey2MASS() { this._setSurvey('2MASS'); },
  surveySDSS()  { this._setSurvey('SDSS');  },

  // ── 目标列手动横向滚动 ───────────────────────────────────────────────────────

  onTargetTouchStart(e) {
    this._tgtTouchX  = e.touches[0].clientX;
    this._tgtScrollX = this.data.targetScrollX;
  },
  onTargetTouchMove(e) {
    const dx   = e.touches[0].clientX - this._tgtTouchX;
    const minX = Math.min(0, -(TARGETS.length * 120 - (this.data.canvasW - 32)));
    const x    = Math.min(0, Math.max(minX, this._tgtScrollX + dx));
    this.setData({ targetScrollX: x });
  },
  onTargetTouchEnd() {},

  // ══════════════════════════════════════════════════════════════════════════════
  //  星表叠加层（SIMBAD / Gaia DR3）
  // ══════════════════════════════════════════════════════════════════════════════

  _initCatalogLayers() {
    var that = this;

    // SIMBAD：按类型着色，不显示标签（通过点击详情面板查看）
    this._catalogSimbad = new CatalogLayer('simbad', {
      name: 'SIMBAD', typeColors: true, showLabels: false, sourceSize: 5, limit: 200,
    });
    this._catalogSimbad.onLoadStart = function() {
      that.setData({ catalogLoading: true });
    };
    this._catalogSimbad.onLoad = function(sources) {
      that.setData({ catalogLoading: false, catalogSimbadCount: sources.length });
      if (that._aladin) that._aladin._scheduleRender();
    };
    this._catalogSimbad._aladin = this._aladin;
    this._catalogSimbad.overlay._aladin = this._aladin;
    this._catalogSimbad.overlay.visible = false;  // 默认关闭

    // Gaia DR3：按星等调整大小，黄色统一配色
    this._catalogGaia = new CatalogLayer('gaia', {
      name: 'Gaia DR3', typeColors: false, sourceSize: 4, color: '#ffcc44', limit: 300,
    });
    this._catalogGaia.onLoad = function(sources) {
      that.setData({ catalogGaiaCount: sources.length });
      if (that._aladin) that._aladin._scheduleRender();
    };
    this._catalogGaia._aladin = this._aladin;
    this._catalogGaia.overlay._aladin = this._aladin;
    this._catalogGaia.overlay.visible = false;    // 默认关闭

    // 注册渲染钩子
    this._aladin.onAfterRender = (ctx) => { this._renderCatalogOverlays(ctx); };
  },

  _renderCatalogOverlays(ctx) {
    var aladin = this._aladin;
    if (!aladin) return;
    var ovS = this._catalogSimbad && this._catalogSimbad.overlay;
    if (ovS && ovS.visible && ovS.sources.length > 0) ovS._render(ctx, aladin);
    var ovG = this._catalogGaia && this._catalogGaia.overlay;
    if (ovG && ovG.visible && ovG.sources.length > 0) ovG._render(ctx, aladin);
  },

  toggleCatalogSimbad() {
    var next = !this.data.catalogSimbadOn;
    this.setData({ catalogSimbadOn: next });
    if (!this._catalogSimbad || !this._aladin) return;
    this._catalogSimbad.overlay.visible = next;
    if (next) {
      this._catalogSimbad.refresh(this._aladin.ra, this._aladin.dec, this._aladin.fov, true);
    } else {
      this._clearCatalogSelection();
      this._aladin._scheduleRender();
    }
  },

  toggleCatalogGaia() {
    var next = !this.data.catalogGaiaOn;
    this.setData({ catalogGaiaOn: next });
    if (!this._catalogGaia || !this._aladin) return;
    this._catalogGaia.overlay.visible = next;
    if (next) {
      this._catalogGaia.refresh(this._aladin.ra, this._aladin.dec, this._aladin.fov, true);
    } else {
      this._clearCatalogSelection();
      this._aladin._scheduleRender();
    }
  },

  _onCanvasTap(x, y) {
    if (!this._aladin) return;
    var hit = null;
    if (this._catalogSimbad && this.data.catalogSimbadOn) hit = this._catalogSimbad.hitTest(x, y, 14);
    if (!hit && this._catalogGaia && this.data.catalogGaiaOn) hit = this._catalogGaia.hitTest(x, y, 14);
    if (hit) {
      if (this._selectedSource) this._selectedSource._selected = false;
      hit._selected = true;
      this._selectedSource = hit;
      this.setData({ showCatalogDetail: true, catalogSourceDetail: formatSourceDetail(hit) });
      this._aladin._scheduleRender();
    } else if (this.data.showCatalogDetail) {
      this._clearCatalogSelection();
    }
  },

  _clearCatalogSelection() {
    if (this._selectedSource) {
      this._selectedSource._selected = false;
      this._selectedSource = null;
      if (this._aladin) this._aladin._scheduleRender();
    }
    this.setData({ showCatalogDetail: false, catalogSourceDetail: null });
  },

  closeCatalogDetail() { this._clearCatalogSelection(); },
});
