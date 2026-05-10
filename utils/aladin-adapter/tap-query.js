/**
 * TAP (Table Access Protocol) 查询工具
 *
 * 支持的数据源：
 *   - SIMBAD  (simbad.cds.unistra.fr)  : 天体分类、名称、视差
 *   - Gaia DR3 ESA   (gea.esac.esa.int): 官方 Gaia 存档，包含完整视差数据
 *   - Gaia DR3 VizieR (tapvizier.cds.unistra.fr): 备选，与 SIMBAD 同域
 *
 * 微信小程序合法域名需要添加：
 *   - simbad.cds.unistra.fr
 *   - gea.esac.esa.int           (若使用 ESA Gaia)
 *   - tapvizier.cds.unistra.fr   (若使用 VizieR Gaia，可与 SIMBAD 合并)
 *
 * 返回的标准化 source 对象格式：
 *   { ra, dec, name, type, mag, parallax, parallaxError, parallaxSnr, pmra, pmdec, _raw }
 */

const SIMBAD_TAP   = 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync';
const GAIA_ESA_TAP = 'https://gea.esac.esa.int/tap-server/tap/sync';
const GAIA_VIZ_TAP = 'https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync';

// ─────────────────────────────────────────────────────────────────
// 底层 TAP 请求
// ─────────────────────────────────────────────────────────────────

/**
 * 向 TAP 服务发起同步查询（GET），返回解析后的行数组。
 * 使用 FORMAT=json，响应格式：{ metadata:[{name,...},...], data:[[v,...],...] }
 */
function _fetchTAP(tapUrl, adql, timeoutMs) {
  timeoutMs = timeoutMs || 20000;
  return new Promise(function(resolve, reject) {
    wx.request({
      url: tapUrl,
      method: 'GET',
      dataType: '其他',   // 不让微信自动解析，手动处理
      responseType: 'text',
      timeout: timeoutMs,
      data: {
        REQUEST: 'doQuery',
        LANG: 'ADQL',
        FORMAT: 'json',
        QUERY: adql
      },
      success: function(res) {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('TAP HTTP ' + res.statusCode));
          return;
        }
        try {
          var raw = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
          resolve(_parseTAPJSON(raw));
        } catch (e) {
          reject(new Error('TAP JSON parse error: ' + e.message));
        }
      },
      fail: function(err) {
        reject(new Error('wx.request failed: ' + (err.errMsg || 'unknown')));
      }
    });
  });
}

/**
 * 解析标准 TAP JSON 格式，返回 [{fieldName: value, ...}, ...] 数组。
 */
function _parseTAPJSON(obj) {
  if (!obj || !Array.isArray(obj.metadata) || !Array.isArray(obj.data)) {
    throw new Error('Unexpected TAP response structure');
  }
  var fields = obj.metadata.map(function(m) { return m.name; });
  return obj.data.map(function(row) {
    var src = {};
    for (var i = 0; i < fields.length; i++) {
      src[fields[i]] = row[i];
    }
    return src;
  });
}

// ─────────────────────────────────────────────────────────────────
// SIMBAD 查询
// ─────────────────────────────────────────────────────────────────

/**
 * 从 SIMBAD 查询指定区域内的天体。
 *
 * @param {number} ra          中心赤经（度，ICRS）
 * @param {number} dec         中心赤纬（度，ICRS）
 * @param {number} radiusDeg   搜索半径（度）
 * @param {Object} [options]
 * @param {number}  [options.limit=300]          最大返回数量
 * @param {boolean} [options.includeParallax=true] 包含视差数据（需 JOIN）
 * @returns {Promise<Array>} 标准化 source 对象数组
 */
