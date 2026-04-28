// pages/aladin/aladin.js
const { AladinWX } = require('../../utils/aladin-adapter/Aladin.wx');

// ── 常用天体快捷目标 ──────────────────────────────────────────────────────────
const TARGETS = [
  { name: 'M31',  label: 'M31 仙女座',   ra: 10.68,   dec: 41.27,  fov: 5  },
  { name: 'M42',  label: 'M42 猎户',     ra: 83.82,   dec: -5.39,  fov: 3  },
  { name: 'M45',  label: 'M45 昴星团',   ra: 56.87,   dec: 24.12,  fov: 4  },
  { name: 'M51',  label: 'M51 涡状星系', ra: 202.47,  dec: 47.20,  fov: 1  },
  { name: 'M81',  label: 'M81 波德星系', ra: 148.89,  dec: 69.07,  fov: 2  },
  { name: 'GC',   label: '银河中心',     ra: 266.42,  dec: -29.0,  fov: 8  },
  { name: 'IC434',label: 'IC434 马头',   ra: 85.25,   dec: -2.46,  fov: 2  },
  { name: 'M101', label: 'M101 风车',    ra: 210.80,  dec: 54.35,  fov: 2  },
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
    ready:         false,
    tilesLoading:  false,
    canvasW:  375,
    canvasH:  667,
    ra:       '0.000',
    dec:      '0.000',
    fov:      '60.0',
    showGrid: false,
    survey:   'DSS',
    targets:  TARGETS,
    currentTarget: '',
    targetScrollX: 0,   // 目标列横向滚动偏移（px，≤0）
  },

  // ── 生命周期 ─────────────────────────────────────────────────────────────────

  onLoad(options) {
    // 画布充满整个屏幕；顶部栏/底部面板用 position:fixed 悬浮其上
    const sys    = wx.getSystemInfoSync();
    const canvasW = sys.windowWidth;
    const canvasH = sys.windowHeight;
    this.setData({ canvasW, canvasH });

    // 若从其它页面传入坐标，则记录初始目标
    this._initRa  = options.ra  !== undefined ? parseFloat(options.ra)  : 10.68;
    this._initDec = options.dec !== undefined ? parseFloat(options.dec) : 41.27;
    this._initFov = options.fov !== undefined ? parseFloat(options.fov) : 5;
  },

  onReady() {
    // onReady 保证 canvas 节点已渲染，可以安全获取 node
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
    if (this._aladin) {
      this._aladin.dispose();
      this._aladin = null;
    }
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
    this._aladin._debugTiles = false;  // 开启调试

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
    });

    this._aladin.on('tilesLoading', () => {
      this.setData({ tilesLoading: true });
    });

    this._aladin.on('tilesLoaded', () => {
      this.setData({ tilesLoading: false });
    });
  },

  // ── 触摸事件（直接转发给引擎）────────────────────────────────────────────────

  onTouchStart(e) { this._aladin && this._aladin.onTouchStart(e); },
  onTouchMove(e)  { this._aladin && this._aladin.onTouchMove(e);  },
  onTouchEnd(e)   { this._aladin && this._aladin.onTouchEnd(e);   },

  // ── 缩放 ─────────────────────────────────────────────────────────────────────

  zoomIn() {
    if (!this._aladin) return;
    this._aladin.setFov(this._aladin.fov * 0.6);
  },

  zoomOut() {
    if (!this._aladin) return;
    this._aladin.setFov(this._aladin.fov / 0.6);
  },

  resetFov() {
    if (!this._aladin) return;
    this._aladin.setFov(60);
  },

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
    this._aladin._survey   = SURVEYS[name].replace(/\/$/, '');
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
    // 每个按钮约 120px（包含 margin），8 个目标共 ~960px，减去可见区域
    const minX = Math.min(0, -(TARGETS.length * 120 - (this.data.canvasW - 32)));
    const x    = Math.min(0, Math.max(minX, this._tgtScrollX + dx));
    this.setData({ targetScrollX: x });
  },

  onTargetTouchEnd() {},
});
