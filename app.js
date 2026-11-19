/* 生长发育工作台 - 核心逻辑 */
(function () {
  'use strict';

  var KEY = 'growthWorkbench.v1';
  var REF = window.SEED.ref;
  var BMIREF = window.BMI_REF;
  var MAX_MONTH = 216; // 18 岁
  var state = null;
  var activeId = null;
  var editingId = null; // 正在编辑的记录 id
  var chartCtx = null;
  var chartPts = []; // 用于 hover 的屏幕坐标点
  var openYears = {}; // 按年折叠状态：key = childId|year

  /* ---------- 工具 ---------- */
  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function parseDate(s) {
    var p = s.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }
  function daysBetween(a, b) { return Math.round((b - a) / 86400000); }

  // 精确年龄：X岁X月X天（按日历推算）
  function ageDMD(birthStr, dateStr) {
    var b = parseDate(birthStr), d = parseDate(dateStr);
    if (d < b) return { y: 0, m: 0, d: 0, months: 0 };
    var y = d.getUTCFullYear() - b.getUTCFullYear();
    var m = d.getUTCMonth() - b.getUTCMonth();
    var dd = d.getUTCDate() - b.getUTCDate();
    if (dd < 0) {
      m--;
      var prevMonthDays = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).getUTCDate();
      dd += prevMonthDays;
    }
    if (m < 0) { y--; m += 12; }
    var months = daysBetween(b, d) / 30.4375;
    return { y: y, m: m, d: dd, months: months };
  }
  function ageText(a) { return a.y + '岁' + a.m + '月' + a.d + '天'; }
  function ageShort(a) { return a.y + '岁' + a.m + '个月'; }

  // BMI 计算与判定（0~6岁用 WS/T 423 百分位，6~18岁用 WS/T 586 超重肥胖 + WS/T 456 消瘦界值）
  function calcBMI(h, w) {
    if (h == null || w == null || h <= 0 || w <= 0) return null;
    var m = h / 100;
    return w / (m * m);
  }
  function interpPct(month) {
    var arr = BMIREF.pct;
    if (month <= arr[0][0]) return arr[0][1].slice();
    if (month >= arr[arr.length - 1][0]) return arr[arr.length - 1][1].slice();
    for (var i = 0; i < arr.length - 1; i++) {
      var a = arr[i], b = arr[i + 1];
      if (month >= a[0] && month <= b[0]) {
        var t = (month - a[0]) / (b[0] - a[0]);
        return a[1].map(function (v, j) { return v + (b[1][j] - v) * t; });
      }
    }
    return arr[arr.length - 1][1].slice();
  }
  function interpObj(obj, ageYears) {
    var strKeys = Object.keys(obj);
    var pairs = strKeys.map(function (k) { return { n: Number(k), k: k }; }).sort(function (x, y) { return x.n - y.n; });
    var lo = pairs[0], hi = pairs[pairs.length - 1];
    if (ageYears <= lo.n) return obj[lo.k].slice();
    if (ageYears >= hi.n) return obj[hi.k].slice();
    for (var i = 0; i < pairs.length - 1; i++) {
      if (ageYears >= pairs[i].n && ageYears <= pairs[i + 1].n) {
        var p = pairs[i], q = pairs[i + 1];
        var t = (ageYears - p.n) / (q.n - p.n);
        var a = obj[p.k], b = obj[q.k];
        return a.map(function (v, j) { return v + (b[j] - v) * t; });
      }
    }
    return obj[hi.k].slice();
  }
  function bmiInfo(a, h, w) {
    var bmi = calcBMI(h, w);
    if (bmi == null) return null;
    var r = { bmi: bmi, level: '', tone: 'ok', cuts: '', note: '' };
    if (a.months < 72) {
      // 0~6 岁：用 BMI 百分位 P3/P10/P25/P50/P75/P90/P97
      var c = interpPct(a.months);
      r.cuts = '正常范围 P3–P97：' + c[0].toFixed(1) + '–' + c[6].toFixed(1);
      if (bmi < c[0]) { r.level = '偏低 / 消瘦'; r.tone = 'low'; }
      else if (bmi < c[2]) { r.level = '正常偏瘦'; r.tone = 'ok'; }
      else if (bmi <= c[4]) { r.level = '正常'; r.tone = 'ok'; }
      else if (bmi < c[6]) { r.level = '正常偏胖'; r.tone = 'high'; }
      else { r.level = '超重 / 肥胖'; r.tone = 'high'; }
      r.note = '参考 WS/T 423—2022 年龄别 BMI 百分位';
    } else {
      // 6~18 岁：超重/肥胖界值 + 消瘦界值
      var ow = interpObj(BMIREF.ow, a.months / 12); // [超重, 肥胖]
      var wa = interpObj(BMIREF.wa, a.months / 12); // [重度消瘦, 轻度下限, 轻度上限]
      r.cuts = '消瘦 ≤' + wa[2].toFixed(1) + ' · 超重 ≥' + ow[0].toFixed(1) + ' · 肥胖 ≥' + ow[1].toFixed(1);
      if (bmi >= ow[1]) { r.level = '肥胖'; r.tone = 'high'; }
      else if (bmi >= ow[0]) { r.level = '超重'; r.tone = 'high'; }
      else if (bmi <= wa[0]) { r.level = '中重度消瘦'; r.tone = 'low'; }
      else if (bmi <= wa[2]) { r.level = '轻度消瘦'; r.tone = 'low'; }
      else { r.level = '正常'; r.tone = 'ok'; }
      r.note = '参考 WS/T 586—2018、WS/T 456—2014';
    }
    return r;
  }

  // 参考曲线插值（按 month）
  function interpRef(month) {
    var lo = REF[0], hi = REF[REF.length - 1];
    if (month <= lo[0]) return { p50: lo[1], p3: lo[2], p97: lo[3], sd: lo[4] };
    if (month >= hi[0]) return { p50: hi[1], p3: hi[2], p97: hi[3], sd: hi[4] };
    for (var i = 0; i < REF.length - 1; i++) {
      var a = REF[i], b = REF[i + 1];
      if (month >= a[0] && month <= b[0]) {
        var t = (month - a[0]) / (b[0] - a[0]);
        return {
          p50: a[1] + (b[1] - a[1]) * t,
          p3: a[2] + (b[2] - a[2]) * t,
          p97: a[3] + (b[3] - a[3]) * t,
          sd: a[4] + (b[4] - a[4]) * t
        };
      }
    }
    return { p50: hi[1], p3: hi[2], p97: hi[3], sd: hi[4] };
  }

  function zOf(month, height) {
    var r = interpRef(month);
    return (height - r.p50) / r.sd;
  }
  function erf(x) {
    var sign = x < 0 ? -1 : 1; x = Math.abs(x);
    var a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    var t = 1 / (1 + p * x);
    var y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  }
  function pctOf(z) { return Math.round((0.5 * (1 + erf(z / Math.SQRT2))) * 100); }
  function pctLabel(p) {
    if (p < 3) return '低于 P3';
    if (p < 15) return '偏低（P3–P15）';
    if (p <= 50) return '中等偏下（P' + p + '）';
    if (p <= 85) return '中等（P' + p + '）';
    if (p <= 97) return '中上（P' + p + '）';
    return '高于 P97';
  }

  /* ---------- 状态 ---------- */
  function seedState() {
    return {
      children: window.SEED.children.map(function (c) {
        return {
          id: c.id, name: c.name, birth: c.birth,
          records: c.records.map(function (r) {
            return { id: uid(), date: r.date, h: r.h, w: r.w, hd: r.hd };
          })
        };
      })
    };
  }
  function loadState() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (s && s.children && s.children.length === 2) return s;
      }
    } catch (e) { /* ignore */ }
    var s2 = seedState();
    try { localStorage.setItem(KEY, JSON.stringify(s2)); } catch (e) {}
    return s2;
  }
  function saveState() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { toast('保存失败：本地存储空间不足'); }
  }
  function child() {
    return state.children.filter(function (c) { return c.id === activeId; })[0];
  }
  function sortedRecords(c) {
    return c.records.slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  }
  function latestWith(c, field) {
    var rs = sortedRecords(c);
    for (var i = rs.length - 1; i >= 0; i--) if (rs[i][field] != null) return rs[i];
    return null;
  }

  /* ---------- 渲染：标签 ---------- */
  function renderTabs() {
    var el = document.getElementById('childTabs');
    el.innerHTML = state.children.map(function (c) {
      var a = ageDMD(c.birth, new Date().toISOString().slice(0, 10));
      return '<button class="child-tab' + (c.id === activeId ? ' active' : '') + '" data-id="' + c.id + '" role="tab">' +
        '<span class="tname">' + esc(c.name) + '</span>' +
        '<span class="tbirth">' + c.birth + ' · ' + a.y + '岁' + a.m + '月</span>' +
        '</button>';
    }).join('');
  }

  /* ---------- 渲染：概览 ---------- */
  function renderSummary() {
    var c = child();
    var el = document.getElementById('summary');
    var last = latestWith(c, 'h');
    if (!last) { el.innerHTML = ''; return; }
    var a = ageDMD(c.birth, last.date);
    var mo = a.months;
    var z = zOf(mo, last.h);
    var p = pctOf(z);

    // 近一年增速
    var target = new Date(parseDate(last.date).getTime() - 365.25 * 86400000).toISOString().slice(0, 10);
    var base = null, best = 1e9;
    sortedRecords(c).forEach(function (r) {
      if (r.h == null || r.date >= last.date) return;
      var diff = Math.abs(daysBetween(parseDate(r.date), parseDate(target)));
      if (diff < best) { best = diff; base = r; }
    });
    var vel = null;
    if (base) {
      var yr = daysBetween(parseDate(base.date), parseDate(last.date)) / 365.25;
      if (yr > 0.4) vel = (last.h - base.h) / yr;
    }

    // BMI：取最近一条同时有身高和体重的记录
    var bmiRec = null;
    var sorted = sortedRecords(c);
    for (var bi = sorted.length - 1; bi >= 0; bi--) {
      if (sorted[bi].h != null && sorted[bi].w != null) { bmiRec = sorted[bi]; break; }
    }
    var bmiStat = '<div class="stat"><div class="label">BMI 体重指数</div>' +
      '<div class="val">' + (bmiRec ? bmiInfo(ageDMD(c.birth, bmiRec.date), bmiRec.h, bmiRec.w).bmi.toFixed(1) : '—') + (bmiRec ? '<small>kg/m²</small>' : '') + '</div>' +
      '<div class="sub">' + (bmiRec ? '<span class="bmi-tag ' + bmiInfo(ageDMD(c.birth, bmiRec.date), bmiRec.h, bmiRec.w).tone + '">' + bmiInfo(ageDMD(c.birth, bmiRec.date), bmiRec.h, bmiRec.w).level + '</span>' : '暂无数据') + '</div></div>';

    el.innerHTML =
      '<div class="stat"><div class="label">测量时年龄</div><div class="val" style="font-size:15px">' + a.y + '岁' + a.m + '月' + a.d + '天</div><div class="sub">' + esc(c.name) + '</div></div>' +
      '<div class="stat"><div class="label">身高水平</div><div class="val" style="font-size:15px">' + pctLabel(p) + '</div><div class="sub">约第 ' + p + ' 百分位</div></div>' +
      '<div class="stat"><div class="label">近一年增速</div><div class="val">' + (vel == null ? '—' : vel.toFixed(1)) + (vel == null ? '' : '<small>cm/年</small>') + '</div><div class="sub">' + (base ? '对比 ' + base.date : '数据不足') + '</div></div>' +
      bmiStat;
  }

  /* ---------- 渲染：当前身高放大卡 ---------- */
  function renderHero() {
    var c = child();
    var el = document.getElementById('heroCard');
    var last = latestWith(c, 'h');
    if (!last) { el.innerHTML = '<div class="card-head"><h2>当前身高</h2></div><p class="muted small" style="margin:0">还没有身高记录。</p>'; return; }
    var a = ageDMD(c.birth, last.date);
    var r = interpRef(a.months);
    var z = zOf(a.months, last.h);
    var p = pctOf(z);
    // 刻度尺：-2SD/P3 → 中位 → +2SD/P97
    var scale = heightScale(last.h, r);
    el.innerHTML =
      '<div class="card-head"><h2>当前身高</h2><span class="muted small">' + last.date + ' 测量 · ' + a.y + '岁' + a.m + '月</span></div>' +
      '<div class="hero-top">' +
        '<div class="hero-big"><b>' + last.h.toFixed(1) + '</b><small>cm</small><div class="hero-verdict">' + pctLabel(p) + ' · 第' + p + '百分位</div></div>' +
        '<div class="hero-ref"><div class="hero-ref-title">同龄参考值</div>' +
          '<div class="hero-cuts">中位 P50 <b>' + r.p50.toFixed(1) + '</b> cm · 正常范围 ' + r.p3.toFixed(1) + '–' + r.p97.toFixed(1) + ' cm</div>' +
          '<div class="hero-note">低于 ' + r.p3.toFixed(1) + ' cm 需关注。7 岁以下参考 WS/T 423—2022，7 岁及以上参考 WS/T 612—2018（P3/P97 对应 ±2SD）。</div>' +
        '</div>' +
      '</div>' +
      scale;
  }
  function heightScale(h, r) {
    function p(v) { return Math.max(0, Math.min(100, (v - r.p3) / (r.p97 - r.p3) * 100)); }
    var bars = '<div class="bmi-scale"><div class="bmi-scale-track">';
    var x50 = p(r.p50);
    bars += '<div class="bmi-scale-seg" style="left:0;width:' + x50 + '%;background:#d7e7df"></div>';
    bars += '<div class="bmi-scale-seg" style="left:' + x50 + '%;width:' + (100 - x50) + '%;background:#e7eee6"></div>';
    bars += '<div class="bmi-marker" style="left:' + p(h) + '%"><span>' + h.toFixed(1) + '</span></div>';
    bars += '</div><div class="bmi-scale-labels">';
    bars += '<span style="left:0">偏低线<br>' + r.p3.toFixed(1) + '</span>';
    bars += '<span style="left:' + x50 + '%">中位<br>' + r.p50.toFixed(1) + '</span>';
    bars += '<span style="left:100%">偏高线<br>' + r.p97.toFixed(1) + '</span>';
    bars += '</div></div>';
    return bars;
  }
  /* ---------- 渲染：记录列表（按年折叠） ---------- */
  function renderRecords() {
    var c = child();
    var rs = sortedRecords(c); // 升序
    var el = document.getElementById('recordList');
    document.getElementById('recordCount').textContent = '共 ' + c.records.length + ' 条记录 · 按年收起，点年份展开';
    if (!rs.length) { el.innerHTML = '<div class="empty">还没有记录，点右上角「新增记录」开始吧</div>'; return; }

    // 按年份分组
    var map = {}, years = [];
    rs.forEach(function (r) {
      var y = r.date.slice(0, 4);
      if (!map[y]) { map[y] = []; years.push(y); }
      map[y].push(r);
    });
    years.sort().reverse(); // 最近的年份在前
    var latestYear = years[0];

    function recHtml(r) {
      var a = ageDMD(c.birth, r.date);
      return '<div class="rec" data-id="' + r.id + '">' +
        '<div class="rec-date"><b>' + r.date + '</b><div class="rec-age">' + ageText(a) + '</div></div>' +
        '<div class="rec-vals">' +
          (r.h != null ? '<span class="rec-val"><b>' + r.h.toFixed(1) + '</b> cm 身高</span>' : '<span class="rec-val missing">— 身高</span>') +
          (r.w != null ? '<span class="rec-val"><b>' + r.w.toFixed(1) + '</b> kg 体重</span>' : '<span class="rec-val missing">— 体重</span>') +
          (r.hd != null ? '<span class="rec-val"><b>' + r.hd.toFixed(1) + '</b> cm 头围</span>' : '') +
        '</div>' +
        '<div class="rec-arrow">›</div>' +
      '</div>';
    }

    el.innerHTML = years.map(function (y) {
      var key = c.id + '|' + y;
      // 默认只展开最新年份；用户手动折叠/展开后记住其选择
      if (!(key in openYears)) openYears[key] = (y === latestYear);
      var open = openYears[key];
      var recs = map[y].slice().reverse(); // 年内最新在前
      // 折叠时在标题上给出该年最近一次的身高，便于一眼扫读
      var lastH = null;
      for (var i = 0; i < recs.length; i++) { if (recs[i].h != null) { lastH = recs[i].h; break; } }
      return '<div class="year-group' + (open ? '' : ' collapsed') + '" data-year="' + y + '">' +
        '<div class="year-head" data-key="' + key + '" role="button" aria-expanded="' + open + '">' +
          '<span class="year-title">' + y + ' 年 <span class="year-count">' + recs.length + ' 条</span>' +
            (lastH != null ? '<span class="year-last">最近 ' + lastH.toFixed(1) + ' cm</span>' : '') + '</span>' +
          '<span class="year-chevron">⌄</span>' +
        '</div>' +
        '<div class="year-body">' + recs.map(recHtml).join('') + '</div>' +
      '</div>';
    }).join('');
  }

  /* ---------- 计算趋势通道 z ---------- */
  function trendZ(c) {
    var pts = sortedRecords(c).filter(function (r) { return r.h != null; });
    if (!pts.length) return null;
    var last = pts[pts.length - 1];
    var cutoff = parseDate(last.date).getTime() - 36 * 30.4375 * 86400000;
    var recent = pts.filter(function (r) { return parseDate(r.date).getTime() >= cutoff; }).slice(-6);
    if (!recent.length) recent = [last];
    var zs = recent.map(function (r) { return zOf(ageDMD(c.birth, r.date).months, r.h); })
      .sort(function (a, b) { return a - b; });
    var z = zs[Math.floor(zs.length / 2)];
    return Math.max(-2, Math.min(2, z)); // 限制在 ±2SD，避免极端外推
  }

  /* ---------- 图表 ---------- */
  function initChart() {
    var canvas = document.getElementById('chart');
    chartCtx = canvas.getContext('2d');
    if (window.ResizeObserver) {
      new ResizeObserver(function () { drawChart(); }).observe(document.getElementById('chartWrap'));
    } else {
      window.addEventListener('resize', drawChart);
    }
    canvas.addEventListener('mousemove', onChartMove);
    canvas.addEventListener('mouseleave', hideTip);
    canvas.addEventListener('touchstart', function (e) { onChartMove(e.touches[0]); }, { passive: true });
  }

  function drawChart() {
    if (!chartCtx) return;
    var canvas = chartCtx.canvas;
    var wrap = document.getElementById('chartWrap');
    var cssW = wrap.clientWidth, cssH = wrap.clientHeight;
    if (!cssW || !cssH) return;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    var ctx = chartCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var pad = { l: 38, r: 12, t: 14, b: 28 };
    var W = cssW - pad.l - pad.r, H = cssH - pad.t - pad.b;
    var xMin = 0, xMax = MAX_MONTH;
    var yMin = 45, yMax = 190;
    function X(mo) { return pad.l + (mo - xMin) / (xMax - xMin) * W; }
    function Y(cm) { return pad.t + H - (cm - yMin) / (yMax - yMin) * H; }

    // 网格与坐标
    ctx.lineWidth = 1;
    ctx.font = '10px -apple-system, "PingFang SC", sans-serif';
    ctx.textBaseline = 'middle';
    [50, 75, 100, 125, 150, 175].forEach(function (cm) {
      var y = Y(cm);
      ctx.strokeStyle = '#eef1ef';
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + W, y); ctx.stroke();
      ctx.fillStyle = '#9aa39e'; ctx.textAlign = 'right';
      ctx.fillText(String(cm), pad.l - 6, y);
    });
    [0, 3, 6, 9, 12, 15, 18].forEach(function (yr) {
      var x = X(yr * 12);
      ctx.strokeStyle = '#f2f4f3';
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + H); ctx.stroke();
      ctx.fillStyle = '#9aa39e'; ctx.textAlign = 'center';
      ctx.fillText(yr + '岁', x, pad.t + H + 13);
    });

    // 正常范围带 P3–P97
    var showBand = document.getElementById('toggleBand').checked;
    if (showBand) {
      ctx.beginPath();
      for (var m = 0; m <= MAX_MONTH; m += 2) {
        var r = interpRef(m);
        if (m === 0) ctx.moveTo(X(m), Y(r.p97)); else ctx.lineTo(X(m), Y(r.p97));
      }
      for (var m2 = MAX_MONTH; m2 >= 0; m2 -= 2) {
        var r2 = interpRef(m2);
        ctx.lineTo(X(m2), Y(r2.p3));
      }
      ctx.closePath();
      ctx.fillStyle = cssVar('--band-fill', 'rgba(15,157,118,.07)');
      ctx.fill();
    }

    // 参考身高 P50
    ctx.strokeStyle = '#9aa39e';
    ctx.lineWidth = 1.8;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    for (var m3 = 0; m3 <= MAX_MONTH; m3 += 2) {
      var y3 = Y(interpRef(m3).p50);
      if (m3 === 0) ctx.moveTo(X(m3), y3); else ctx.lineTo(X(m3), y3);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    var c = child();
    if (!c) return;
    var pts = sortedRecords(c).filter(function (r) { return r.h != null; }).map(function (r) {
      return { mo: ageDMD(c.birth, r.date).months, h: r.h, date: r.date, age: ageDMD(c.birth, r.date) };
    });

    // 趋势预估
    var z = trendZ(c);
    if (z != null && pts.length) {
      var last = pts[pts.length - 1];
      var rLast = interpRef(last.mo);
      var offset = last.h - (rLast.p50 + z * rLast.sd); // 锚定到最后一个实测点，保证连续
      ctx.strokeStyle = cssVar('--amber', '#c8871a');
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(X(last.mo), Y(last.h));
      for (var mm = last.mo; mm <= MAX_MONTH; mm += 2) {
        var rr = interpRef(mm);
        ctx.lineTo(X(mm), Y(rr.p50 + z * rr.sd + offset));
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 实际身高
    chartPts = [];
    if (pts.length) {
      var actualColor = cssVar('--green', '#0f9d76');
      ctx.strokeStyle = actualColor;
      ctx.lineWidth = 2.6;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach(function (p, i) {
        var x = X(p.mo), y = Y(p.h);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        chartPts.push({ x: x, y: y, p: p });
      });
      ctx.stroke();
      ctx.fillStyle = actualColor;
      chartPts.forEach(function (pt) {
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 2.6, 0, Math.PI * 2); ctx.fill();
      });
    }
  }

  function onChartMove(e) {
    if (!chartPts.length) return;
    var rect = chartCtx.canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var best = null, bd = 22;
    chartPts.forEach(function (pt) {
      var d = Math.hypot(pt.x - mx, pt.y - my);
      if (d < bd) { bd = d; best = pt; }
    });
    var tip = document.getElementById('chartTip');
    if (!best) { tip.hidden = true; return; }
    tip.innerHTML = '<b>' + best.p.date + '</b> · ' + ageText(best.p.age) + '<br>身高 ' + best.p.h.toFixed(1) + ' cm';
    tip.style.left = best.x + 'px';
    tip.style.top = best.y + 'px';
    tip.hidden = false;
  }
  function hideTip() { document.getElementById('chartTip').hidden = true; }

  /* ---------- 记录表单 ---------- */
  function openRecordSheet(id) {
    editingId = id || null;
    var c = child();
    var rec = id ? c.records.filter(function (r) { return r.id === id; })[0] : null;
    document.getElementById('sheetTitle').textContent = rec ? '编辑测量记录' : '新增测量记录';
    document.getElementById('fDate').value = rec ? rec.date : new Date().toISOString().slice(0, 10);
    document.getElementById('fHeight').value = rec && rec.h != null ? rec.h : '';
    document.getElementById('fWeight').value = rec && rec.w != null ? rec.w : '';
    document.getElementById('fHead').value = rec && rec.hd != null ? rec.hd : '';
    document.getElementById('btnDelete').hidden = !rec;
    updateAgePreview();
    document.getElementById('recordSheet').hidden = false;
  }
  function updateAgePreview() {
    var v = document.getElementById('fDate').value;
    var p = document.getElementById('agePreview');
    if (!v) { p.textContent = '—'; return; }
    var c = child();
    var a = ageDMD(c.birth, v);
    p.textContent = '测量日年龄：' + ageText(a);
    // 实时 BMI 预览
    var box = document.getElementById('formBmi');
    var h = parseFloat(document.getElementById('fHeight').value);
    var w = parseFloat(document.getElementById('fWeight').value);
    h = isNaN(h) || h <= 0 ? null : h;
    w = isNaN(w) || w <= 0 ? null : w;
    var info = bmiInfo(a, h, w);
    if (info) {
      box.innerHTML = '<span>BMI <b>' + info.bmi.toFixed(1) + '</b> kg/m²</span><span class="bmi-tag ' + info.tone + '">' + info.level + '</span>';
      box.hidden = false;
    } else {
      box.hidden = true;
    }
  }

  /* ---------- 设置 ---------- */
  function openSettings() {
    var ge = state.children[0], di = state.children[1];
    document.getElementById('sNameGe').value = ge.name;
    document.getElementById('sBirthGe').value = ge.birth;
    document.getElementById('sNameDi').value = di.name;
    document.getElementById('sBirthDi').value = di.birth;
    document.getElementById('settingsSheet').hidden = false;
  }

  /* ---------- 杂项 ---------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }
  /* ---------- 配色主题 ---------- */
  var THEME_KEY = 'growthTheme.v2';
  var THEME_COLOR = { green: '#0f9d76', gold: '#c99a1c', purple: '#7357c9', rose: '#e54c5e' };
  function applyTheme(name, persist) {
    if (!THEME_COLOR[name]) name = 'rose';
    document.documentElement.setAttribute('data-theme', name);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLOR[name]);
    var dots = document.querySelectorAll('.theme-dot');
    for (var i = 0; i < dots.length; i++) {
      dots[i].classList.toggle('active', dots[i].getAttribute('data-theme') === name);
    }
    if (persist) { try { localStorage.setItem(THEME_KEY, name); } catch (e) {} }
    drawChart();
  }
  function loadTheme() {
    var t = null;
    try { t = localStorage.getItem(THEME_KEY); } catch (e) {}
    applyTheme(t || 'rose', false);
  }

  function renderAll() {
    renderTabs(); renderSummary(); renderHero(); renderRecords(); drawChart();
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    document.getElementById('childTabs').addEventListener('click', function (e) {
      var btn = e.target.closest('.child-tab');
      if (!btn) return;
      activeId = btn.getAttribute('data-id');
      renderAll();
    });

    document.getElementById('btnAdd').addEventListener('click', function () { openRecordSheet(null); });
    document.getElementById('recordList').addEventListener('click', function (e) {
      var head = e.target.closest('.year-head');
      if (head) {
        var key = head.getAttribute('data-key');
        openYears[key] = !openYears[key];
        var group = head.closest('.year-group');
        if (group) group.classList.toggle('collapsed', !openYears[key]);
        head.setAttribute('aria-expanded', String(!!openYears[key]));
        return;
      }
      var rec = e.target.closest('.rec');
      if (rec) openRecordSheet(rec.getAttribute('data-id'));
    });
    document.getElementById('fDate').addEventListener('change', updateAgePreview);
    document.getElementById('fHeight').addEventListener('input', updateAgePreview);
    document.getElementById('fWeight').addEventListener('input', updateAgePreview);

    document.getElementById('recordForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var date = document.getElementById('fDate').value;
      if (!date) { toast('请选择测量日期'); return; }
      var h = parseFloat(document.getElementById('fHeight').value);
      var w = parseFloat(document.getElementById('fWeight').value);
      var hd = parseFloat(document.getElementById('fHead').value);
      h = isNaN(h) || h <= 0 ? null : h;
      w = isNaN(w) || w <= 0 ? null : w;
      hd = isNaN(hd) || hd <= 0 ? null : hd;
      if (h == null && w == null) { toast('至少填写身高或体重'); return; }
      var c = child();
      if (editingId) {
        var rec = c.records.filter(function (r) { return r.id === editingId; })[0];
        if (rec) { rec.date = date; rec.h = h; rec.w = w; rec.hd = hd; }
        toast('已更新记录');
      } else {
        c.records.push({ id: uid(), date: date, h: h, w: w, hd: hd });
        toast('已添加记录');
      }
      saveState();
      document.getElementById('recordSheet').hidden = true;
      renderAll();
    });

    document.getElementById('btnDelete').addEventListener('click', function () {
      if (!editingId) return;
      if (!window.confirm('确定删除这条记录吗？')) return;
      var c = child();
      c.records = c.records.filter(function (r) { return r.id !== editingId; });
      saveState();
      document.getElementById('recordSheet').hidden = true;
      renderAll();
      toast('已删除');
    });

    ['btnCloseRecord', 'btnCancelRecord'].forEach(function (id) {
      document.getElementById(id).addEventListener('click', function () {
        document.getElementById('recordSheet').hidden = true;
      });
    });
    ['btnCloseSettings', 'btnCancelSettings'].forEach(function (id) {
      document.getElementById(id).addEventListener('click', function () {
        document.getElementById('settingsSheet').hidden = true;
      });
    });
    document.getElementById('btnSettings').addEventListener('click', openSettings);
    document.getElementById('settingsForm').addEventListener('submit', function (e) {
      e.preventDefault();
      state.children[0].name = document.getElementById('sNameGe').value.trim() || '哥哥';
      state.children[0].birth = document.getElementById('sBirthGe').value;
      state.children[1].name = document.getElementById('sNameDi').value.trim() || '弟弟';
      state.children[1].birth = document.getElementById('sBirthDi').value;
      saveState();
      document.getElementById('settingsSheet').hidden = true;
      renderAll();
      toast('设置已保存');
    });

    document.getElementById('toggleBand').addEventListener('change', drawChart);

    var themeDots = document.querySelectorAll('.theme-dot');
    for (var td = 0; td < themeDots.length; td++) {
      themeDots[td].addEventListener('click', function () {
        applyTheme(this.getAttribute('data-theme'), true);
      });
    }

    document.getElementById('btnExport').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = '生长发育工作台备份-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast('备份已导出');
    });
    document.getElementById('btnImport').addEventListener('click', function () {
      document.getElementById('fileImport').click();
    });
    document.getElementById('fileImport').addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var s = JSON.parse(reader.result);
          if (!s.children || s.children.length !== 2) throw new Error('格式不符');
          state = s;
          activeId = state.children[0].id;
          saveState(); renderAll();
          toast('备份已导入');
        } catch (err) { toast('导入失败：文件格式不正确'); }
        e.target.value = '';
      };
      reader.readAsText(file);
    });

    [document.getElementById('recordSheet'), document.getElementById('settingsSheet')].forEach(function (bd) {
      bd.addEventListener('click', function (e) { if (e.target === bd) bd.hidden = true; });
    });
  }

  /* ---------- 启动 ---------- */
  state = loadState();
  activeId = state.children[0].id;
  bind();
  initChart();
  loadTheme();
  renderAll();
})();