function querySimbad(ra, dec, radiusDeg, options) {
  options = options || {};
  var limit = options.limit || 300;

  // SIMBAD TAP 对 CIRCLE 查询有最大半径限制，超过约 10° 会返回 400。
  // basic 表自带 plx_value / plx_err，无需 JOIN plx 子表。
  var safeRadius = Math.min(radiusDeg, 10);

  var adql = [
    'SELECT TOP ' + limit,
    '  oid, main_id, ra, dec, otype,',
    '  plx_value, plx_err',
    'FROM basic',
    'WHERE CONTAINS(',
    "  POINT('ICRS', ra, dec),",
    "  CIRCLE('ICRS', " + ra + ', ' + dec + ', ' + safeRadius + ')',
    ') = 1',
    'AND ra IS NOT NULL',
    "AND coo_qual IN ('A', 'B', 'C')"
  ].join(' ');

  return _fetchTAP(SIMBAD_TAP, adql, options.timeout).then(function(rows) {
    return rows.map(function(r) {
      var plx   = r['plx_value'] != null ? parseFloat(r['plx_value']) : null;
      var e_plx = r['plx_err']   != null ? parseFloat(r['plx_err'])   : null;

      return {
        ra:             parseFloat(r['ra']),
        dec:            parseFloat(r['dec']),
        name:           r['main_id'] || '',
        type:           r['otype']   || '',
        mag:            null,
        parallax:       plx,
        parallaxError:  e_plx,
        parallaxSnr:    (plx != null && e_plx != null && e_plx > 0)
                          ? Math.abs(plx / e_plx) : null,
        pmra:           null,
        pmdec:          null,
        _catalog:       'simbad',
        _raw:           r
      };
    }).filter(function(s) { return isFinite(s.ra) && isFinite(s.dec); });
  });
}

// ─────────────────────────────────────────────────────────────────
// Gaia DR3 查询
// ─────────────────────────────────────────────────────────────────

/**
 * 从 Gaia DR3 查询指定区域内的恒星（含视差）。
 *
 * @param {number} ra         中心赤经（度）
 * @param {number} dec        中心赤纬（度）
 * @param {number} radiusDeg  搜索半径（度）
 * @param {Object} [options]
 * @param {number}  [options.limit=500]    最大返回数量
 * @param {number}  [options.magLimit]     最暗 G 星等（默认按视场大小自动确定）
 * @param {boolean} [options.useVizier=false] 使用 VizieR 而非 ESA 存档
 * @param {boolean} [options.requireParallax=false] 只返回有视差测量的天体
 * @returns {Promise<Array>} 标准化 source 对象数组（含 parallax, parallaxError）
 */
function queryGaiaDR3(ra, dec, radiusDeg, options) {
  options = options || {};
  var limit = options.limit || 500;
  // 根据视场大小自动确定星等限制（视场越大越只取亮星）
  var magLimit = options.magLimit || _autoMagLimit(radiusDeg * 2);
  var requirePlx = options.requireParallax || false;
  var useVizier = options.useVizier || false;

  if (useVizier) {
    return _queryGaiaVizier(ra, dec, radiusDeg, limit, magLimit, requirePlx, options.timeout);
  } else {
    return _queryGaiaESA(ra, dec, radiusDeg, limit, magLimit, requirePlx, options.timeout);
  }
}

function _autoMagLimit(fovDeg) {
  if (fovDeg > 10) return 9;
  if (fovDeg > 5)  return 11;
  if (fovDeg > 2)  return 13;
  if (fovDeg > 1)  return 15;
  if (fovDeg > 0.5) return 16;
  return 17;
}

function _queryGaiaESA(ra, dec, radiusDeg, limit, magLimit, requirePlx, timeout) {
  var plxFilter = requirePlx ? ' AND parallax IS NOT NULL' : '';
  var adql = [
    'SELECT TOP ' + limit,
    '  source_id, ra, dec, phot_g_mean_mag,',
    '  parallax, parallax_error, parallax_over_error,',
    '  pmra, pmdec',
    'FROM gaiadr3.gaia_source',
    'WHERE CONTAINS(',
    "  POINT('ICRS', ra, dec),",
    "  CIRCLE('ICRS', " + ra + ', ' + dec + ', ' + radiusDeg + ')',
    ') = 1',
    'AND phot_g_mean_mag < ' + magLimit,
    plxFilter,
    'ORDER BY phot_g_mean_mag ASC'
  ].join(' ');

  return _fetchTAP(GAIA_ESA_TAP, adql, timeout).then(_normalizeGaiaESA);
}

function _normalizeGaiaESA(rows) {
  return rows.map(function(r) {
    var plx    = r.parallax        != null ? parseFloat(r.parallax)        : null;
    var e_plx  = r.parallax_error  != null ? parseFloat(r.parallax_error)  : null;
    var snr    = r.parallax_over_error != null ? parseFloat(r.parallax_over_error) : null;
    return {
      ra:            parseFloat(r.ra),
      dec:           parseFloat(r.dec),
      name:          r.source_id ? ('Gaia DR3 ' + r.source_id) : '',
      type:          'Star',
      mag:           r.phot_g_mean_mag != null ? parseFloat(r.phot_g_mean_mag) : null,
      parallax:      plx,
      parallaxError: e_plx,
      parallaxSnr:   snr,
      pmra:          r.pmra  != null ? parseFloat(r.pmra)  : null,
      pmdec:         r.pmdec != null ? parseFloat(r.pmdec) : null,
      _catalog:      'gaia',
      _raw:          r
    };
  }).filter(function(s) { return isFinite(s.ra) && isFinite(s.dec); });
}

function _queryGaiaVizier(ra, dec, radiusDeg, limit, magLimit, requirePlx, timeout) {
  var plxFilter = requirePlx ? ' AND Plx IS NOT NULL' : '';
  // VizieR Gaia DR3 catalog: I/355/gaiadr3
  // 字段名与 ESA 不同：RA_ICRS, DE_ICRS, Gmag, Plx, e_Plx, pmRA, pmDE
  var adql = [
    'SELECT TOP ' + limit,
    '  RA_ICRS, DE_ICRS, Gmag, Plx, e_Plx, pmRA, pmDE',
    'FROM "I/355/gaiadr3"',
    'WHERE CONTAINS(',
    "  POINT('ICRS', RA_ICRS, DE_ICRS),",
    "  CIRCLE('ICRS', " + ra + ', ' + dec + ', ' + radiusDeg + ')',
    ') = 1',
    'AND Gmag < ' + magLimit,
    plxFilter,
    'ORDER BY Gmag ASC'
  ].join(' ');

  return _fetchTAP(GAIA_VIZ_TAP, adql, timeout).then(_normalizeGaiaVizier);
}

function _normalizeGaiaVizier(rows) {
  return rows.map(function(r) {
    var plx   = r['Plx']   != null ? parseFloat(r['Plx'])   : null;
    var e_plx = r['e_Plx'] != null ? parseFloat(r['e_Plx']) : null;
    return {
      ra:            parseFloat(r['RA_ICRS']),
      dec:           parseFloat(r['DE_ICRS']),
      name:          '',
      type:          'Star',
      mag:           r['Gmag'] != null ? parseFloat(r['Gmag']) : null,
      parallax:      plx,
      parallaxError: e_plx,
      parallaxSnr:   (plx != null && e_plx != null && e_plx > 0)
                       ? Math.abs(plx / e_plx) : null,
      pmra:          r['pmRA'] != null ? parseFloat(r['pmRA']) : null,
      pmdec:         r['pmDE'] != null ? parseFloat(r['pmDE']) : null,
      _catalog:      'gaia',
      _raw:          r
    };
  }).filter(function(s) { return isFinite(s.ra) && isFinite(s.dec); });
}

// ─────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────

/**
 * 从视差（mas）计算距离。
 * @param {number} parallax_mas  视差，单位毫角秒
 * @returns {{ pc: number, ly: number } | null}
 */
function parallaxToDistance(parallax_mas) {
  if (parallax_mas == null || parallax_mas <= 0) return null;
  var pc = 1000.0 / parallax_mas;
  return { pc: pc, ly: pc * 3.26156 };
}

module.exports = {
  querySimbad: querySimbad,
  queryGaiaDR3: queryGaiaDR3,
  parallaxToDistance: parallaxToDistance
};
