(() => {
  "use strict";

  const data = window.SW_TREND_DATA;
  const standalone = window.SW_STANDALONE || null;
  const rawBenchmarks =
    Array.isArray(data?.benchmarks) && data.benchmarks.length
      ? data.benchmarks
      : data?.benchmark?.points
        ? [data.benchmark]
        : [];
  if (!data || !Array.isArray(data.industries) || !rawBenchmarks.length) {
    document.getElementById("load-error").hidden = false;
    return;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  const ALL_SUB_INDUSTRIES = "__all_sub_industries__";
  const BIAS_MA_OPTIONS = {
    day: [20, 60, 120, 250],
    week: [13, 26, 52, 104],
    month: [6, 12, 24, 36],
  };
  const BIAS_HISTORY_BARS = {
    day: 250,
    week: 104,
    month: 36,
  };
  const BIAS_PERCENTILE_BARS = {
    day: 750,
    week: 156,
    month: 36,
  };
  function prepareIndustrySeries(item) {
    const points = item.points
      .map(([date, close]) => ({ date, close: Number(close) }))
      .filter((point) => point.date && Number.isFinite(point.close));
    return {
      ...item,
      points,
      weeklyPoints: aggregateWeeklyPoints(points),
      monthlyPoints: aggregateMonthlyPoints(points),
    };
  }

  const industries = data.industries
    .filter((item) => Array.isArray(item.points) && item.points.length >= 26)
    .map(prepareIndustrySeries);
  const subIndustries = Array.isArray(data.subIndustries) ? data.subIndustries : [];
  const subIndustriesByParent = new Map();
  subIndustries.forEach((item) => {
    if (!subIndustriesByParent.has(item.parentCode)) {
      subIndustriesByParent.set(item.parentCode, []);
    }
    subIndustriesByParent.get(item.parentCode).push(item);
  });
  const subIndustryColorIndexByCode = new Map(
    subIndustries.map((item, index) => [item.code, index]),
  );
  const benchmarks = rawBenchmarks.map((item) => {
    const points = item.points
      .map(([date, close]) => ({ date, close: Number(close) }))
      .filter((point) => point.date && Number.isFinite(point.close));
    return {
      ...item,
      points,
      weeklyPoints: aggregateWeeklyPoints(points),
      monthlyPoints: aggregateMonthlyPoints(points),
    };
  });
  const primaryBenchmark =
    benchmarks.find((item) => item.code === "000300") || benchmarks[0];
  const benchmark = primaryBenchmark.points;

  function aggregateWeeklyPoints(points) {
    const weeks = new Map();
    points.forEach((point) => {
      const date = new Date(`${point.date}T00:00:00Z`);
      const mondayOffset = (date.getUTCDay() + 6) % 7;
      date.setUTCDate(date.getUTCDate() - mondayOffset);
      const weekKey = date.toISOString().slice(0, 10);
      weeks.set(weekKey, point);
    });
    return [...weeks.values()];
  }

  function aggregateMonthlyPoints(points) {
    const months = new Map();
    points.forEach((point) => {
      months.set(point.date.slice(0, 7), point);
    });
    return [...months.values()];
  }

  function frequencyPoints(series, frequency) {
    if (frequency === "week") return series.weeklyPoints;
    if (frequency === "month") return series.monthlyPoints;
    return series.points;
  }
  const industryByCode = new Map(industries.map((item) => [item.code, item]));
  const colorIndexByCode = new Map(
    industries.map((item, index) => [item.code, index]),
  );

  if (!industries.length) {
    document.getElementById("load-error").hidden = false;
    return;
  }

  const state = {
    frequency: "day",
    heatmapMode: "week",
    industryHeatmapLevel: "primary",
    secondaryIndustryRows: [],
    secondaryIndustryPromise: null,
    industryFundHistory: new Map(),
    industryFundHistoryPromise: null,
    weeks: 26,
    selectedCode: null,
    periodStats: [],
    chartGeometry: null,
    allChartGeometry: null,
    highlightedCode: null,
    selectedSubIndustry: null,
    showAllSubIndustries: false,
    subIndustryGroups: new Map(),
    subIndustryLoads: new Map(),
    subIndustryRequestId: 0,
    companyGroups: new Map(),
    companyLoadedAt: new Map(),
    companyLoads: new Map(),
    companyRequestId: 0,
    companyQuery: "",
    activeCompanyPayload: null,
    companyInfoGroups: new Map(),
    companyInfoLoadedAt: new Map(),
    companyInfoLoads: new Map(),
    companyInfoRequestId: 0,
    selectedCompanyCode: null,
    companySearchRequestId: 0,
    companySearchTimer: null,
    companySearchResults: [],
    rotationStockCompanies: new Map(),
    rotationStockIndustry: null,
    industryFlow: [],
    industryFlowSort: "mainNetInflow",
    industryFlowRefreshTimer: null,
    industryFlowLoading: false,
    marketPulsePayload: null,
    marketPulseLoading: false,
    marketPulseRequestId: 0,
    level2FlowParentCode: null,
    level2FlowIndustryCode: null,
    level2FlowPayload: null,
    level2FlowLoading: false,
    level2FlowRequestId: 0,
    conceptStocksPayload: null,
    conceptSearchLoading: false,
    conceptSearchRequestId: 0,
    conceptHeatPayload: null,
    conceptHeatMode: "theme",
    conceptHeatSort: "hotspotScore",
    conceptHeatLoading: false,
    conceptHeatRequestId: 0,
    conceptIntradayFlowPayload: null,
    conceptIntradayFlowLoading: false,
    conceptIntradayFlowRequestId: 0,
    conceptIntradayFlowMode: "cumulative",
    conceptIntradayFlowScope: "focus",
    conceptIntradayFlowHidden: new Set(),
    conceptIntradayFlowGeometry: null,
    conceptRotationPayload: null,
    conceptRotationMode: "week",
    conceptRotationLoading: false,
    conceptRotationRequestId: 0,
    eventThemePayload: null,
    eventThemeLoading: false,
    eventThemeRequestId: 0,
    biasFrequency: "day",
    biasMaPeriod: 20,
    biasSelectedCode: null,
    biasChartGeometry: null,
    activeView: "industry",
  };

  const elements = {
    rangeControl: document.getElementById("range-control"),
    frequencyControl: document.getElementById("frequency-control"),
    frequencyBadge: document.getElementById("frequency-badge"),
    boardIntro: document.getElementById("board-intro"),
    heatmapModeControl: document.getElementById("heatmap-mode-control"),
    heatmapLevelControl: document.getElementById("heatmap-level-control"),
    heatmapIntro: document.getElementById("heatmap-intro"),
    heatmapLossLabel: document.getElementById("heatmap-loss-label"),
    heatmapGainLabel: document.getElementById("heatmap-gain-label"),
    rotationStockDrawer: document.getElementById("rotation-stock-drawer"),
    rotationStockHeading: document.getElementById("rotation-stock-heading"),
    rotationStockSource: document.getElementById("rotation-stock-source"),
    rotationStockList: document.getElementById("rotation-stock-list"),
    rotationStockClose: document.getElementById("rotation-stock-close"),
    rotationStockFull: document.getElementById("rotation-stock-full"),
    select: document.getElementById("industry-select"),
    subSelect: document.getElementById("subindustry-select"),
    subSelectNote: document.getElementById("subindustry-note"),
    summaryMetrics: document.getElementById("summary-metrics"),
    breadthValue: document.getElementById("breadth-value"),
    breadthNote: document.getElementById("breadth-note"),
    leaderValue: document.getElementById("leader-value"),
    leaderNote: document.getElementById("leader-note"),
    spreadValue: document.getElementById("spread-value"),
    spreadNote: document.getElementById("spread-note"),
    benchmarkValue: document.getElementById("benchmark-value"),
    chartHeading: document.getElementById("chart-heading"),
    detailLegend: document.getElementById("detail-legend"),
    trendPill: document.getElementById("trend-pill"),
    industryCode: document.getElementById("industry-code"),
    selectionNote: document.getElementById("selection-note"),
    chartWrap: document.getElementById("chart-wrap"),
    chart: document.getElementById("trend-chart"),
    chartTooltip: document.getElementById("chart-tooltip"),
    statReturn: document.getElementById("stat-return"),
    statExcess: document.getElementById("stat-excess"),
    statDrawdown: document.getElementById("stat-drawdown"),
    statVolatility: document.getElementById("stat-volatility"),
    companySection: document.getElementById("company-section"),
    viewTabs: document.getElementById("view-tabs"),
    industryView: document.getElementById("industry-view"),
    biasView: document.getElementById("bias-view"),
    biasFrequencyControl: document.getElementById("bias-frequency-control"),
    biasMaControl: document.getElementById("bias-ma-control"),
    biasBreadthValue: document.getElementById("bias-breadth-value"),
    biasBreadthNote: document.getElementById("bias-breadth-note"),
    biasMedianValue: document.getElementById("bias-median-value"),
    biasStrongValue: document.getElementById("bias-strong-value"),
    biasStrongNote: document.getElementById("bias-strong-note"),
    biasWeakValue: document.getElementById("bias-weak-value"),
    biasWeakNote: document.getElementById("bias-weak-note"),
    biasChartHeading: document.getElementById("bias-chart-heading"),
    biasChartCaption: document.getElementById("bias-chart-caption"),
    biasChartLegend: document.getElementById("bias-chart-legend"),
    biasChartWrap: document.getElementById("bias-chart-wrap"),
    biasChart: document.getElementById("bias-chart"),
    biasChartTooltip: document.getElementById("bias-chart-tooltip"),
    biasStatCurrent: document.getElementById("bias-stat-current"),
    biasStatPercentile: document.getElementById("bias-stat-percentile"),
    biasStatMa: document.getElementById("bias-stat-ma"),
    biasStatZone: document.getElementById("bias-stat-zone"),
    biasRankingLabel: document.getElementById("bias-ranking-label"),
    biasRankingList: document.getElementById("bias-ranking-list"),
    flowView: document.getElementById("flow-view"),
    flowViewMain: document.getElementById("flow-view-main"),
    flowPanel: document.getElementById("industry-flow-panel"),
    conceptView: document.getElementById("concept-view"),
    conceptViewMain: document.getElementById("concept-view-main"),
    companyView: document.getElementById("company-view"),
    companyViewTop: document.getElementById("company-view-top"),
    companyViewMain: document.getElementById("company-view-main"),
    companyViewHelp: document.getElementById("company-view-help"),
    conceptScreenerPanel: document.getElementById("concept-screener-panel"),
    conceptHeatPanel: document.getElementById("concept-heat-panel"),
    conceptHeatTime: document.getElementById("concept-heat-time"),
    conceptHeatRefresh: document.getElementById("concept-heat-refresh"),
    conceptHeatMode: document.getElementById("concept-heat-mode"),
    conceptHeatSort: document.getElementById("concept-heat-sort"),
    conceptHeatLead: document.getElementById("concept-heat-lead"),
    conceptHeatGrid: document.getElementById("concept-heat-grid"),
    conceptHeatMethod: document.getElementById("concept-heat-method"),
    conceptIntradayFlowPanel: document.getElementById("concept-intraday-flow-panel"),
    conceptIntradayFlowTime: document.getElementById("concept-intraday-flow-time"),
    conceptIntradayFlowMode: document.getElementById("concept-intraday-flow-mode"),
    conceptIntradayFlowScope: document.getElementById("concept-intraday-flow-scope"),
    conceptIntradayFlowHeading: document.getElementById(
      "concept-intraday-flow-heading",
    ),
    conceptIntradayFlowRefresh: document.getElementById("concept-intraday-flow-refresh"),
    conceptIntradayFlowSummary: document.getElementById("concept-intraday-flow-summary"),
    conceptIntradayFlowChartWrap: document.getElementById("concept-intraday-flow-chart-wrap"),
    conceptIntradayFlowChart: document.getElementById("concept-intraday-flow-chart"),
    conceptIntradayFlowReadout: document.getElementById("concept-intraday-flow-readout"),
    conceptIntradayFlowLegend: document.getElementById("concept-intraday-flow-legend"),
    eventThemePanel: document.getElementById("event-theme-panel"),
    eventThemeTime: document.getElementById("event-theme-time"),
    eventThemeRefresh: document.getElementById("event-theme-refresh"),
    eventThemeSummary: document.getElementById("event-theme-summary"),
    eventThemeGrid: document.getElementById("event-theme-grid"),
    eventThemeMethod: document.getElementById("event-theme-method"),
    conceptRotationPanel: document.getElementById("concept-rotation-panel"),
    conceptRotationMode: document.getElementById("concept-rotation-mode"),
    conceptRotationTime: document.getElementById("concept-rotation-time"),
    conceptRotationRefresh: document.getElementById("concept-rotation-refresh"),
    conceptRotationIntro: document.getElementById("concept-rotation-intro"),
    conceptRotationGrid: document.getElementById("concept-rotation-grid"),
    conceptRotationMethod: document.getElementById("concept-rotation-method"),
    conceptRotationLossLabel: document.getElementById("concept-rotation-loss-label"),
    conceptRotationGainLabel: document.getElementById("concept-rotation-gain-label"),
    conceptSearchForm: document.getElementById("concept-search-form"),
    conceptSearchInput: document.getElementById("concept-search-input"),
    conceptSearchSubmit: document.getElementById("concept-search-submit"),
    conceptPresets: document.getElementById("concept-presets"),
    conceptMatchSummary: document.getElementById("concept-match-summary"),
    conceptMarketNote: document.getElementById("concept-market-note"),
    conceptRoleSummary: document.getElementById("concept-role-summary"),
    conceptStockBody: document.getElementById("concept-stock-body"),
    conceptScreenerTime: document.getElementById("concept-screener-time"),
    companyLocator: document.getElementById("company-locator-panel"),
    globalCompanySearch: document.getElementById("global-company-search"),
    globalCompanyResults: document.getElementById("global-company-results"),
    globalCompanyStatus: document.getElementById("global-company-status"),
    companyJump: document.getElementById("company-jump"),
    companyHeading: document.getElementById("company-heading"),
    companyCount: document.getElementById("company-count"),
    companySourceDate: document.getElementById("company-source-date"),
    companySearch: document.getElementById("company-search"),
    companyTableBody: document.getElementById("company-table-body"),
    companyFootnote: document.getElementById("company-footnote"),
    industryFlowTime: document.getElementById("industry-flow-time"),
    industryFlowRefresh: document.getElementById("industry-flow-refresh"),
    industryFlowSummary: document.getElementById("industry-flow-summary"),
    industryFlowControls: document.getElementById("industry-flow-controls"),
    industryFlowGrid: document.getElementById("industry-flow-grid"),
    marketPulsePanel: document.getElementById("market-pulse-panel"),
    marketPulseTime: document.getElementById("market-pulse-time"),
    marketPulseRefresh: document.getElementById("market-pulse-refresh"),
    marketBreadthSummary: document.getElementById("market-breadth-summary"),
    marketBreadthChart: document.getElementById("market-breadth-chart"),
    marketBreadthTotals: document.getElementById("market-breadth-totals"),
    marketVolumeState: document.getElementById("market-volume-state"),
    marketVolumeActual: document.getElementById("market-volume-actual"),
    marketVolumePredicted: document.getElementById("market-volume-predicted"),
    marketVolumeNote: document.getElementById("market-volume-note"),
    marketVolumeRange: document.getElementById("market-volume-range"),
    marketVolumeMethod: document.getElementById("market-volume-method"),
    level2FlowPanel: document.getElementById("level2-flow-panel"),
    level2FlowTime: document.getElementById("level2-flow-time"),
    level2FlowRefresh: document.getElementById("level2-flow-refresh"),
    level2FlowParentSelect: document.getElementById("level2-flow-parent-select"),
    level2FlowIndustrySelect: document.getElementById("level2-flow-industry-select"),
    level2FlowSummary: document.getElementById("level2-flow-summary"),
    level2FlowStockBody: document.getElementById("level2-flow-stock-body"),
    level2FlowFootnote: document.getElementById("level2-flow-footnote"),
    companyDetail: document.getElementById("company-detail"),
    companyDetailName: document.getElementById("company-detail-name"),
    companyDetailCode: document.getElementById("company-detail-code"),
    companyDetailBody: document.getElementById("company-detail-body"),
    companyDetailClose: document.getElementById("company-detail-close"),
    allChartWrap: document.getElementById("all-chart-wrap"),
    allChart: document.getElementById("all-industries-chart"),
    allChartTooltip: document.getElementById("all-chart-tooltip"),
    allLegend: document.getElementById("all-industries-legend"),
    rankingList: document.getElementById("ranking-list"),
    heatmap: document.getElementById("heatmap-grid"),
    sourceDate: document.getElementById("as-of-date"),
    dataSource: document.getElementById("data-source"),
    updatedAt: document.getElementById("updated-at"),
    themeToggle: document.getElementById("theme-toggle"),
    themeLabel: document.getElementById("theme-label"),
    loadError: document.getElementById("load-error"),
  };

  const parseDate = (value) => new Date(`${value}T00:00:00+08:00`).getTime();

  function subtractDays(dateValue, days) {
    const timestamp = parseDate(dateValue) - days * 86_400_000;
    const date = new Date(timestamp);
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  }

  function formatPercent(value, digits = 1) {
    if (!Number.isFinite(value)) return "--";
    const sign = value > 0 ? "+" : "";
    return `${sign}${(value * 100).toFixed(digits)}%`;
  }

  function formatPoints(value, digits = 1) {
    if (!Number.isFinite(value)) return "--";
    const sign = value > 0 ? "+" : "";
    return `${sign}${(value * 100).toFixed(digits)}pp`;
  }

  function formatSignedNumber(value, digits = 1) {
    if (!Number.isFinite(value)) return "--";
    return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
  }

  function formatSignedFlowNumber(value, digits = 1) {
    if (!Number.isFinite(value)) return "--";
    return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
  }

  function renderChartReadout(element, date, name, color, entries) {
    const values = entries
      .map(
        (entry) => `
          <span class="readout-chip">
            ${entry.color ? `<i class="readout-chip-dot" style="background:${entry.color}"></i>` : ""}
            <span>${escapeHTML(entry.label)}</span>
            <b>${escapeHTML(entry.value)}</b>
          </span>
        `,
      )
      .join("");
    element.innerHTML = `
      <span class="readout-title">
        <i class="readout-dot" style="background:${color}"></i>
        <b>${escapeHTML(name)}</b>
      </span>
      <span class="readout-date">${formatDate(date)}</span>
      <span class="readout-values">${values}</span>
    `;
  }

  function formatDate(value) {
    return value.replaceAll("-", ".");
  }

  function shortDate(value) {
    return value.slice(5).replace("-", "/");
  }

  function average(values) {
    if (!values.length) return NaN;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function trailingAverage(points, count, offset = 0) {
    const end = points.length - offset;
    const start = end - count;
    if (start < 0) return NaN;
    return average(points.slice(start, end).map((point) => point.close));
  }

  function classifyTrend(points) {
    const close = points.at(-1)?.close;
    const ma13 = trailingAverage(points, 13);
    const ma26 = trailingAverage(points, 26);
    const ma13Prior = trailingAverage(points, 13, 4);
    const return4w =
      points.length > 4 ? close / points.at(-5).close - 1 : Number.NaN;

    if (
      Number.isFinite(ma13) &&
      Number.isFinite(ma26) &&
      close >= ma13 &&
      ma13 >= ma26 &&
      ma13 > ma13Prior
    ) {
      return "强势上行";
    }
    if (
      Number.isFinite(ma13) &&
      close >= ma13 &&
      (return4w > 0 || ma13 > ma13Prior)
    ) {
      return "修复上行";
    }
    if (
      Number.isFinite(ma13) &&
      Number.isFinite(ma26) &&
      close < ma13 &&
      ma13 >= ma26
    ) {
      return "高位回撤";
    }
    if (
      Number.isFinite(ma13) &&
      Number.isFinite(ma26) &&
      close < ma13 &&
      ma13 < ma26 &&
      ma13 < ma13Prior
    ) {
      return "弱势下行";
    }
    return "震荡整理";
  }

  function getStartDate(weeks) {
    const latestDate = industries.reduce(
      (latest, item) => (item.points.at(-1).date > latest ? item.points.at(-1).date : latest),
      industries[0].points.at(-1).date,
    );
    if (weeks >= 999) {
      return industries.reduce(
        (earliest, item) => (item.points[0].date < earliest ? item.points[0].date : earliest),
        industries[0].points[0].date,
      );
    }
    return subtractDays(latestDate, Math.max(1, weeks) * 7);
  }

  function visiblePoints(points, startDate) {
    const visible = points.filter((point) => point.date >= startDate);
    if (visible.length >= 2) return visible;
    return points.slice(-2);
  }

  function maxDrawdown(points) {
    let peak = points[0]?.close ?? Number.NaN;
    let worst = 0;
    for (const point of points) {
      peak = Math.max(peak, point.close);
      if (Number.isFinite(peak) && peak > 0) {
        worst = Math.min(worst, point.close / peak - 1);
      }
    }
    return worst;
  }

  function annualizedVolatility(points) {
    if (points.length < 3) return Number.NaN;
    const returns = [];
    for (let index = 1; index < points.length; index += 1) {
      returns.push(points[index].close / points[index - 1].close - 1);
    }
    const mean = average(returns);
    const variance =
      returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      Math.max(1, returns.length - 1);
    const periodsPerYear =
      state.frequency === "month" ? 12 : state.frequency === "week" ? 52 : 252;
    return Math.sqrt(variance) * Math.sqrt(periodsPerYear);
  }

  function getBenchmarkReturn(startDate) {
    const points = visiblePoints(
      frequencyPoints(primaryBenchmark, state.frequency),
      startDate,
    );
    return points.at(-1).close / points[0].close - 1;
  }

  function calculatePeriod(industry, weeks) {
    const startDate = getStartDate(weeks);
    const points = visiblePoints(
      frequencyPoints(industry, state.frequency),
      startDate,
    );
    const periodReturn = points.at(-1).close / points[0].close - 1;
    const benchmarkReturn = getBenchmarkReturn(startDate);
    return {
      ...industry,
      startDate,
      visible: points,
      periodReturn,
      benchmarkReturn,
      excessReturn: (1 + periodReturn) / (1 + benchmarkReturn) - 1,
      drawdown: maxDrawdown(points),
      volatility: annualizedVolatility(points),
      trend: classifyTrend(industry.weeklyPoints),
      close: points.at(-1).close,
      ma13: trailingAverage(industry.weeklyPoints, 13),
    };
  }

  function escapeHTML(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function setValueTone(element, value) {
    element.classList.toggle("up-text", value > 0.0001);
    element.classList.toggle("down-text", value < -0.0001);
  }

  function renderSummary(stats) {
    const breadthCount = stats.filter((item) => item.close >= item.ma13).length;
    const leader = stats[0];
    const laggard = stats.at(-1);
    const spread = leader.periodReturn - laggard.periodReturn;
    const benchmarkReturn = getBenchmarkReturn(getStartDate(state.weeks));

    elements.breadthValue.textContent = `${breadthCount} / ${stats.length}`;
    elements.breadthNote.textContent = `${((breadthCount / stats.length) * 100).toFixed(0)}% 行业站上 13 周均线`;

    elements.leaderValue.textContent = leader.name;
    elements.leaderNote.textContent = `${formatPercent(leader.periodReturn)} · ${leader.trend}`;
    setValueTone(elements.leaderNote, leader.periodReturn);

    elements.spreadValue.textContent = formatPercent(spread);
    elements.spreadNote.textContent = `${leader.name} vs ${laggard.name}`;
    setValueTone(elements.spreadValue, spread);

    elements.benchmarkValue.textContent = formatPercent(benchmarkReturn);
    setValueTone(elements.benchmarkValue, benchmarkReturn);
  }

  function renderRanking(stats) {
    const selectedCode = state.selectedCode;
    const leaders = stats.slice(0, 6);
    const laggards = stats.slice(-4);
    const fragment = document.createDocumentFragment();

    const appendRow = (item, rank) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "rank-row";
      button.dataset.code = item.code;
      button.classList.toggle("is-selected", item.code === selectedCode);
      button.setAttribute("aria-label", `查看${item.name}走势`);
      button.innerHTML = `
        <span class="rank-number">${String(rank).padStart(2, "0")}</span>
        <span class="rank-main">
          <span class="rank-name">${escapeHTML(item.name)}</span>
          <span class="rank-trend">${escapeHTML(item.trend)}</span>
        </span>
        <span class="rank-value">
          <span class="rank-return ${item.periodReturn >= 0 ? "up-text" : "down-text"}">${formatPercent(item.periodReturn)}</span>
          <span class="rank-excess">${formatPoints(item.excessReturn)} 超额</span>
        </span>
      `;
      button.addEventListener("click", () => selectIndustry(item.code));
      fragment.append(button);
    };

    leaders.forEach((item, index) => appendRow(item, index + 1));
    const gap = document.createElement("div");
    gap.className = "rank-gap";
    gap.textContent = `···  ${stats.length - 10} 个行业  ···`;
    fragment.append(gap);
    laggards.forEach((item, index) =>
      appendRow(item, stats.length - laggards.length + index + 1),
    );
    elements.rankingList.replaceChildren(fragment);
  }

  function industryColor(code) {
    const primaryIndex = colorIndexByCode.get(code);
    const subIndustryIndex = subIndustryColorIndexByCode.get(code);
    const index = primaryIndex ?? subIndustryIndex ?? 0;
    const hue =
      (index * 137.508 + (subIndustryIndex === undefined ? 12 : 36)) % 360;
    const dark = document.documentElement.dataset.theme === "dark";
    const saturation = dark ? 72 : 68;
    const lightness = (dark ? 61 : 41) + (index % 3) * 4;
    return `hsl(${hue.toFixed(1)} ${saturation}% ${lightness}%)`;
  }

  function benchmarkVisual(code) {
    const dark = document.documentElement.dataset.theme === "dark";
    const visuals = {
      "000001": { color: dark ? "#75a9e6" : "#356da8", dash: "7 4", className: "sh" },
      "000300": { color: dark ? "#aeb7b1" : "#6f7872", dash: "5 4", className: "hs300" },
      "000852": { color: dark ? "#e5a24d" : "#bd731d", dash: "2 3", className: "zz1000" },
      "932000": { color: dark ? "#cc86e3" : "#8d4ca8", dash: "8 3 2 3", className: "zz2000" },
    };
    return visuals[code] || {
      color: dark ? "#b8c2bc" : "#66716a",
      dash: "5 4",
      className: "hs300",
    };
  }

  function benchmarkLabelName(code) {
    return {
      "000001": "上证",
      "000300": "沪深300",
      "000852": "中证1000",
      "932000": "中证2000",
    }[code] || code;
  }

  function renderAllIndustriesLegend(stats) {
    const fragment = document.createDocumentFragment();
    stats.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "all-legend-item";
      button.dataset.code = item.code;
      button.classList.toggle("is-selected", item.code === state.selectedCode);
      button.setAttribute("aria-pressed", String(item.code === state.selectedCode));
      button.setAttribute(
        "aria-label",
        `${item.name}，区间收益${formatPercent(item.periodReturn)}，相对沪深300${formatPoints(item.excessReturn)}`,
      );
      button.innerHTML = `
        <span class="all-legend-swatch" style="background:${industryColor(item.code)}"></span>
        <span class="all-legend-name">${escapeHTML(item.name)}</span>
        <span class="all-legend-value">${formatPercent(item.periodReturn)}</span>
      `;
      button.addEventListener("mouseenter", () => applyAllLineHighlight(item.code));
      button.addEventListener("mouseleave", () => applyAllLineHighlight(null));
      button.addEventListener("focus", () => applyAllLineHighlight(item.code));
      button.addEventListener("blur", () => applyAllLineHighlight(null));
      button.addEventListener("click", () => selectIndustry(item.code));
      fragment.append(button);
    });
    elements.allLegend.replaceChildren(fragment);
  }

  function applyAllLineHighlight(code) {
    state.highlightedCode = code;
    if (!state.allChartGeometry) return;
    state.allChartGeometry.lines.forEach((line) => {
      const active = code
        ? line.code === code
        : line.code === state.selectedCode;
      line.path.setAttribute("stroke-width", active ? "2.8" : "1.4");
      line.path.setAttribute("opacity", code ? (active ? "1" : "0.12") : active ? "1" : "0.8");
    });
    elements.allLegend.querySelectorAll(".all-legend-item").forEach((item) => {
      item.classList.toggle("is-hovered", item.dataset.code === code);
    });
  }

  function drawAllIndustriesChart(stats) {
    if (!stats.length || !elements.allChartWrap.clientWidth) return;
    const width = Math.max(300, elements.allChartWrap.clientWidth);
    const height = Math.max(260, elements.allChartWrap.clientHeight);
    const margin = {
      top: 14,
      right: width < 460 ? 112 : width < 720 ? 104 : 116,
      bottom: 30,
      left: width < 460 ? 42 : 52,
    };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const startDate = getStartDate(state.weeks);
    const series = stats.map((item) => {
      const points = item.visible;
      const base = points[0].close;
      return {
        code: item.code,
        name: item.name,
        color: industryColor(item.code),
        points: points.map((point) => ({
          timestamp: parseDate(point.date),
          value: (point.close / base - 1) * 100,
          date: point.date,
        })),
      };
    });
    const benchmarkSeries = benchmarks.map((item) => {
      const points = visiblePoints(
        frequencyPoints(item, state.frequency),
        startDate,
      );
      const base = points[0].close;
      return {
        code: item.code,
        name: item.name,
        points: points.map((point) => ({
          timestamp: parseDate(point.date),
          value: (point.close / base - 1) * 100,
          date: point.date,
        })),
      };
    });
    const startTimestamp = Math.min(
      ...series.map((line) => line.points[0].timestamp),
      ...benchmarkSeries.map((line) => line.points[0].timestamp),
    );
    const endTimestamp = Math.max(
      ...series.map((line) => line.points.at(-1).timestamp),
      ...benchmarkSeries.map((line) => line.points.at(-1).timestamp),
    );
    const values = [
      ...series.flatMap((line) => line.points.map((point) => point.value)),
      ...benchmarkSeries.flatMap((line) => line.points.map((point) => point.value)),
    ];
    const rawMinimum = Math.min(0, ...values);
    const rawMaximum = Math.max(0, ...values);
    const rawPadding = Math.max(0.4, (rawMaximum - rawMinimum) * 0.08);
    const yDomain = yTicks(rawMinimum - rawPadding, rawMaximum + rawPadding);
    const xScale = (value) =>
      margin.left +
      ((value - startTimestamp) / Math.max(1, endTimestamp - startTimestamp)) *
        plotWidth;
    const yScale = (value) =>
      margin.top +
      (1 - (value - yDomain.min) / (yDomain.max - yDomain.min)) * plotHeight;

    elements.allChart.setAttribute("viewBox", `0 0 ${width} ${height}`);
    elements.allChart.setAttribute("aria-label", "31个申万一级行业趋势叠加图");
    elements.allChart.replaceChildren();
    const desc = document.createElementNS(SVG_NS, "desc");
    desc.id = "all-chart-desc";
    desc.textContent = `${formatDate(series[0].points[0].date)}起的行业累计收益，每个颜色代表一个行业；虚线依次为上证指数、沪深300、中证1000和中证2000。`;
    elements.allChart.append(desc);

    yDomain.ticks.forEach((tick) => {
      const y = yScale(tick);
      elements.allChart.append(
        svgElement("line", {
          x1: margin.left,
          y1: y,
          x2: width - margin.right,
          y2: y,
          class: tick === 0 ? "all-zero-line" : "all-grid-line",
        }),
      );
      const label = svgElement("text", {
        x: margin.left - 9,
        y: y + 3,
        "text-anchor": "end",
      });
      label.textContent = formatSignedNumber(tick, Math.abs(tick) < 10 ? 1 : 0);
      elements.allChart.append(label);
    });

    const xTickCount = width < 460 ? 3 : width < 720 ? 5 : 6;
    for (let index = 0; index < xTickCount; index += 1) {
      const timestamp =
        startTimestamp + ((endTimestamp - startTimestamp) * index) / (xTickCount - 1);
      const date = new Date(timestamp);
      const label = svgElement("text", {
        x: xScale(timestamp),
        y: height - 8,
        "text-anchor": index === 0 ? "start" : index === xTickCount - 1 ? "end" : "middle",
      });
      label.textContent = [
        String(date.getFullYear()).slice(2),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
      ].join("/");
      elements.allChart.append(label);
    }

    const lines = [];
    const drawOrder = [
      ...series.filter((line) => line.code !== state.selectedCode),
      ...series.filter((line) => line.code === state.selectedCode),
    ];
    drawOrder.forEach((line) => {
      const path = svgElement("path", {
        class: "all-industry-line",
        d: pathFrom(line.points, xScale, yScale),
        stroke: line.color,
      });
      elements.allChart.append(path);
      lines.push({ ...line, path });
    });
    benchmarkSeries.forEach((line) => {
      const visual = benchmarkVisual(line.code);
      elements.allChart.append(svgElement("path", {
        class: "all-benchmark-line",
        d: pathFrom(line.points, xScale, yScale),
        style: `stroke:${visual.color};stroke-dasharray:${visual.dash}`,
      }));
    });
    addBenchmarkEndLabels(
      elements.allChart,
      benchmarkSeries,
      xScale,
      yScale,
      margin,
      width,
      plotHeight,
    );

    const hoverGroup = svgElement("g", { "aria-hidden": "true", opacity: "0" });
    const crosshair = svgElement("line", {
      class: "all-crosshair",
      y1: margin.top,
      y2: margin.top + plotHeight,
    });
    const hoverDot = svgElement("circle", {
      class: "all-hover-dot",
      r: 4,
    });
    hoverGroup.append(crosshair, hoverDot);
    elements.allChart.append(hoverGroup);
    state.allChartGeometry = {
      width,
      height,
      margin,
      plotWidth,
      plotHeight,
      startTimestamp,
      endTimestamp,
      xScale,
      yScale,
      lines,
      benchmarkSeries,
      hoverGroup,
      crosshair,
      hoverDot,
    };
    applyAllLineHighlight(state.highlightedCode);
  }

  function clampUnit(value) {
    return Math.max(0, Math.min(1, value));
  }

  async function loadIndustryFundHistory() {
    if (state.industryFundHistory.size) return state.industryFundHistory;
    if (state.industryFundHistoryPromise) {
      return state.industryFundHistoryPromise;
    }
    const request = (async () => {
      const payload = standalone?.industryFundHistory
        ? standalone.industryFundHistory
        : await fetch("/api/industry-fund-history", {
            cache: "no-store",
          }).then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          });
      const entries = Object.entries(payload?.industries || {});
      entries.forEach(([code, entry]) => {
        state.industryFundHistory.set(code, entry);
      });
      return state.industryFundHistory;
    })();
    state.industryFundHistoryPromise = request;
    try {
      return await request;
    } finally {
      if (state.industryFundHistoryPromise === request) {
        state.industryFundHistoryPromise = null;
      }
    }
  }

  function industryPersistence(item) {
    const closes = item.points
      .slice(-60)
      .map((point) => Number(point.close))
      .filter(Number.isFinite);
    if (closes.length < 22) return null;
    const close = closes.at(-1);
    const ma5 = average(closes.slice(-5));
    const ma10 = average(closes.slice(-10));
    const ma20 = average(closes.slice(-20));
    const ma5Prior = average(closes.slice(-10, -5));
    const alignment =
      [close >= ma5, ma5 >= ma10, ma10 >= ma20].filter(Boolean).length / 3;
    const ma20Distance = close / ma20 - 1;
    const ma5Slope = ma5 / ma5Prior - 1;
    const trendScore = clampUnit(
      alignment * 0.55 +
        clampUnit((ma20Distance + 0.01) / 0.05) * 0.25 +
        clampUnit((ma5Slope + 0.005) / 0.03) * 0.2,
    );
    const return5 = close / closes.at(-6) - 1;
    const return20 = close / closes.at(-21) - 1;
    const momentumScore = clampUnit(
      clampUnit((return5 + 0.03) / 0.12) * 0.55 +
        clampUnit((return20 + 0.05) / 0.18) * 0.45,
    );
    const recentReturns = closes
      .slice(-11)
      .map((value, index, values) =>
        index ? value / values[index - 1] - 1 : null,
      )
      .filter(Number.isFinite);
    const positiveRate = recentReturns.length
      ? recentReturns.filter((value) => value > 0).length /
        recentReturns.length
      : 0;
    const consistencyScore = clampUnit(
      positiveRate * 0.65 + (close >= ma20 ? 0.35 : 0),
    );
    const benchmarkPoints = primaryBenchmark.points.slice(-21);
    const benchmarkReturn20 =
      benchmarkPoints.length >= 2
        ? benchmarkPoints.at(-1).close / benchmarkPoints[0].close - 1
        : 0;
    const relativeScore = clampUnit(
      (return20 - benchmarkReturn20 + 0.05) / 0.15,
    );
    const overheat = clampUnit(
      clampUnit((ma20Distance - 0.08) / 0.12) * 0.55 +
        clampUnit((return5 - 0.08) / 0.12) * 0.45,
    );
    const stabilityScore = 1 - overheat * 0.65;
    const priceScore =
      trendScore * 0.4 +
      momentumScore * 0.25 +
      consistencyScore * 0.13 +
      relativeScore * 0.15 +
      stabilityScore * 0.07;
    const fundCode = item.parentCode || item.code;
    const fundEntry = state.industryFundHistory.get(fundCode);
    const flows = Array.isArray(fundEntry?.flows) ? fundEntry.flows : [];
    const recentFlows = flows.slice(-5);
    const fundRatios = recentFlows
      .map((row) => Number(row.mainNetRatio))
      .filter(Number.isFinite);
    const latestFundRatio = fundRatios.at(-1) ?? null;
    const positiveFundDays = fundRatios.filter((value) => value > 0).length;
    const fundScore =
      fundRatios.length >= 3
        ? clampUnit(
            (positiveFundDays / fundRatios.length) * 0.4 +
              clampUnit((average(fundRatios.slice(-3)) + 0.02) / 0.08) * 0.2 +
              clampUnit((average(fundRatios) + 0.015) / 0.06) * 0.2 +
              clampUnit((latestFundRatio + 0.02) / 0.08) * 0.2,
          )
        : null;
    const isSecondary = Boolean(item.parentCode);
    const fundWeight = fundScore == null ? 0 : isSecondary ? 0.08 : 0.2;
    const score =
      Math.round(
        (priceScore * (1 - fundWeight) + (fundScore || 0) * fundWeight) *
          1000,
      ) / 10;
    const label =
      score >= 75
        ? "强持续"
        : score >= 60
          ? "偏持续"
          : score < 38
            ? "退潮"
            : "观察";
    return {
      score,
      label,
      metrics: {
        return5: return5 * 100,
        return20: return20 * 100,
        positiveRate: positiveRate * 100,
      },
      fund: {
        available: fundScore != null,
        score: fundScore == null ? null : Math.round(fundScore * 1000) / 10,
        weight: fundWeight * 100,
        isParentProxy: isSecondary,
        positiveDays: positiveFundDays,
        latestNetInflow:
          recentFlows.at(-1)?.mainNetInflow == null
            ? null
            : Number(recentFlows.at(-1).mainNetInflow),
        sum5: recentFlows.reduce(
          (sum, row) => sum + (Number(row.mainNetInflow) || 0),
          0,
        ),
      },
    };
  }

  async function ensureAllSecondaryIndustries() {
    if (state.secondaryIndustryRows.length) {
      return state.secondaryIndustryRows;
    }
    if (state.secondaryIndustryPromise) {
      return state.secondaryIndustryPromise;
    }
    const parentCodes = [...subIndustriesByParent.keys()];
    const rows = [];
    let cursor = 0;
    const loadNext = async () => {
      while (cursor < parentCodes.length) {
        const index = cursor;
        cursor += 1;
        const parentCode = parentCodes[index];
        try {
          const group = await ensureSubIndustryGroup(parentCode);
          rows.push(
            ...group.industries
              .filter((item) => item.points.length >= 26)
              .map((item) => ({
                ...item,
                parentCode: item.parentCode || parentCode,
              })),
          );
        } catch {
          // A failed group should not block the remaining sector tree.
        }
      }
    };
    const promise = Promise.all(
      Array.from(
        { length: Math.min(4, parentCodes.length) },
        () => loadNext(),
      ),
    ).then(() => {
      rows.sort((left, right) =>
        left.name.localeCompare(right.name, "zh-CN"),
      );
      if (!rows.length) throw new Error("No secondary industries loaded");
      state.secondaryIndustryRows = rows;
      return rows;
    });
    state.secondaryIndustryPromise = promise;
    try {
      return await promise;
    } finally {
      if (state.secondaryIndustryPromise === promise) {
        state.secondaryIndustryPromise = null;
      }
    }
  }

  function renderHeatmap(stats) {
    const isDaily = state.heatmapMode === "day";
    const isSecondary = state.industryHeatmapLevel === "secondary";
    const sourceKey = isDaily ? "points" : "weeklyPoints";
    const cellCount = isDaily ? 20 : 12;
    const periodName = isDaily ? "交易日" : "自然周";
    const levelName = isSecondary ? "二级行业" : "一级行业";
    const baseRows = isSecondary ? state.secondaryIndustryRows : stats;
    const rows = baseRows
      .map((item) => {
        const source = Array.isArray(item[sourceKey]) ? item[sourceKey] : [];
        if (source.length < cellCount + 1) return null;
        const window = source.slice(-(cellCount + 1));
        return {
          ...item,
          windowReturn: window.at(-1).close / window[0].close - 1,
          persistence: industryPersistence(item),
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.windowReturn - left.windowReturn);
    const fragment = document.createDocumentFragment();

    elements.heatmap.classList.toggle("is-daily", isDaily);
    elements.heatmap.classList.toggle("is-weekly", !isDaily);
    elements.heatmap.classList.toggle("is-secondary", isSecondary);
    elements.heatmap.setAttribute(
      "aria-label",
      isDaily
        ? `申万${levelName}最近20个交易日涨跌热力图`
        : `申万${levelName}最近12周涨跌热力图`,
    );
    elements.heatmapIntro.textContent = isSecondary
      ? `展示全部 ${rows.length} 个申万二级行业，按所选区间收益排序；综合持续性由价格趋势贡献92%、所属一级行业资金历史贡献8%。点击行业名称或任一热力格，会立即打开并定位到成分公司。`
      : `展示 ${rows.length} 个申万一级行业，按所选区间收益排序；综合持续性由价格趋势贡献80%、自身板块资金历史贡献20%，不代表未来收益。`;
    elements.heatmapLossLabel.textContent = `${isDaily ? "日" : "周"}跌幅`;
    elements.heatmapGainLabel.textContent = `${isDaily ? "日" : "周"}涨幅`;

    if (!rows.length) {
      elements.heatmap.replaceChildren();
      elements.heatmapIntro.textContent = isSecondary
        ? "正在载入全部申万二级行业数据…"
        : "暂无可用的行业轮动数据";
      return;
    }

    const corner = document.createElement("span");
    corner.className = "heat-week";
    corner.textContent = levelName;
    fragment.append(corner);
    const weekLabels = rows[0][sourceKey]
      .slice(-(cellCount + 1))
      .slice(1)
      .map((point) => point.date);
    weekLabels.forEach((date) => {
      const label = document.createElement("span");
      label.className = "heat-week";
      label.textContent = shortDate(date);
      fragment.append(label);
    });

    rows.forEach((item, rowIndex) => {
      const row = document.createElement("div");
      row.className = "heat-row-name";
      row.setAttribute("role", "row");
      const persistence = item.persistence;
      const persistenceTone = heatPersistenceTone(persistence?.label);
      const persistenceText = persistence
        ? `综合 ${persistence.score.toFixed(1)} · ${persistence.label}`
        : "持续数据待确认";
      const fund = persistence?.fund;
      const fundText = fund?.available
        ? `${fund.isParentProxy ? "所属一级资金" : "资金"} ${fund.score.toFixed(1)}`
        : "资金待载入";
      const fundTone =
        fund?.latestNetInflow > 0
          ? "is-inflow"
          : fund?.latestNetInflow < 0
            ? "is-outflow"
            : "is-neutral";
      const fundTitle = fund?.available
        ? `${fund.isParentProxy ? "所属一级行业" : "本行业"}资金分 ${fund.score.toFixed(1)}，` +
          `权重 ${fund.weight.toFixed(0)}%，近5日净流入 ${formatYi(fund.sum5)}`
        : "资金历史尚未载入";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "heat-name";
      button.setAttribute("role", "rowheader");
      button.setAttribute(
        "aria-label",
        `查看${item.name}走势，${persistenceText}，${fundText}`,
      );
      button.title = fundTitle;
      button.innerHTML = `
        <span class="heat-rank">${String(rowIndex + 1).padStart(2, "0")}</span>
        <span class="heat-name-copy">
          <span class="heat-name-text" title="${escapeHTML(isSecondary ? `${item.parentName || ""} · ${item.name}` : item.name)}">${escapeHTML(item.name)}</span>
          <span class="heat-name-meta">
            <span class="heat-persistence ${persistenceTone}">${escapeHTML(persistenceText)}</span>
            <span class="heat-fund ${fundTone}" title="${escapeHTML(fundTitle)}">${escapeHTML(fundText)}</span>
            ${isSecondary ? '<span class="heat-stock-action">查看个股 →</span>' : ""}
          </span>
        </span>
      `;
      const activateRotationRow = async () => {
        if (isSecondary && item.parentCode) {
          selectIndustry(item.parentCode);
          await selectSubIndustry(item.code);
          elements.rotationStockDrawer.scrollIntoView({
            behavior: window.matchMedia(
              "(prefers-reduced-motion: reduce)",
            ).matches
              ? "auto"
              : "smooth",
            block: "start",
          });
        } else {
          selectIndustry(item.code);
        }
      };
      button.addEventListener("click", activateRotationRow);
      row.append(button);

      const source = item[sourceKey];
      const returns = [];
      for (let index = 1; index < source.length; index += 1) {
        returns.push({
          date: source[index].date,
          value: source[index].close / source[index - 1].close - 1,
        });
      }
      returns.slice(-cellCount).forEach((observation) => {
        const cell = document.createElement("span");
        cell.className = "heat-cell";
        if (isSecondary) {
          cell.classList.add("is-navigable");
          cell.addEventListener("click", activateRotationRow);
        }
        cell.setAttribute("role", "gridcell");
        cell.setAttribute(
          "aria-label",
          `${item.name}，${observation.date}，${formatPercent(observation.value)}`,
        );
        cell.title = `${observation.date}  ${formatPercent(observation.value)}`;
        const scale = isDaily ? 0.02 : 0.045;
        const magnitude = Math.min(
          0.82,
          0.1 + (Math.abs(observation.value) / scale) * 0.72,
        );
        if (Math.abs(observation.value) < 0.0003) {
          cell.classList.add("is-flat");
        } else if (observation.value > 0) {
          cell.classList.add("is-up");
          cell.style.setProperty("--alpha", magnitude.toFixed(2));
        } else {
          cell.classList.add("is-down");
          cell.style.setProperty("--alpha", magnitude.toFixed(2));
        }
        row.append(cell);
      });
      fragment.append(row);
    });

    elements.heatmap.replaceChildren(fragment);
  }

  function frequencyLabel(frequency) {
    return {
      day: "日线",
      week: "周线",
      month: "月线",
    }[frequency];
  }

  function rollingMovingAverage(points, period) {
    const values = new Array(points.length).fill(Number.NaN);
    let sum = 0;
    points.forEach((point, index) => {
      sum += point.close;
      if (index >= period) sum -= points[index - period].close;
      if (index >= period - 1) values[index] = sum / period;
    });
    return values;
  }

  function biasSeriesFor(series, frequency = state.biasFrequency, period = state.biasMaPeriod) {
    const points = frequencyPoints(series, frequency);
    const maValues = rollingMovingAverage(points, period);
    return points
      .map((point, index) => {
        const ma = maValues[index];
        return {
          ...point,
          timestamp: parseDate(point.date),
          ma,
          value: Number.isFinite(ma) && ma > 0 ? (point.close / ma - 1) * 100 : null,
        };
      })
      .filter((point) => Number.isFinite(point.value));
  }

  function valuePercentile(values, value) {
    const valid = values.filter(Number.isFinite);
    if (!valid.length || !Number.isFinite(value)) return Number.NaN;
    const below = valid.filter((item) => item < value).length;
    const equal = valid.filter((item) => item === value).length;
    return ((below + equal * 0.5) / valid.length) * 100;
  }

  function quantile(values, ratio) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return Number.NaN;
    const position = (sorted.length - 1) * ratio;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  }

  function biasZone(percentile) {
    if (!Number.isFinite(percentile)) return "样本不足";
    if (percentile >= 80) return "历史偏高";
    if (percentile <= 20) return "历史偏低";
    return "历史中枢";
  }

  function calculateBiasRows() {
    return industries
      .map((item) => {
        const series = biasSeriesFor(item);
        if (!series.length) return null;
        const latest = series.at(-1);
        const percentileValues = series
          .slice(-BIAS_PERCENTILE_BARS[state.biasFrequency])
          .map((point) => point.value);
        const percentile = valuePercentile(percentileValues, latest.value);
        return {
          code: item.code,
          name: item.name,
          series,
          latest,
          bias: latest.value,
          close: latest.close,
          ma: latest.ma,
          percentile,
          zone: biasZone(percentile),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.bias - a.bias);
  }

  function renderBiasMetrics(rows) {
    if (!rows.length) return;
    const positive = rows.filter((item) => item.bias > 0);
    const medianBias = quantile(rows.map((item) => item.bias), 0.5);
    const strongest = rows[0];
    const weakest = rows.at(-1);

    elements.biasBreadthValue.textContent = `${positive.length} / ${rows.length}`;
    elements.biasBreadthNote.textContent =
      `${((positive.length / rows.length) * 100).toFixed(0)}% 行业高于${state.biasMaPeriod}期均线`;
    elements.biasMedianValue.textContent = formatSignedNumber(medianBias);
    elements.biasStrongValue.textContent = strongest.name;
    elements.biasStrongNote.textContent = `${formatSignedNumber(strongest.bias)} · ${strongest.zone}`;
    elements.biasWeakValue.textContent = weakest.name;
    elements.biasWeakNote.textContent = `${formatSignedNumber(weakest.bias)} · ${weakest.zone}`;
    setValueTone(elements.biasMedianValue, medianBias);
    setValueTone(elements.biasStrongNote, strongest.bias);
    setValueTone(elements.biasWeakNote, weakest.bias);
  }

  function renderBiasChartLegend(selected) {
    const items = [
      {
        label: selected.name,
        color: industryColor(selected.code),
        dashed: false,
      },
      ...benchmarks.map((item) => ({
        label: benchmarkLabelName(item.code),
        color: benchmarkVisual(item.code).color,
        dashed: true,
      })),
    ];
    elements.biasChartLegend.innerHTML = items
      .map(
        (item) => `
          <span class="bias-legend-item" style="color:${item.color}">
            <i class="${item.dashed ? "dashed" : ""}"></i>
            ${escapeHTML(item.label)}
          </span>
        `,
      )
      .join("");
  }

  function renderBiasRanking(rows) {
    const maxMagnitude = Math.max(
      1,
      ...rows.map((item) => Math.abs(item.bias)),
    );
    const fragment = document.createDocumentFragment();
    rows.forEach((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bias-rank-row";
      button.dataset.code = item.code;
      button.classList.toggle("is-selected", item.code === state.biasSelectedCode);
      button.setAttribute(
        "aria-label",
        `${item.name}，乖离率${formatSignedNumber(item.bias)}，历史分位${Number.isFinite(item.percentile) ? item.percentile.toFixed(0) : "--"}%`,
      );
      const meterWidth = Math.max(2, (Math.abs(item.bias) / maxMagnitude) * 100);
      const percentileText = Number.isFinite(item.percentile)
        ? `历史 P${item.percentile.toFixed(0)} · ${item.zone}`
        : "历史样本不足";
      button.innerHTML = `
        <span class="bias-rank-number">${String(index + 1).padStart(2, "0")}</span>
        <span>
          <span class="bias-rank-name">${escapeHTML(item.name)}</span>
          <span class="bias-rank-percentile">${percentileText}</span>
        </span>
        <span class="bias-rank-meter" aria-hidden="true">
          <i class="${item.bias >= 0 ? "is-up" : "is-down"}" style="width:${meterWidth.toFixed(1)}%"></i>
        </span>
        <span class="bias-rank-value ${item.bias >= 0 ? "up-text" : "down-text"}">
          ${formatSignedNumber(item.bias)}
        </span>
      `;
      button.addEventListener("click", () => {
        state.biasSelectedCode = item.code;
        renderBiasView();
      });
      fragment.append(button);
    });
    elements.biasRankingList.replaceChildren(fragment);
  }

  function renderBiasStats(selected) {
    elements.biasStatCurrent.textContent = formatSignedNumber(selected.bias);
    elements.biasStatPercentile.textContent = Number.isFinite(selected.percentile)
      ? `P${selected.percentile.toFixed(0)}`
      : "--";
    elements.biasStatMa.textContent =
      `${selected.close.toFixed(1)} / ${selected.ma.toFixed(1)}`;
    elements.biasStatZone.textContent = selected.zone;
    setValueTone(elements.biasStatCurrent, selected.bias);
    elements.biasStatPercentile.classList.toggle("up-text", selected.percentile >= 80);
    elements.biasStatPercentile.classList.toggle("down-text", selected.percentile <= 20);
    elements.biasStatZone.classList.toggle("up-text", selected.percentile >= 80);
    elements.biasStatZone.classList.toggle("down-text", selected.percentile <= 20);
  }

  function drawBiasChart(selected) {
    if (!selected || !elements.biasChartWrap.clientWidth) return;
    const width = Math.max(320, elements.biasChartWrap.clientWidth);
    const height = Math.max(280, elements.biasChartWrap.clientHeight);
    const margin = {
      top: 18,
      right: width < 460 ? 100 : width < 720 ? 108 : 122,
      bottom: 30,
      left: width < 460 ? 44 : 52,
    };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const selectedSeries = selected.series.slice(
      -BIAS_HISTORY_BARS[state.biasFrequency],
    );
    if (!selectedSeries.length) return;
    const startTimestamp = selectedSeries[0].timestamp;
    const endTimestamp = selectedSeries.at(-1).timestamp;

    const benchmarkSeries = benchmarks
      .map((item) => {
        const points = biasSeriesFor(item)
          .filter(
            (point) =>
              point.timestamp >= startTimestamp &&
              point.timestamp <= endTimestamp,
          );
        return points.length
          ? {
              code: item.code,
              name: item.name,
              color: benchmarkVisual(item.code).color,
              dash: benchmarkVisual(item.code).dash,
              points,
            }
          : null;
      })
      .filter(Boolean);

    const percentileValues = selected.series
      .slice(-BIAS_PERCENTILE_BARS[state.biasFrequency])
      .map((point) => point.value);
    const percentile20 = quantile(percentileValues, 0.2);
    const percentile80 = quantile(percentileValues, 0.8);
    const values = [
      0,
      percentile20,
      percentile80,
      ...selectedSeries.map((point) => point.value),
      ...benchmarkSeries.flatMap((line) =>
        line.points.map((point) => point.value),
      ),
    ].filter(Number.isFinite);
    const rawMinimum = Math.min(...values);
    const rawMaximum = Math.max(...values);
    const rawPadding = Math.max(0.45, (rawMaximum - rawMinimum) * 0.08);
    const yDomain = yTicks(rawMinimum - rawPadding, rawMaximum + rawPadding);
    const xScale = (value) =>
      margin.left +
      ((value - startTimestamp) / Math.max(1, endTimestamp - startTimestamp)) *
        plotWidth;
    const yScale = (value) =>
      margin.top +
      (1 - (value - yDomain.min) / (yDomain.max - yDomain.min)) * plotHeight;

    elements.biasChart.setAttribute("viewBox", `0 0 ${width} ${height}`);
    elements.biasChart.setAttribute(
      "aria-label",
      `${selected.name}与主要指数相对${state.biasMaPeriod}期均线的乖离率历史`,
    );
    elements.biasChart.replaceChildren();
    const desc = document.createElementNS(SVG_NS, "desc");
    desc.id = "bias-chart-desc";
    desc.textContent =
      `${selected.name}${frequencyLabel(state.biasFrequency)}MA${state.biasMaPeriod}乖离率；` +
      "虚线为上证指数、沪深300、中证1000和中证2000的同周期乖离率。";
    elements.biasChart.append(desc);

    yDomain.ticks.forEach((tick) => {
      const y = yScale(tick);
      elements.biasChart.append(
        svgElement("line", {
          x1: margin.left,
          y1: y,
          x2: width - margin.right,
          y2: y,
          class: Math.abs(tick) < 1e-9 ? "bias-zero-line" : "bias-grid-line",
        }),
      );
      const label = svgElement("text", {
        x: margin.left - 9,
        y: y + 3,
        "text-anchor": "end",
      });
      label.textContent = formatSignedNumber(tick, Math.abs(tick) < 10 ? 1 : 0);
      elements.biasChart.append(label);
    });

    [
      { value: percentile20, label: "P20" },
      { value: percentile80, label: "P80" },
    ].forEach((reference) => {
      if (
        !Number.isFinite(reference.value) ||
        reference.value <= yDomain.min ||
        reference.value >= yDomain.max
      ) {
        return;
      }
      const y = yScale(reference.value);
      elements.biasChart.append(
        svgElement("line", {
          x1: margin.left,
          y1: y,
          x2: width - margin.right,
          y2: y,
          class: "bias-reference-line",
        }),
      );
      const label = svgElement("text", {
        x: width - margin.right - 5,
        y: y - 5,
        "text-anchor": "end",
      });
      label.textContent = `${reference.label} ${formatSignedNumber(reference.value)}`;
      elements.biasChart.append(label);
    });

    const xTickCount = width < 460 ? 3 : width < 720 ? 5 : 6;
    for (let index = 0; index < xTickCount; index += 1) {
      const timestamp =
        startTimestamp +
        ((endTimestamp - startTimestamp) * index) / (xTickCount - 1);
      const date = new Date(timestamp);
      const label = svgElement("text", {
        x: xScale(timestamp),
        y: height - 8,
        "text-anchor":
          index === 0 ? "start" : index === xTickCount - 1 ? "end" : "middle",
      });
      label.textContent = [
        String(date.getFullYear()).slice(2),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
      ].join("/");
      elements.biasChart.append(label);
    }

    benchmarkSeries.forEach((line) => {
      elements.biasChart.append(
        svgElement("path", {
          d: pathFrom(line.points, xScale, yScale),
          class: "bias-benchmark-line",
          style: `stroke:${line.color};stroke-dasharray:${line.dash}`,
        }),
      );
    });
    const industryLine = {
      code: selected.code,
      name: selected.name,
      color: industryColor(selected.code),
      points: selectedSeries,
    };
    elements.biasChart.append(
      svgElement("path", {
        d: pathFrom(industryLine.points, xScale, yScale),
        class: "bias-industry-line",
        style: `stroke:${industryLine.color}`,
      }),
    );
    addBenchmarkEndLabels(
      elements.biasChart,
      benchmarkSeries,
      xScale,
      yScale,
      margin,
      width,
      plotHeight,
    );

    const hoverGroup = svgElement("g", { "aria-hidden": "true", opacity: "0" });
    const crosshair = svgElement("line", {
      class: "bias-crosshair",
      y1: margin.top,
      y2: margin.top + plotHeight,
    });
    const industryDot = svgElement("circle", {
      r: 4,
      fill: industryLine.color,
      class: "bias-hover-dot",
    });
    const benchDots = benchmarkSeries.map((line) => {
      const dot = svgElement("circle", {
        r: 3.4,
        fill: line.color,
        class: "bias-hover-dot",
      });
      hoverGroup.append(dot);
      return { code: line.code, dot };
    });
    hoverGroup.append(crosshair, industryDot);
    elements.biasChart.append(hoverGroup);

    state.biasChartGeometry = {
      width,
      height,
      margin,
      plotWidth,
      plotHeight,
      startTimestamp,
      endTimestamp,
      xScale,
      yScale,
      industryLine,
      benchmarkSeries,
      hoverGroup,
      crosshair,
      industryDot,
      benchDots,
    };
  }

  function handleBiasChartPointer(event) {
    const geometry = state.biasChartGeometry;
    if (!geometry) return;
    const bounds = elements.biasChart.getBoundingClientRect();
    const localX = Math.min(
      geometry.width - geometry.margin.right,
      Math.max(geometry.margin.left, event.clientX - bounds.left),
    );
    const ratio =
      (localX - geometry.margin.left) /
      Math.max(
        1,
        geometry.width - geometry.margin.left - geometry.margin.right,
      );
    const timestamp =
      geometry.startTimestamp +
      ratio * (geometry.endTimestamp - geometry.startTimestamp);
    const industryPoint = nearestPoint(
      geometry.industryLine.points,
      timestamp,
    );
    const benchmarkPoints = geometry.benchmarkSeries.map((line) => ({
      ...line,
      point: nearestPoint(line.points, timestamp),
    }));
    const x = geometry.xScale(industryPoint.timestamp);
    geometry.hoverGroup.setAttribute("opacity", "1");
    geometry.crosshair.setAttribute("x1", x);
    geometry.crosshair.setAttribute("x2", x);
    geometry.industryDot.setAttribute("cx", x);
    geometry.industryDot.setAttribute("cy", geometry.yScale(industryPoint.value));
    geometry.benchDots.forEach(({ code, dot }) => {
      const line = benchmarkPoints.find((item) => item.code === code);
      dot.setAttribute("cx", geometry.xScale(line.point.timestamp));
      dot.setAttribute("cy", geometry.yScale(line.point.value));
    });
    renderChartReadout(
      elements.biasChartTooltip,
      industryPoint.date,
      geometry.industryLine.name,
      geometry.industryLine.color,
      [
        {
          label: "行业乖离",
          value: formatSignedNumber(industryPoint.value),
          color: geometry.industryLine.color,
        },
        ...benchmarkPoints.map((item) => ({
          label: benchmarkLabelName(item.code),
          value: formatSignedNumber(item.point.value),
          color: item.color,
        })),
      ],
    );
  }

  function hideBiasChartPointer() {
    if (state.biasChartGeometry) {
      state.biasChartGeometry.hoverGroup.setAttribute("opacity", "0");
    }
    elements.biasChartTooltip.textContent =
      "移到曲线上查看行业和大盘指数的乖离率";
  }

  function renderBiasView() {
    const rows = calculateBiasRows();
    if (!rows.length) return;
    if (!rows.some((item) => item.code === state.biasSelectedCode)) {
      state.biasSelectedCode = rows.some(
        (item) => item.code === state.selectedCode,
      )
        ? state.selectedCode
        : rows[0].code;
    }
    const selected = rows.find(
      (item) => item.code === state.biasSelectedCode,
    );
    elements.biasChartHeading.textContent = `${selected.name}乖离率`;
    elements.biasChartCaption.textContent =
      `${frequencyLabel(state.biasFrequency)} MA${state.biasMaPeriod}；` +
      "虚线为上证、沪深300、中证1000、中证2000；浅绿色参考线为本行业历史 P20 / P80，不代表买卖阈值。";
    elements.biasRankingLabel.textContent =
      `MA${state.biasMaPeriod} · ${frequencyLabel(state.biasFrequency)}`;
    renderBiasMetrics(rows);
    renderBiasChartLegend(selected);
    renderBiasRanking(rows);
    renderBiasStats(selected);
    drawBiasChart(selected);
  }

  function renderBiasMaOptions() {
    const options = BIAS_MA_OPTIONS[state.biasFrequency];
    if (!options.includes(state.biasMaPeriod)) {
      state.biasMaPeriod = options[0];
    }
    const fragment = document.createDocumentFragment();
    options.forEach((period) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.biasMa = String(period);
      button.textContent = `MA${period}`;
      const active = period === state.biasMaPeriod;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
      fragment.append(button);
    });
    elements.biasMaControl.replaceChildren(fragment);
  }

  function setBiasFrequency(frequency) {
    if (!BIAS_MA_OPTIONS[frequency]) return;
    state.biasFrequency = frequency;
    state.biasMaPeriod = BIAS_MA_OPTIONS[frequency][0];
    elements.biasFrequencyControl
      .querySelectorAll("button[data-bias-frequency]")
      .forEach((button) => {
        const active = button.dataset.biasFrequency === frequency;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", String(active));
      });
    renderBiasMaOptions();
    if (state.activeView === "bias") {
      elements.frequencyBadge.textContent = frequencyLabel(frequency);
      requestAnimationFrame(renderBiasView);
    }
  }

  function setBiasMaPeriod(period) {
    if (!BIAS_MA_OPTIONS[state.biasFrequency].includes(period)) return;
    state.biasMaPeriod = period;
    renderBiasMaOptions();
    if (state.activeView === "bias") requestAnimationFrame(renderBiasView);
  }

  function svgElement(tag, attributes = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  }

  function niceStep(range, targetTicks) {
    const rough = Math.max(0.1, range / targetTicks);
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const normalized = rough / magnitude;
    const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return nice * magnitude;
  }

  function yTicks(min, max) {
    const step = niceStep(max - min, 4);
    const first = Math.floor(min / step) * step;
    const last = Math.ceil(max / step) * step;
    const ticks = [];
    for (let value = first; value <= last + step * 0.25; value += step) {
      ticks.push(Number(value.toFixed(6)));
    }
    return { ticks, min: first, max: last };
  }

  function pathFrom(points, xScale, yScale) {
    return points
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"}${xScale(point.timestamp).toFixed(2)},${yScale(point.value).toFixed(2)}`,
      )
      .join(" ");
  }

  function addBenchmarkEndLabels(svg, series, xScale, yScale, margin, width, plotHeight) {
    const plotRight = width - margin.right;
    const plotBottom = margin.top + plotHeight;
    const labelX = plotRight + 15;
    const labels = series
      .map((line) => {
        const point = line.points.at(-1);
        return {
          code: line.code,
          endX: xScale(point.timestamp),
          actualY: yScale(point.value),
          labelY: yScale(point.value),
          value: point.value,
        };
      })
      .sort((a, b) => a.labelY - b.labelY);
    const gap = 14;
    labels.forEach((label, index) => {
      if (index > 0) {
        label.labelY = Math.max(label.labelY, labels[index - 1].labelY + gap);
      }
    });
    const overflow = (labels.at(-1)?.labelY || plotBottom) - plotBottom;
    if (overflow > 0) {
      labels.forEach((label) => {
        label.labelY -= overflow;
      });
    }
    for (let index = labels.length - 2; index >= 0; index -= 1) {
      labels[index].labelY = Math.min(
        labels[index].labelY,
        labels[index + 1].labelY - gap,
      );
    }
    labels.forEach((label) => {
      const visual = benchmarkVisual(label.code);
      label.labelY = Math.min(
        plotBottom,
        Math.max(margin.top + 6, label.labelY),
      );
      const connector = svgElement("path", {
        class: "benchmark-end-connector",
        d: `M${label.endX.toFixed(2)},${label.actualY.toFixed(2)} L${(
          plotRight + 6
        ).toFixed(2)},${label.labelY.toFixed(2)} L${(labelX - 5).toFixed(
          2,
        )},${label.labelY.toFixed(2)}`,
        style: `stroke:${visual.color};stroke-dasharray:2 2`,
      });
      const swatch = svgElement("line", {
        x1: labelX,
        y1: label.labelY,
        x2: labelX + 9,
        y2: label.labelY,
        style: `stroke:${visual.color};stroke-width:2;stroke-dasharray:${visual.dash}`,
      });
      const text = svgElement("text", {
        x: labelX + 13,
        y: label.labelY + 3,
        class: "benchmark-end-label",
        style: `fill:${visual.color}`,
      });
      text.textContent = `${benchmarkLabelName(label.code)} ${formatSignedNumber(
        label.value,
      )}`;
      svg.append(connector, swatch, text);
    });
  }

  function drawChart() {
    const parentIndustry = industryByCode.get(state.selectedCode);
    if (!parentIndustry) return;
    const subIndustryGroup = state.subIndustryGroups.get(state.selectedCode);
    const isOverview = Boolean(
      state.showAllSubIndustries && subIndustryGroup?.industries.length,
    );
    const singleIndustry = calculatePeriod(parentIndustry, state.weeks);
    const chartIndustries = isOverview
      ? subIndustryGroup.industries
          .map((item) => calculatePeriod(item, state.weeks))
          .sort((a, b) => b.periodReturn - a.periodReturn)
      : [singleIndustry];

    const width = Math.max(320, elements.chartWrap.clientWidth);
    const height = Math.max(260, elements.chartWrap.clientHeight);
    const margin = {
      top: 12,
      right: width < 460 ? 112 : width < 720 ? 104 : 116,
      bottom: 30,
      left: width < 460 ? 42 : 52,
    };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const startDate = getStartDate(state.weeks);
    const industrySeries = chartIndustries.map((item) => {
      const points = item.visible;
      const base = points[0].close;
      return {
        code: item.code,
        name: item.name,
        color: industryColor(item.code),
        points: points.map((point) => ({
          ...point,
          timestamp: parseDate(point.date),
          value: (point.close / base - 1) * 100,
        })),
      };
    });
    const benchSeries = benchmarks.map((benchmarkItem) => {
      const points = visiblePoints(
        frequencyPoints(benchmarkItem, state.frequency),
        startDate,
      );
      const base = points[0].close;
      return {
        code: benchmarkItem.code,
        name: benchmarkItem.name,
        points: points.map((point) => ({
          ...point,
          timestamp: parseDate(point.date),
          value: (point.close / base - 1) * 100,
        })),
      };
    });
    const allValues = [
      ...industrySeries.flatMap((line) =>
        line.points.map((point) => point.value),
      ),
      ...benchSeries.flatMap((line) => line.points.map((point) => point.value)),
    ];
    const minRaw = Math.min(0, ...allValues);
    const maxRaw = Math.max(0, ...allValues);
    const rawPadding = Math.max(0.4, (maxRaw - minRaw) * 0.12);
    const yDomain = yTicks(minRaw - rawPadding, maxRaw + rawPadding);
    const startTimestamp = Math.min(
      ...industrySeries.map((line) => line.points[0].timestamp),
      ...benchSeries.flatMap((line) => line.points.map((point) => point.timestamp)),
    );
    const endTimestamp = Math.max(
      ...industrySeries.map((line) => line.points.at(-1).timestamp),
      ...benchSeries.flatMap((line) => line.points.map((point) => point.timestamp)),
    );
    const xScale = (value) =>
      margin.left + ((value - startTimestamp) / Math.max(1, endTimestamp - startTimestamp)) * plotWidth;
    const yScale = (value) =>
      margin.top + (1 - (value - yDomain.min) / (yDomain.max - yDomain.min)) * plotHeight;

    elements.chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
    elements.chart.setAttribute(
      "aria-label",
      isOverview
        ? `${parentIndustry.name}下${industrySeries.length}个二级行业与大盘指数走势对比`
        : `${chartIndustries[0].name}与大盘指数走势对比`,
    );
    elements.chart.replaceChildren();
    const desc = document.createElementNS(SVG_NS, "desc");
    desc.id = "trend-chart-desc";
    desc.textContent = `${formatDate(industrySeries[0].points[0].date)}至${formatDate(
      industrySeries[0].points.at(-1).date,
    )}的累计收益，起点归一为0%。${
      isOverview
        ? `实线为${parentIndustry.name}下的全部二级行业，`
        : `实线为${chartIndustries[0].name}，`
    }虚线依次为上证指数、沪深300、中证1000和中证2000。`;
    elements.chart.append(desc);

    yDomain.ticks.forEach((tick) => {
      const y = yScale(tick);
      const line = svgElement("line", {
        x1: margin.left,
        y1: y,
        x2: width - margin.right,
        y2: y,
        class: tick === 0 ? "zero-line" : "grid-line",
      });
      const label = svgElement("text", {
        x: margin.left - 9,
        y: y + 3,
        "text-anchor": "end",
      });
      label.textContent = formatSignedNumber(tick, Math.abs(tick) < 10 ? 1 : 0);
      elements.chart.append(line, label);
    });

    const xTickCount = width < 460 ? 3 : width < 720 ? 5 : 6;
    for (let index = 0; index < xTickCount; index += 1) {
      const timestamp =
        startTimestamp + ((endTimestamp - startTimestamp) * index) / (xTickCount - 1);
      const date = new Date(timestamp);
      const label = [
        String(date.getFullYear()).slice(2),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
      ].join("/");
      const text = svgElement("text", {
        x: xScale(timestamp),
        y: height - 8,
        "text-anchor": index === 0 ? "start" : index === xTickCount - 1 ? "end" : "middle",
      });
      text.textContent = label;
      elements.chart.append(text);
    }

    if (!isOverview) {
      const seriesPoints = industrySeries[0].points;
      const areaPath = `${pathFrom(seriesPoints, xScale, yScale)} L${xScale(
        seriesPoints.at(-1).timestamp,
      )},${yScale(0)} L${xScale(seriesPoints[0].timestamp)},${yScale(0)} Z`;
      elements.chart.append(
        svgElement("path", { d: areaPath, class: "area-fill" }),
      );
    }
    benchSeries.forEach((line) => {
      const visual = benchmarkVisual(line.code);
      elements.chart.append(
        svgElement("path", {
          d: pathFrom(line.points, xScale, yScale),
          class: "benchmark-line",
          style: `stroke:${visual.color};stroke-dasharray:${visual.dash}`,
        }),
      );
    });
    industrySeries.forEach((line) => {
      const path = svgElement("path", {
        d: pathFrom(line.points, xScale, yScale),
        class: "series-line",
        style: `stroke:${line.color}`,
      });
      elements.chart.append(path);
      line.path = path;
    });
    addBenchmarkEndLabels(
      elements.chart,
      benchSeries,
      xScale,
      yScale,
      margin,
      width,
      plotHeight,
    );

    const hoverLayer = svgElement("g", { "aria-hidden": "true", opacity: "0" });
    const crosshair = svgElement("line", {
      class: "crosshair",
      y1: margin.top,
      y2: margin.top + plotHeight,
    });
    const industryDot = svgElement("circle", {
      r: 4,
      fill: industrySeries[0].color,
      class: "hover-dot",
    });
    const benchDots = benchSeries.map((line) => {
      const dot = svgElement("circle", {
        r: 3.5,
        fill: benchmarkVisual(line.code).color,
        class: "hover-dot",
      });
      hoverLayer.append(dot);
      return { code: line.code, dot };
    });
    hoverLayer.append(crosshair, industryDot);
    elements.chart.append(hoverLayer);

    state.chartGeometry = {
      width,
      margin,
      plotWidth,
      plotHeight,
      startTimestamp,
      endTimestamp,
      xScale,
      yScale,
      industrySeries,
      benchSeries,
      hoverLayer,
      crosshair,
      industryDot,
      benchDots,
      isOverview,
    };
    applyDetailLineHighlight(null);
  }

  function applyDetailLineHighlight(code) {
    const geometry = state.chartGeometry;
    if (!geometry) return;
    const focusedCode = state.selectedSubIndustry?.code || code || null;
    geometry.industrySeries.forEach((line) => {
      const active = !focusedCode || line.code === focusedCode;
      line.path.setAttribute(
        "stroke-width",
        focusedCode ? (active ? "2.8" : "1.1") : "2.2",
      );
      line.path.setAttribute("opacity", focusedCode ? (active ? "1" : "0.14") : "1");
      line.path.setAttribute(
        "stroke-dasharray",
        focusedCode && !active ? "4 5" : "",
      );
    });
    elements.detailLegend.querySelectorAll(".detail-legend-item").forEach((button) => {
      const isSelected = button.dataset.code === state.selectedSubIndustry?.code;
      button.classList.toggle("is-hovered", button.dataset.code === code);
      button.classList.toggle("is-selected", isSelected);
      button.setAttribute("aria-pressed", String(isSelected));
    });
  }

  function nearestPoint(points, timestamp) {
    let low = 0;
    let high = points.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (points[middle].timestamp < timestamp) low = middle + 1;
      else high = middle;
    }
    const candidate = points[low];
    const previous = points[Math.max(0, low - 1)];
    return Math.abs(candidate.timestamp - timestamp) <
      Math.abs(previous.timestamp - timestamp)
      ? candidate
      : previous;
  }

  function handleChartPointer(event) {
    const geometry = state.chartGeometry;
    if (!geometry) return;
    const bounds = elements.chart.getBoundingClientRect();
    const relativeX = Math.min(
      geometry.width - geometry.margin.right,
      Math.max(geometry.margin.left, event.clientX - bounds.left),
    );
    const ratio =
      (relativeX - geometry.margin.left) /
      Math.max(1, geometry.width - geometry.margin.left - geometry.margin.right);
    const timestamp =
      geometry.startTimestamp +
      ratio * (geometry.endTimestamp - geometry.startTimestamp);
    const localY = Math.min(
      geometry.margin.top + geometry.plotHeight,
      Math.max(geometry.margin.top, event.clientY - bounds.top),
    );
    const industryPoints = geometry.industrySeries.map((line) => ({
      ...line,
      point: nearestPoint(line.points, timestamp),
    }));
    const pinnedIndustry = state.selectedSubIndustry
      ? industryPoints.find(
          (line) => line.code === state.selectedSubIndustry.code,
        )
      : null;
    const nearestIndustry = pinnedIndustry
      ? { line: pinnedIndustry, distance: 0 }
      : industryPoints.reduce((nearest, line) => {
          const distance = Math.abs(geometry.yScale(line.point.value) - localY);
          return !nearest || distance < nearest.distance
            ? { line, distance }
            : nearest;
        }, null);
    const benchPoints = geometry.benchSeries.map((line) => ({
      ...line,
      point: nearestPoint(line.points, timestamp),
    }));
    const x = geometry.xScale(nearestIndustry.line.point.timestamp);

    applyDetailLineHighlight(nearestIndustry.line.code);
    geometry.hoverLayer.setAttribute("opacity", "1");
    geometry.crosshair.setAttribute("x1", x);
    geometry.crosshair.setAttribute("x2", x);
    geometry.industryDot.setAttribute("cx", x);
    geometry.industryDot.setAttribute(
      "cy",
      geometry.yScale(nearestIndustry.line.point.value),
    );
    geometry.industryDot.setAttribute("fill", nearestIndustry.line.color);
    geometry.benchDots.forEach(({ code, dot }) => {
      const line = benchPoints.find((item) => item.code === code);
      dot.setAttribute("cx", geometry.xScale(line.point.timestamp));
      dot.setAttribute("cy", geometry.yScale(line.point.value));
    });

    renderChartReadout(
      elements.chartTooltip,
      nearestIndustry.line.point.date,
      nearestIndustry.line.name,
      nearestIndustry.line.color,
      [
        {
          label: "行业",
          value: formatSignedNumber(nearestIndustry.line.point.value),
          color: nearestIndustry.line.color,
        },
        ...benchPoints.map((item) => ({
          label: benchmarkLabelName(item.code),
          value: formatSignedNumber(item.point.value),
          color: benchmarkVisual(item.code).color,
        })),
      ],
    );
  }

  function hideChartPointer() {
    if (state.chartGeometry) {
      state.chartGeometry.hoverLayer.setAttribute("opacity", "0");
    }
    applyDetailLineHighlight(null);
    elements.chartTooltip.textContent = state.chartGeometry?.isOverview
      ? "移到曲线上查看各二级行业与四条大盘指数的数值"
      : "移到曲线上查看所选行业与四条大盘指数的数值";
  }

  function handleAllChartPointer(event) {
    const geometry = state.allChartGeometry;
    if (!geometry) return;
    const bounds = elements.allChart.getBoundingClientRect();
    const localX = Math.min(
      geometry.width - geometry.margin.right,
      Math.max(geometry.margin.left, event.clientX - bounds.left),
    );
    const localY = Math.min(
      geometry.height - geometry.margin.bottom,
      Math.max(geometry.margin.top, event.clientY - bounds.top),
    );
    const ratio =
      (localX - geometry.margin.left) /
      Math.max(1, geometry.width - geometry.margin.left - geometry.margin.right);
    const timestamp =
      geometry.startTimestamp +
      ratio * (geometry.endTimestamp - geometry.startTimestamp);
    let nearest = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    geometry.lines.forEach((line) => {
      const point = nearestPoint(line.points, timestamp);
      const distance = Math.abs(geometry.yScale(point.value) - localY);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = { line, point };
      }
    });
    if (!nearest || nearestDistance > (bounds.width < 480 ? 28 : 20)) {
      hideAllChartPointer();
      return;
    }

    applyAllLineHighlight(nearest.line.code);
    const x = geometry.xScale(nearest.point.timestamp);
    const y = geometry.yScale(nearest.point.value);
    const benchmarkPoints = geometry.benchmarkSeries.map((item) => ({
      ...item,
      point: nearestPoint(item.points, nearest.point.timestamp),
    }));
    const primaryBenchmarkPoint =
      benchmarkPoints.find((item) => item.code === "000300")?.point ||
      benchmarkPoints[0].point;
    const relativePerformance = nearest.point.value - primaryBenchmarkPoint.value;
    geometry.hoverGroup.setAttribute("opacity", "1");
    geometry.crosshair.setAttribute("x1", x);
    geometry.crosshair.setAttribute("x2", x);
    geometry.hoverDot.setAttribute("cx", x);
    geometry.hoverDot.setAttribute("cy", y);
    geometry.hoverDot.setAttribute("fill", nearest.line.color);
    renderChartReadout(
      elements.allChartTooltip,
      nearest.point.date,
      nearest.line.name,
      nearest.line.color,
      [
        {
          label: "行业",
          value: formatSignedNumber(nearest.point.value),
          color: nearest.line.color,
        },
        ...benchmarkPoints.map((item) => ({
          label: benchmarkLabelName(item.code),
          value: formatSignedNumber(item.point.value),
          color: benchmarkVisual(item.code).color,
        })),
        {
          label: "相对沪深300",
          value: `${relativePerformance > 0 ? "+" : ""}${relativePerformance.toFixed(1)}pp`,
        },
      ],
    );
  }

  function hideAllChartPointer() {
    if (state.allChartGeometry) {
      state.allChartGeometry.hoverGroup.setAttribute("opacity", "0");
    }
    elements.allChartTooltip.textContent = "移到曲线上查看行业与四条大盘指数的同日数值";
    applyAllLineHighlight(null);
  }

  function renderDetailLegend(items, interactive = false) {
    const fragment = document.createDocumentFragment();
    items.forEach((item) => {
      const industryEntry = document.createElement(interactive ? "button" : "span");
      if (interactive) industryEntry.type = "button";
      industryEntry.className = "detail-legend-item";
      industryEntry.dataset.code = item.code;
      industryEntry.innerHTML = `
        <i class="legend-line" style="background:${industryColor(item.code)}"></i>
        <span>${escapeHTML(item.name)}</span>
      `;
      if (interactive) {
        industryEntry.setAttribute(
          "aria-label",
          `突出${item.name}，其他二级行业变虚`,
        );
        industryEntry.addEventListener("mouseenter", () =>
          applyDetailLineHighlight(item.code),
        );
        industryEntry.addEventListener("mouseleave", () =>
          applyDetailLineHighlight(null),
        );
        industryEntry.addEventListener("focus", () =>
          applyDetailLineHighlight(item.code),
        );
        industryEntry.addEventListener("blur", () =>
          applyDetailLineHighlight(null),
        );
        industryEntry.addEventListener("click", () => selectSubIndustry(item.code));
      }
      fragment.append(industryEntry);
    });
    benchmarks.forEach((benchmarkItem) => {
      const visual = benchmarkVisual(benchmarkItem.code);
      const entry = document.createElement("span");
      entry.innerHTML = `
        <i class="legend-line benchmark ${visual.className}"></i>
        <span>${escapeHTML(benchmarkItem.name)}</span>
      `;
      fragment.append(entry);
    });
    elements.detailLegend.replaceChildren(fragment);
  }

  function ensureSubIndustryGroup(parentCode) {
    if (state.subIndustryGroups.has(parentCode)) {
      return Promise.resolve(state.subIndustryGroups.get(parentCode));
    }
    const standalonePayload = standalone?.level2?.[parentCode];
    if (standalonePayload) {
      const prepared = {
        ...standalonePayload,
        industries: standalonePayload.industries.map(prepareIndustrySeries),
      };
      state.subIndustryGroups.set(parentCode, prepared);
      return Promise.resolve(prepared);
    }
    if (state.subIndustryLoads.has(parentCode)) {
      return state.subIndustryLoads.get(parentCode);
    }
    const request = fetch(`/api/level2?parent=${encodeURIComponent(parentCode)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const prepared = {
          ...payload,
          industries: payload.industries.map(prepareIndustrySeries),
        };
        state.subIndustryGroups.set(parentCode, prepared);
        return prepared;
      })
      .finally(() => {
        state.subIndustryLoads.delete(parentCode);
      });
    state.subIndustryLoads.set(parentCode, request);
    return request;
  }

  function updateSubIndustryOptions(parentCode) {
    const children = subIndustriesByParent.get(parentCode) || [];
    const fragment = document.createDocumentFragment();
    if (children.length) {
      const all = document.createElement("option");
      all.value = ALL_SUB_INDUSTRIES;
      all.textContent = `全部二级行业（${children.length}条）`;
      fragment.append(all);
    }
    const whole = document.createElement("option");
    whole.value = "";
    whole.textContent = "一级行业整体";
    fragment.append(whole);
    children
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
      .forEach((item) => {
        const option = document.createElement("option");
        option.value = item.code;
        option.textContent = item.name;
        fragment.append(option);
      });
    elements.subSelect.replaceChildren(fragment);
    state.selectedSubIndustry = null;
    state.showAllSubIndustries = children.length > 0;
    elements.subSelect.value = state.showAllSubIndustries
      ? ALL_SUB_INDUSTRIES
      : "";
    elements.subSelect.disabled = children.length === 0;
    elements.subSelectNote.textContent = children.length
      ? `全部 ${children.length} 个二级行业，正在载入走势…`
      : "该一级行业暂无二级分类";
    if (!children.length) return;
    ensureSubIndustryGroup(parentCode)
      .then(() => {
        if (
          state.selectedCode === parentCode &&
          state.showAllSubIndustries &&
          !state.selectedSubIndustry
        ) {
          elements.subSelectNote.textContent = `已展示全部 ${children.length} 个二级行业`;
          renderSelection();
        }
      })
      .catch(() => {
        if (state.selectedCode === parentCode) {
          elements.subSelectNote.textContent = "二级行业数据载入失败";
        }
      });
  }

  function ensureCompanies(industryCode, force = false) {
    const cached = state.companyGroups.get(industryCode);
    const loadedAt = state.companyLoadedAt.get(industryCode) || 0;
    if (cached && !force && Date.now() - loadedAt < 120_000) {
      return Promise.resolve(cached);
    }
    const standalonePayload = standalone?.companies?.[industryCode];
    if (standalonePayload) {
      state.companyGroups.set(industryCode, standalonePayload);
      return Promise.resolve(standalonePayload);
    }
    if (state.companyLoads.has(industryCode)) {
      return state.companyLoads.get(industryCode);
    }
    const refresh = force || Date.now() - loadedAt >= 120_000;
    const request = fetch(
      `/api/companies?industry=${encodeURIComponent(industryCode)}` +
        (refresh ? "&refresh=1" : ""),
      { cache: "no-store" },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (!Array.isArray(payload.companies)) {
          throw new Error("Invalid company data");
        }
        state.companyGroups.set(industryCode, payload);
        state.companyLoadedAt.set(industryCode, Date.now());
        return payload;
      })
      .finally(() => {
        state.companyLoads.delete(industryCode);
      });
    state.companyLoads.set(industryCode, request);
    return request;
  }

  function ensureCompanyInfo(securityCode, force = false) {
    const cached = state.companyInfoGroups.get(securityCode);
    const loadedAt = state.companyInfoLoadedAt.get(securityCode) || 0;
    if (cached && !force && Date.now() - loadedAt < 120_000) {
      return Promise.resolve(cached);
    }
    const standalonePayload =
      standalone?.companyInfo?.[securityCode.toUpperCase()];
    if (standalonePayload) {
      state.companyInfoGroups.set(securityCode, standalonePayload);
      return Promise.resolve(standalonePayload);
    }
    if (standalone) {
      return Promise.reject(new Error("Company detail is not included in standalone mode"));
    }
    if (state.companyInfoLoads.has(securityCode)) {
      return state.companyInfoLoads.get(securityCode);
    }
    const refresh = force || Date.now() - loadedAt >= 120_000;
    const request = fetch(
      `/api/company-info?code=${encodeURIComponent(securityCode)}` +
        (refresh ? "&refresh=1" : ""),
      { cache: "no-store" },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        state.companyInfoGroups.set(securityCode, payload);
        state.companyInfoLoadedAt.set(securityCode, Date.now());
        return payload;
      })
      .finally(() => {
        state.companyInfoLoads.delete(securityCode);
      });
    state.companyInfoLoads.set(securityCode, request);
    return request;
  }

  function hideCompanyInfo() {
    state.companyInfoRequestId += 1;
    state.selectedCompanyCode = null;
    elements.companyDetail.hidden = true;
    elements.companyDetailBody.replaceChildren();
    elements.companyTableBody
      .querySelectorAll("tr.is-selected")
      .forEach((row) => row.classList.remove("is-selected"));
  }

  function appendCompanyFact(list, label, value, options = {}) {
    const wrapper = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = label;
    if (options.link && value) {
      const anchor = document.createElement("a");
      const normalized = /^https?:\/\//i.test(value)
        ? value
        : `https://${value}`;
      anchor.href = normalized;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = value;
      detail.append(anchor);
    } else {
      detail.textContent = value || "—";
    }
    wrapper.append(term, detail);
    list.append(wrapper);
  }

  function appendCompanyCopy(container, title, text) {
    const section = document.createElement("section");
    const heading = document.createElement("h5");
    const copy = document.createElement("p");
    heading.textContent = title;
    copy.textContent = text || "暂无资料";
    section.append(heading, copy);
    container.append(section);
  }

  function companyPeriodReturn(points, days, endDate) {
    const eligible = points.filter((point) => point.date <= endDate);
    if (eligible.length <= days) return null;
    const end = eligible.at(-1).close;
    const start = eligible.at(-1 - days).close;
    if (!start) return null;
    return (end / start - 1) * 100;
  }

  function createInvestmentMetric(label, value, note, tone = "") {
    const item = document.createElement("div");
    item.className = "investment-metric";
    item.innerHTML = `
      <span class="investment-metric-label">${escapeHTML(label)}</span>
      <strong class="investment-metric-value ${tone}">${escapeHTML(value)}</strong>
      <span class="investment-metric-note">${escapeHTML(note || "")}</span>
    `;
    return item;
  }

  function createInvestmentSection(title, caption, metrics, footer = "") {
    const section = document.createElement("section");
    section.className = "investment-section";
    section.innerHTML = `
      <div class="investment-section-heading">
        <h5>${escapeHTML(title)}</h5>
        <span>${escapeHTML(caption)}</span>
      </div>
      <div class="investment-metrics"></div>
    `;
    const metricContainer = section.querySelector(".investment-metrics");
    metrics.forEach((metric) => {
      metricContainer.append(
        createInvestmentMetric(
          metric.label,
          metric.value,
          metric.note,
          metric.tone,
        ),
      );
    });
    if (footer) {
      const note = document.createElement("p");
      note.className = "investment-section-note";
      note.textContent = footer;
      section.append(note);
    }
    return section;
  }

  function metricTone(value) {
    return value > 0 ? "up-text" : value < 0 ? "down-text" : "";
  }

  function formatRate(value, digits = 2, signed = false) {
    if (!Number.isFinite(value)) return "—";
    return `${signed && value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
  }

  function formatYi(value, digits = 2, signed = true) {
    if (!Number.isFinite(value)) return "—";
    const amount = value / 100_000_000;
    const prefix = signed && amount > 0 ? "+" : "";
    const precision = Math.abs(amount) >= 100 ? 1 : digits;
    return `${prefix}${amount.toFixed(precision)}亿`;
  }

  function formatAdaptiveFlow(value, digits = 2) {
    if (!Number.isFinite(value)) return "—";
    if (Math.abs(value) < 10_000_000) {
      const prefix = value > 0 ? "+" : "";
      return `${prefix}${Math.round(value / 10_000)}万`;
    }
    return formatYi(value, digits);
  }

  function formatMultiple(value) {
    return Number.isFinite(value) ? `${value.toFixed(2)}x` : "—";
  }

  function formatFlowTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "时间未知";
    return date.toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }

  function isChinaTradingWindow(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    if (["Sat", "Sun"].includes(values.weekday)) return false;
    const minuteOfDay = Number(values.hour) * 60 + Number(values.minute);
    return (
      (minuteOfDay >= 9 * 60 + 15 && minuteOfDay <= 11 * 60 + 35) ||
      (minuteOfDay >= 12 * 60 + 55 && minuteOfDay <= 15 * 60 + 10)
    );
  }

  function renderMarketPulse(payload) {
    state.marketPulsePayload = payload;
    const market = payload?.market || {};
    const breadth = payload?.breadth || {};
    const buckets = Array.isArray(breadth.buckets) ? breadth.buckets : [];
    elements.marketPulseTime.textContent = market.isFinal && payload?.sourceDate
      ? `收盘 ${formatDate(payload.sourceDate)}`
      : payload?.quoteTime
        ? `市场快照 ${formatFlowTime(payload.quoteTime)}`
        : "市场快照";
    if (!buckets.length) {
      elements.marketBreadthChart.innerHTML =
        '<p class="flow-empty">涨跌分布暂时不可用。</p>';
      elements.marketBreadthTotals.replaceChildren();
      return;
    }

    const maxCount = Math.max(1, ...buckets.map((item) => item.count || 0));
    elements.marketBreadthSummary.textContent =
      `实际涨跌停 ${breadth.limitUpCount || 0}:${breadth.limitDownCount || 0}`;
    elements.marketBreadthChart.innerHTML = buckets
      .map((item) => {
        const height = Math.max(2.5, ((item.count || 0) / maxCount) * 100);
        const tone = ["up-strong", "up", "up-soft"].includes(item.tone)
          ? item.tone.includes("soft")
            ? "up-soft"
            : "up"
          : ["down-strong", "down", "down-soft"].includes(item.tone)
            ? item.tone.includes("soft")
              ? "down-soft"
              : "down"
            : "flat";
        return `
          <div class="market-breadth-column ${tone}" title="${escapeHTML(item.label)}：${Number(item.count || 0)}家">
            <span class="market-breadth-count">${Number(item.count || 0)}</span>
            <span class="market-breadth-bar-track">
              <i class="market-breadth-bar" style="height:${height.toFixed(1)}%"></i>
            </span>
            <span class="market-breadth-label">${escapeHTML(item.label)}</span>
          </div>
        `;
      })
      .join("");

    const total = Math.max(
      1,
      Number(breadth.upCount || 0) +
        Number(breadth.flatCount || 0) +
        Number(breadth.downCount || 0),
    );
    const upWidth = (Number(breadth.upCount || 0) / total) * 100;
    const flatWidth = (Number(breadth.flatCount || 0) / total) * 100;
    const downWidth = (Number(breadth.downCount || 0) / total) * 100;
    elements.marketBreadthTotals.innerHTML = `
      <div class="market-breadth-ratio" aria-label="上涨${breadth.upCount || 0}家，平盘${breadth.flatCount || 0}家，下跌${breadth.downCount || 0}家">
        <span class="up" style="width:${upWidth.toFixed(2)}%"></span>
        <span class="flat" style="width:${flatWidth.toFixed(2)}%"></span>
        <span class="down" style="width:${downWidth.toFixed(2)}%"></span>
      </div>
      <div class="market-breadth-legend">
        <span class="up">涨 ${Number(breadth.upCount || 0).toLocaleString()} 家</span>
        <span class="flat">平 ${Number(breadth.flatCount || 0).toLocaleString()} 家</span>
        <span class="down">跌 ${Number(breadth.downCount || 0).toLocaleString()} 家</span>
      </div>
    `;

    const numeric = (value) =>
      value === null || value === undefined ? Number.NaN : Number(value);
    const actual = numeric(market.amount);
    const predicted = numeric(market.predictedAmount);
    const previous = numeric(market.previousAmount);
    const changeAmount = numeric(market.changeAmount);
    const changePct = numeric(market.changePct);
    elements.marketVolumeState.textContent = market.isFinal
      ? "收盘实际"
      : "盘中估算";
    elements.marketVolumeActual.textContent = Number.isFinite(actual)
      ? formatYi(actual, 1, false)
      : "—";
    elements.marketVolumePredicted.textContent = Number.isFinite(predicted)
      ? formatYi(predicted, 1, false)
      : "—";
    const isShrink = Number.isFinite(changeAmount) && changeAmount < 0;
    const directionText = isShrink ? "缩量" : "放量";
    elements.marketVolumeNote.className =
      `market-volume-note ${isShrink ? "is-shrink" : changeAmount > 0 ? "is-expand" : ""}`;
    if (
      Number.isFinite(previous) &&
      Number.isFinite(changeAmount) &&
      Number.isFinite(changePct)
    ) {
      elements.marketVolumeNote.innerHTML = `
        较昨日 ${formatYi(previous, 1, false)}
        <strong>${formatRate(changePct * 100, 2, true)}</strong>
        · ${directionText}${formatYi(Math.abs(changeAmount), 1, false)}
      `;
    } else {
      elements.marketVolumeNote.textContent = "昨日量能暂不可用";
    }

    const low = numeric(market.predictedLow);
    const high = numeric(market.predictedHigh);
    if (
      Number.isFinite(low) &&
      Number.isFinite(high) &&
      Number.isFinite(predicted) &&
      high > low
    ) {
      const scaleValues = [low, high, predicted];
      if (Number.isFinite(previous)) scaleValues.push(previous);
      const scaleMin = Math.min(...scaleValues);
      const scaleMax = Math.max(...scaleValues);
      const scaleRange = Math.max(1, scaleMax - scaleMin);
      const position = (value) =>
        ((value - scaleMin) / scaleRange) * 100;
      elements.marketVolumeRange.innerHTML = `
        <span class="market-volume-range-track"></span>
        <span class="market-volume-range-band" style="left:${position(low).toFixed(1)}%;width:${Math.max(1, position(high) - position(low)).toFixed(1)}%"></span>
        <span class="market-volume-range-marker" style="left:${position(predicted).toFixed(1)}%"></span>
        <span class="market-volume-range-label" style="left:${position(low).toFixed(1)}%">${formatYi(low, 0, false)}</span>
        <span class="market-volume-range-label" style="left:${position(high).toFixed(1)}%">${formatYi(high, 0, false)}</span>
      `;
    } else {
      elements.marketVolumeRange.replaceChildren();
    }
    const completion = numeric(market.historicalCompletion);
    const completionText = Number.isFinite(completion)
      ? `历史同时间完成度 ${(completion * 100).toFixed(1)}%，样本 ${market.historicalDays || 0} 个交易日。`
      : "";
    elements.marketVolumeMethod.textContent =
      `${completionText}${payload.forecastMethod || ""}`;
  }

  async function loadMarketPulse(force = false) {
    if (state.marketPulseLoading) return;
    if (standalone?.marketPulse) {
      renderMarketPulse(standalone.marketPulse);
      return;
    }
    state.marketPulseRequestId += 1;
    const requestId = state.marketPulseRequestId;
    state.marketPulseLoading = true;
    elements.marketPulseRefresh.disabled = true;
    elements.marketPulseTime.textContent = force
      ? "正在刷新市场脉搏…"
      : "市场快照载入中…";
    try {
      const response = await fetch(
        `/api/market-pulse${force ? "?refresh=1" : ""}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (requestId === state.marketPulseRequestId) {
        renderMarketPulse(payload);
      }
    } catch {
      elements.marketPulseTime.textContent = "市场快照暂时不可用";
      if (!state.marketPulsePayload) {
        elements.marketBreadthChart.innerHTML =
          '<p class="flow-empty">涨跌分布暂时不可用，请稍后刷新。</p>';
      }
    } finally {
      if (requestId === state.marketPulseRequestId) {
        state.marketPulseLoading = false;
        elements.marketPulseRefresh.disabled = false;
      }
    }
  }

  function renderIndustryFlow() {
    const items = state.industryFlow;
    if (!items.length) {
      elements.industryFlowGrid.innerHTML =
        '<p class="flow-empty">资金数据暂时不可用，请稍后刷新。</p>';
      elements.industryFlowSummary.textContent = "暂无行业资金数据";
      return;
    }
    const sortKey = state.industryFlowSort;
    const sorted = items.slice().sort((left, right) => {
      const leftValue = Number(left[sortKey]);
      const rightValue = Number(right[sortKey]);
      return (Number.isFinite(rightValue) ? rightValue : -Infinity) -
        (Number.isFinite(leftValue) ? leftValue : -Infinity);
    });
    const inflowCount = items.filter((item) => item.mainNetInflow > 0).length;
    const volumeExpandedCount = items.filter(
      (item) => Number(item.volumeChangePct) > 0,
    ).length;
    const volumeContractedCount = items.filter(
      (item) => Number(item.volumeChangePct) < 0,
    ).length;
    const strongest = items.reduce((best, item) =>
      !best || item.mainNetInflow > best.mainNetInflow ? item : best,
    null);
    const largestExpansion = items.reduce((best, item) =>
      !best ||
      Number(item.volumeChangePct) > Number(best.volumeChangePct)
        ? item
        : best,
    null);
    const largestContraction = items.reduce((best, item) =>
      !best ||
      Number(item.volumeChangePct) < Number(best.volumeChangePct)
        ? item
        : best,
    null);
    elements.industryFlowSummary.innerHTML = `
      <span><small>净流入行业</small><strong>${inflowCount} / ${items.length}</strong></span>
      <span><small>最强流入</small><strong>${escapeHTML(strongest?.name || "—")} ${formatYi(strongest?.mainNetInflow)}</strong></span>
      <span><small>预计放量 / 缩量</small><strong>${volumeExpandedCount} / ${volumeContractedCount}</strong></span>
      <span><small>放量最多</small><strong>${escapeHTML(largestExpansion?.name || "—")} ${formatRate(Number(largestExpansion?.volumeChangePct) * 100, 1, true)}</strong></span>
      <span><small>缩量最多</small><strong>${escapeHTML(largestContraction?.name || "—")} ${formatRate(Number(largestContraction?.volumeChangePct) * 100, 1, true)}</strong></span>
    `;
    const maxAbsFlow = Math.max(
      ...items.map((item) => Math.abs(item.mainNetInflow || 0)),
      1,
    );
    elements.industryFlowGrid.innerHTML = sorted
      .map((item, index) => {
        const strength = Math.min(
          Math.abs(item.mainNetInflow || 0) / maxAbsFlow,
          1,
        );
        const direction =
          item.mainNetInflow > 0
            ? "is-inflow"
            : item.mainNetInflow < 0
              ? "is-outflow"
              : "is-flat";
        return `
          <button
            type="button"
            class="flow-card ${direction}"
            data-industry-code="${escapeHTML(item.swCode || "")}"
            style="--flow-width:${(12 + strength * 88).toFixed(1)}%;--flow-tint:${(strength * 11).toFixed(1)}%"
            aria-label="查看${escapeHTML(item.name)}走势，主力净流入${formatYi(item.mainNetInflow)}，当前成交${formatYi(item.amount, 1, false)}，预测量能${formatYi(item.predictedAmount, 1, false)}，较昨日${formatRate(Number(item.volumeChangePct) * 100, 1, true)}"
          >
            <span class="flow-card-head">
              <span class="flow-rank">${String(index + 1).padStart(2, "0")}</span>
              <strong>${escapeHTML(item.name)}</strong>
              <span class="${metricTone(item.changePct)}">${formatSignedNumber(item.changePct, 2)}</span>
            </span>
            <span class="flow-main-value ${metricTone(item.mainNetInflow)}">
              ${formatYi(item.mainNetInflow)}
            </span>
            <span class="flow-card-metrics">
              <span><small>主力占比</small><b>${formatRate(item.mainNetRatio, 2, true)}</b></span>
              <span><small>量比</small><b>${formatMultiple(item.volumeRatio)}</b></span>
              <span><small>当前成交</small><b>${formatYi(item.amount, 1, false)}</b></span>
              <span title="区间 ${formatYi(item.predictedLow, 1, false)} - ${formatYi(item.predictedHigh, 1, false)}"><small>${item.volumeForecastFinal ? "全天成交" : "预计全天"}</small><b>${formatYi(item.predictedAmount, 1, false)}</b></span>
              <span><small>较昨日量能</small><b class="${metricTone(Number(item.volumeChangePct))}">${formatRate(Number(item.volumeChangePct) * 100, 1, true)}</b></span>
              <span><small>完成度样本</small><b>${Number(item.volumeForecastDays || 0)}日</b></span>
            </span>
          </button>
        `;
      })
      .join("");
  }

  async function loadIndustryFlow(force = false) {
    if (state.industryFlowLoading) return;
    if (standalone?.industryFlow) {
      const payload = standalone.industryFlow;
      state.industryFlow = Array.isArray(payload.industries)
        ? payload.industries
        : [];
      elements.industryFlowTime.textContent =
        `离线快照 ${formatFlowTime(payload.quoteTime)}`;
      renderIndustryFlow();
      return;
    }
    state.industryFlowLoading = true;
    elements.industryFlowRefresh.disabled = true;
    elements.industryFlowTime.textContent = force
      ? "正在刷新资金数据…"
      : "资金数据载入中…";
    try {
      const response = await fetch("/api/industry-flow", {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      state.industryFlow = Array.isArray(payload.industries)
        ? payload.industries
        : [];
      elements.industryFlowTime.textContent =
        `盘中快照 ${formatFlowTime(payload.quoteTime)}`;
      renderIndustryFlow();
    } catch {
      elements.industryFlowTime.textContent = "资金快照暂时不可用";
      if (!state.industryFlow.length) {
        elements.industryFlowGrid.innerHTML =
          '<p class="flow-empty">资金数据暂时不可用，请稍后刷新。</p>';
      }
    } finally {
      state.industryFlowLoading = false;
      elements.industryFlowRefresh.disabled = false;
    }
  }

  function renderLevel2FlowPlaceholder(message) {
    elements.level2FlowSummary.innerHTML = `
      <span><small>二级行业</small><strong>等待选择</strong></span>
      <span><small>主力净流入</small><strong>--</strong></span>
      <span><small>主力占比</small><strong>--</strong></span>
      <span><small>成交额加权量比</small><strong>--</strong></span>
    `;
    elements.level2FlowStockBody.innerHTML =
      `<tr><td colspan="8" class="company-empty">${escapeHTML(message)}</td></tr>`;
    elements.level2FlowFootnote.textContent =
      "点击公司名称可进入公司研究；统计仅覆盖成功匹配资金数据的成分股。";
  }

  function populateLevel2FlowParents() {
    const fragment = document.createDocumentFragment();
    industries
      .slice()
      .sort((left, right) => left.code.localeCompare(right.code))
      .forEach((item) => {
        const option = document.createElement("option");
        option.value = item.code;
        option.textContent = item.name;
        fragment.append(option);
      });
    elements.level2FlowParentSelect.replaceChildren(fragment);
  }

  function syncLevel2FlowIndustryOptions(parentCode, preferredCode = null) {
    const children = subIndustriesByParent.get(parentCode) || [];
    const fragment = document.createDocumentFragment();
    children.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.code;
      option.textContent = item.name;
      fragment.append(option);
    });
    elements.level2FlowIndustrySelect.replaceChildren(fragment);
    elements.level2FlowIndustrySelect.disabled = !children.length;
    const selected =
      children.find((item) => item.code === preferredCode)?.code ||
      children[0]?.code ||
      null;
    state.level2FlowIndustryCode = selected;
    if (selected) elements.level2FlowIndustrySelect.value = selected;
    return selected;
  }

  function renderLevel2Flow(payload) {
    const industry = payload.industry;
    if (!industry) return;
    state.level2FlowPayload = payload;
    elements.level2FlowTime.textContent =
      `盘中快照 ${formatFlowTime(payload.quoteTime)}`;
    elements.level2FlowSummary.innerHTML = `
      <span>
        <small>${escapeHTML(industry.name)} · 成分股</small>
        <strong>${industry.matchedCount} / ${industry.stockCount} 只</strong>
      </span>
      <span>
        <small>主力净流入</small>
        <strong class="${metricTone(industry.mainNetInflow)}">${formatYi(industry.mainNetInflow)}</strong>
      </span>
      <span>
        <small>主力净流入占比</small>
        <strong class="${metricTone(industry.mainNetRatio)}">${formatRate(industry.mainNetRatio, 2, true)}</strong>
      </span>
      <span>
        <small>成交额加权量比</small>
        <strong>${formatMultiple(industry.volumeRatio)}</strong>
      </span>
    `;
    const stocks = Array.isArray(payload.stocks) ? payload.stocks : [];
    if (!stocks.length) {
      elements.level2FlowStockBody.innerHTML =
        '<tr><td colspan="8" class="company-empty">没有匹配到成分股资金数据</td></tr>';
    } else {
      elements.level2FlowStockBody.innerHTML = stocks
        .map((item) => {
          const flowTone =
            item.mainNetInflow > 0
              ? "main-inflow-positive"
              : item.mainNetInflow < 0
                ? "main-inflow-negative"
                : "";
          return `
            <tr data-company-code="${escapeHTML(item.code)}" data-company-name="${escapeHTML(item.name)}">
              <td>
                <button type="button" class="company-name">
                  ${escapeHTML(item.name)}
                </button>
              </td>
              <td class="company-code">${escapeHTML(item.stockCode)}</td>
              <td class="numeric">${Number.isFinite(item.price) ? item.price.toFixed(2) : "—"}</td>
              <td class="numeric ${metricTone(item.changePct)}">${formatRate(item.changePct, 2, true)}</td>
              <td class="numeric ${flowTone}">${formatAdaptiveFlow(item.mainNetInflow)}</td>
              <td class="numeric ${metricTone(item.mainNetRatio)}">${formatRate(item.mainNetRatio, 2, true)}</td>
              <td class="numeric">${formatMultiple(item.volumeRatio)}</td>
              <td class="numeric">${formatRate(item.turnoverRate, 2)}</td>
            </tr>
          `;
        })
        .join("");
    }
    const missing = Number(payload.missingCount) || 0;
    elements.level2FlowFootnote.textContent =
      `${industry.inflowCount} 只主力净流入，${industry.outflowCount} 只主力净流出；` +
      `成交额合计 ${formatYi(industry.amount, 1, false)}。` +
      (missing ? ` 有 ${missing} 只成分股未匹配到资金数据。` : "");
  }

  async function loadLevel2Flow(force = false) {
    const industryCode = state.level2FlowIndustryCode;
    if (!industryCode) return;
    if (
      !force &&
      state.level2FlowPayload?.industry?.code === industryCode
    ) {
      return;
    }
    state.level2FlowRequestId += 1;
    const requestId = state.level2FlowRequestId;
    if (standalone) {
      const snapshot = standalone?.level2Flow?.[industryCode];
      if (snapshot) {
        renderLevel2Flow(snapshot);
        elements.level2FlowTime.textContent =
          `离线快照 ${formatFlowTime(snapshot.quoteTime)}`;
      } else {
        elements.level2FlowTime.textContent = "离线版未包含该二级行业";
        renderLevel2FlowPlaceholder(
          "单文件离线版仅展示已预生成的二级行业个股资金快照，请使用本地服务版查看实时数据。",
        );
      }
      return;
    }

    state.level2FlowLoading = true;
    elements.level2FlowRefresh.disabled = true;
    elements.level2FlowTime.textContent = force
      ? "正在刷新二级行业资金…"
      : "二级行业资金载入中…";
    renderLevel2FlowPlaceholder("正在汇总申万二级行业成分股资金流…");
    try {
      const query = new URLSearchParams({ industry: industryCode });
      if (force) query.set("refresh", "1");
      const response = await fetch(
        `/api/level2-stock-flow?${query.toString()}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (
        requestId !== state.level2FlowRequestId ||
        industryCode !== state.level2FlowIndustryCode
      ) {
        return;
      }
      renderLevel2Flow(payload);
    } catch {
      if (requestId !== state.level2FlowRequestId) return;
      elements.level2FlowTime.textContent = "二级行业资金暂时不可用";
      renderLevel2FlowPlaceholder(
        "暂时无法获取该二级行业的成分股资金流，请稍后刷新或换一个二级行业。",
      );
    } finally {
      if (requestId === state.level2FlowRequestId) {
        state.level2FlowLoading = false;
        elements.level2FlowRefresh.disabled = false;
      }
    }
  }

  function setupLevel2Flow() {
    populateLevel2FlowParents();
    const initialParent =
      industries.find((item) => item.code === state.selectedCode)?.code ||
      industries[0].code;
    state.level2FlowParentCode = initialParent;
    elements.level2FlowParentSelect.value = initialParent;
    syncLevel2FlowIndustryOptions(initialParent);
    renderLevel2FlowPlaceholder("选择二级行业后查看成分股资金流");

    elements.level2FlowParentSelect.addEventListener("change", (event) => {
      state.level2FlowParentCode = event.target.value;
      state.level2FlowPayload = null;
      const industryCode = syncLevel2FlowIndustryOptions(
        state.level2FlowParentCode,
      );
      if (!industryCode) {
        renderLevel2FlowPlaceholder("该一级行业暂无二级行业数据");
        return;
      }
      renderLevel2FlowPlaceholder("正在准备二级行业资金数据…");
      if (state.activeView === "flow") loadLevel2Flow();
    });
    elements.level2FlowIndustrySelect.addEventListener("change", (event) => {
      state.level2FlowIndustryCode = event.target.value;
      state.level2FlowPayload = null;
      if (state.activeView === "flow") loadLevel2Flow();
    });
    elements.level2FlowRefresh.addEventListener("click", () =>
      loadLevel2Flow(true),
    );
    elements.level2FlowStockBody.addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-company-code]");
      if (!row) return;
      openCompanyFromSearch({
        code: row.dataset.companyCode,
        name: row.dataset.companyName,
      });
    });
    if (state.activeView === "flow") loadLevel2Flow();
  }

  function renderConceptHeatPlaceholder(message) {
    elements.conceptHeatLead.textContent = message;
    elements.conceptHeatGrid.innerHTML = "";
  }

  function conceptStageTone(stage) {
    if (stage === "短线爆发") return "is-pulse";
    if (stage === "短线活跃") return "is-active";
    if (stage === "趋势延续") return "is-trend";
    if (stage === "资金驱动") return "is-flow";
    return "is-watch";
  }

  function mergeConceptHotspot(heatPayload, hotspotPayload, intradayPayload) {
    const hotspotByCode = new Map(
      (hotspotPayload?.concepts || []).map((item) => [item.code, item]),
    );
    const intradayConcepts = intradayPayload?.concepts || [];
    const intradayMetricsByCode = new Map(
      intradayConcepts.map((item) => [
        item.code,
        conceptIntradayFlowMetrics(item),
      ]),
    );
    const velocityValues = [...intradayMetricsByCode.values()].map(
      (item) => item.velocity5,
    );
    return {
      ...heatPayload,
      hotspotSourceDate:
        hotspotPayload?.sourceDate || intradayPayload?.sourceDate,
      hotspotMethod: (
        "热点综合=基础热度60%+涨停事件25%+5分钟资金速度15%。"
        + "资金速度取累计主力净流入近5分钟变化，按候选概念横截面分位计算。"
      ),
      concepts: heatPayload.concepts.map((item) => {
        const event = hotspotByCode.get(item.code) || {};
        const count = Number(event.limitUpCount || 0);
        const multiBoard = Number(event.multiBoardCount || 0);
        const maxBoard = Number(event.maxBoard || 0);
        const openedCount = Number(event.openedCount || 0);
        const eventScore =
          (Math.min(1, count / 8) * 0.35 +
            Math.min(1, multiBoard / 4) * 0.3 +
            Math.min(1, maxBoard / 6) * 0.2 +
            Math.max(0.5, 1 - (openedCount / Math.max(1, count)) * 0.5) *
              0.15) *
          100;
        const intraday = intradayMetricsByCode.get(item.code);
        const velocityScore = intraday
          ? valuePercentile(velocityValues, intraday.velocity5)
          : 50;
        const hotspotScore =
          item.heatScore * 0.6 +
          eventScore * 0.25 +
          velocityScore * 0.15;
        return {
          ...item,
          hotspotScore: Math.round(hotspotScore * 100) / 100,
          eventCatalystScore: Math.round(eventScore * 100) / 100,
          fundVelocityScore: Math.round(velocityScore * 100) / 100,
          fundVelocityAvailable: Boolean(intraday),
          fundVelocity1: intraday?.velocity1 ?? null,
          fundVelocity5: intraday?.velocity5 ?? null,
          fundAcceleration5: intraday?.acceleration5 ?? null,
          fundPositiveRate10: intraday?.positiveRate10 ?? null,
          limitUpCount: count,
          multiBoardCount: multiBoard,
          maxBoard,
          openedLimitUpCount: openedCount,
          limitUpStocks: event.stocks || [],
          hotReasons: [
            ...(item.hotReasons || []),
            ...(count > 0 ? [`${count}只涨停`] : []),
            ...(maxBoard >= 2 ? [`最高${maxBoard}板`] : []),
            ...(velocityScore >= 80 ? ["资金加速"] : []),
            ...(velocityScore <= 20 ? ["资金减速"] : []),
          ].filter((reason, index, values) => values.indexOf(reason) === index),
        };
      }),
    };
  }

  function renderConceptHeat(payload) {
    state.conceptHeatPayload = payload;
    const allConcepts = (Array.isArray(payload.concepts) ? payload.concepts : [])
      .filter((item) => item.showInChart !== false);
    const filtered = allConcepts.filter((item) => {
      if (state.conceptHeatMode === "all") return true;
      return item.category === state.conceptHeatMode;
    });
    const sortKey = state.conceptHeatSort;
    filtered.sort((left, right) => {
      const leftValue = Number(left[sortKey]);
      const rightValue = Number(right[sortKey]);
      return (Number.isFinite(rightValue) ? rightValue : -Infinity) -
        (Number.isFinite(leftValue) ? leftValue : -Infinity);
    });
    let top;
    if (sortKey === "heatScore") {
      const shortTermTop = filtered
        .filter((item) => Number.isFinite(Number(item.shortTermScore)))
        .slice()
        .sort(
          (left, right) =>
            Number(right.shortTermScore) - Number(left.shortTermScore),
        )
        .slice(0, 9);
      const merged = new Map();
      filtered.slice(0, 10).forEach((item) => merged.set(item.name, item));
      shortTermTop.forEach((item) => merged.set(item.name, item));
      top = [...merged.values()]
        .sort(
          (left, right) =>
            Number(right.heatScore) - Number(left.heatScore),
        )
        .slice(0, 16);
    } else {
      top = filtered.slice(
        0,
        ["hotspotScore", "shortTermScore"].includes(sortKey) ? 16 : 12,
      );
    }
    elements.conceptHeatTime.textContent = payload.quoteTime
      ? `盘中快照 ${formatFlowTime(payload.quoteTime)}`
      : "热点快照";
    elements.conceptHeatMethod.textContent =
      `${payload.method || "热度是多个市场指标的相对分位组合。"} ` +
      (payload.hotspotMethod || "热点综合当前使用基础热度。");
    if (!top.length) {
      renderConceptHeatPlaceholder("当前分类暂无概念热度数据");
      return;
    }
    const first = top[0];
    const shortLeader = filtered
      .filter((item) => Number.isFinite(Number(item.shortTermScore)))
      .slice()
      .sort(
        (left, right) =>
          Number(right.shortTermScore) - Number(left.shortTermScore),
      )[0];
    elements.conceptHeatLead.innerHTML = `
      当前第一热点：<strong>${escapeHTML(first.name)}</strong>
      · 热点综合 ${Number(first.hotspotScore || first.heatScore).toFixed(1)}
      · 基础热度 ${first.heatScore.toFixed(1)}
      · 5分资金速度 ${first.fundVelocityAvailable ? `${formatSignedFlowNumber(first.fundVelocity5, 2)}亿/分` : "待载入"}
      · ${Number(first.limitUpCount || 0)}只涨停
      · 最高${Number(first.maxBoard || 0)}板
      · ${formatRate(first.changePct, 2, true)}
      · 主力占比 ${formatRate(first.mainNetRatio, 2, true)}
      ${shortLeader ? ` · 短线最强：<strong>${escapeHTML(shortLeader.name)}</strong> ${Number(shortLeader.shortTermScore).toFixed(1)}` : ""}
    `;
    elements.conceptHeatGrid.innerHTML = top
      .map((item, index) => {
        const reasons = Array.isArray(item.hotReasons) ? item.hotReasons : [];
        const stage = item.hotStage || "热度观察";
        return `
          <button
            type="button"
            class="concept-heat-card"
            data-heat-concept="${escapeHTML(item.name)}"
            aria-label="查看${escapeHTML(item.name)}相关股票，热点综合${Number(item.hotspotScore || item.heatScore).toFixed(1)}，基础热度${item.heatScore.toFixed(1)}，5分钟资金速度${item.fundVelocityAvailable ? formatSignedFlowNumber(item.fundVelocity5, 2) : "待载入"}亿元每分钟，${Number(item.limitUpCount || 0)}只涨停"
          >
            <span class="concept-heat-card-head">
              <span class="concept-heat-rank">${String(index + 1).padStart(2, "0")}</span>
              <span class="concept-heat-name">${escapeHTML(item.name)}</span>
              <span class="concept-heat-score">${Number(item.hotspotScore || item.heatScore).toFixed(1)}</span>
            </span>
            <span class="concept-heat-change ${metricTone(item.changePct)}">
              ${formatRate(item.changePct, 2, true)}
            </span>
            <span class="concept-heat-stats">
              <span><small>基础热度</small><b>${item.heatScore.toFixed(1)}</b></span>
              <span><small>5分资金速度</small><b>${item.fundVelocityAvailable ? `${formatSignedFlowNumber(item.fundVelocity5, 2)}亿/分` : "待载入"}</b></span>
              <span><small>概念涨停</small><b>${Number(item.limitUpCount || 0)}只</b></span>
              <span><small>最高连板</small><b>${Number(item.maxBoard || 0)}板</b></span>
              <span><small>5日趋势</small><b>${formatRate(item.return5d, 1, true)}</b></span>
              <span><small>主力占比</small><b>${formatRate(item.mainNetRatio, 2, true)}</b></span>
            </span>
            <span class="concept-heat-reasons">
              <span class="concept-heat-stage ${conceptStageTone(stage)}">${escapeHTML(stage)}</span>
              ${reasons.map((reason) => `<span class="concept-heat-reason">${escapeHTML(reason)}</span>`).join("")}
            </span>
          </button>
        `;
      })
      .join("");
  }

  async function loadConceptHeat(force = false) {
    if (!force && (state.conceptHeatPayload || state.conceptHeatLoading)) return;
    state.conceptHeatRequestId += 1;
    const requestId = state.conceptHeatRequestId;
    state.conceptHeatLoading = true;
    elements.conceptHeatRefresh.disabled = true;
    elements.conceptHeatTime.textContent = force
      ? "正在刷新概念热度…"
      : "概念热度载入中…";
    renderConceptHeatPlaceholder("正在计算当前热点概念…");

    if (standalone) {
      if (standalone?.conceptHeat) {
        renderConceptHeat(
          mergeConceptHotspot(
            standalone.conceptHeat,
            standalone.conceptHotspot,
            standalone.conceptIntradayFlow,
          ),
        );
        elements.conceptHeatTime.textContent =
          `离线快照 ${formatFlowTime(standalone.conceptHeat.quoteTime)}`;
      } else {
        renderConceptHeatPlaceholder("离线版未包含热点概念快照");
      }
      state.conceptHeatLoading = false;
      elements.conceptHeatRefresh.disabled = false;
      return;
    }

    try {
      const query = force ? "?refresh=1" : "";
      const response = await fetch(`/api/concept-heat${query}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      let hotspotPayload = null;
      let intradayPayload = null;
      try {
        const [hotspotResponse, intradayResponse] = await Promise.all([
          fetch(`/api/concept-hotspot${query}`, { cache: "no-store" }),
          fetch(`/api/concept-intraday-flow${query}`, {
            cache: "no-store",
          }),
        ]);
        if (hotspotResponse.ok) {
          hotspotPayload = await hotspotResponse.json();
        }
        if (intradayResponse.ok) {
          intradayPayload = await intradayResponse.json();
        }
      } catch {
        // Keep the base heat model if supplemental layers are unavailable.
      }
      if (requestId !== state.conceptHeatRequestId) return;
      renderConceptHeat(
        mergeConceptHotspot(payload, hotspotPayload, intradayPayload),
      );
    } catch {
      if (requestId !== state.conceptHeatRequestId) return;
      elements.conceptHeatTime.textContent = "热点概念暂时不可用";
      renderConceptHeatPlaceholder("当前无法获取概念热度，请稍后刷新。");
    } finally {
      if (requestId === state.conceptHeatRequestId) {
        state.conceptHeatLoading = false;
        elements.conceptHeatRefresh.disabled = false;
      }
    }
  }

  const CONCEPT_INTRADAY_COLORS = [
    "#d33a4a", "#d97322", "#e28b17", "#e0a11a",
    "#c8bd34", "#78b649", "#26a96c", "#23a68f",
    "#2d9fc4", "#4387d8", "#5675d8", "#785fd0",
    "#a15ac6", "#c55aa9", "#ce6382", "#a9786c",
    "#7b8a8f", "#3b556e", "#39a7a5", "#5eaa54",
    "#c49b46", "#b06c42", "#8769ac", "#5795a8",
    "#b34e87",
  ];

  function conceptIntradaySessionMinute(value) {
    const match = String(value || "").match(
      /^\d{4}-\d{2}-\d{2}\s+(\d{2}):(\d{2})$/,
    );
    if (!match) return Number.NaN;
    const totalMinutes = Number(match[1]) * 60 + Number(match[2]);
    if (totalMinutes <= 11 * 60 + 30) {
      return totalMinutes - (9 * 60 + 30);
    }
    if (totalMinutes >= 13 * 60) {
      return 120 + totalMinutes - 13 * 60;
    }
    return Number.NaN;
  }

  function conceptIntradayMinuteLabel(value) {
    const tradingMinute = Math.round(value);
    const totalMinutes =
      tradingMinute <= 120
        ? 9 * 60 + 30 + tradingMinute
        : 13 * 60 + tradingMinute - 120;
    return `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(
      totalMinutes % 60,
    ).padStart(2, "0")}`;
  }

  function conceptIntradayColor(index) {
    return CONCEPT_INTRADAY_COLORS[index % CONCEPT_INTRADAY_COLORS.length];
  }

  function conceptIntradaySourcePoints(item) {
    return (item.points || [])
      .map(([time, value]) => ({
        time,
        timestamp: conceptIntradaySessionMinute(time),
        value: Number(value),
      }))
      .filter(
        (point) =>
          Number.isFinite(point.timestamp) && Number.isFinite(point.value),
      );
  }

  function conceptIntradayFlowMetrics(item) {
    const points = conceptIntradaySourcePoints(item);
    const values = points.map((point) => point.value);
    const latest = values.at(-1) ?? 0;
    const velocity1 =
      values.length >= 2 ? latest - values.at(-2) : 0;
    const velocity5 =
      values.length >= 6 ? (latest - values.at(-6)) / 5 : 0;
    const priorVelocity5 =
      values.length >= 11 ? (values.at(-6) - values.at(-11)) / 5 : 0;
    const acceleration5 = velocity5 - priorVelocity5;
    const recentChanges = values
      .slice(-11)
      .map((value, index, source) =>
        index ? value - source[index - 1] : null,
      )
      .filter(Number.isFinite);
    const positiveRate10 = recentChanges.length
      ? recentChanges.filter((value) => value > 0).length /
        recentChanges.length
      : 0;
    return {
      latest,
      velocity1,
      velocity5,
      acceleration5,
      positiveRate10,
    };
  }

  function conceptIntradayDisplayPoints(item) {
    const source = conceptIntradaySourcePoints(item);
    if (state.conceptIntradayFlowMode === "cumulative") return source;
    return source.slice(5).map((point, index) => ({
      ...point,
      value: (point.value - source[index].value) / 5,
    }));
  }

  function conceptIntradayFocusCodes(payload) {
    const concepts = (payload?.concepts || [])
      .filter((item) => item.showInChart !== false)
      .map((item) => ({
        item,
        metric: conceptIntradayFlowMetrics(item),
      }))
      .sort((left, right) => {
        const leftValue =
          state.conceptIntradayFlowMode === "velocity"
            ? left.metric.velocity5
            : left.metric.latest;
        const rightValue =
          state.conceptIntradayFlowMode === "velocity"
            ? right.metric.velocity5
            : right.metric.latest;
        return rightValue - leftValue;
      });
    const focusCodes = new Set();
    const addCodes = (entries) => {
      entries.forEach(({ item }) => focusCodes.add(item.code));
    };
    addCodes(concepts.slice(0, 4));
    addCodes(concepts.slice(-3));
    addCodes(
      concepts
        .slice()
        .sort(
          (left, right) =>
            (right.item.heatScore || 0) - (left.item.heatScore || 0),
        )
        .slice(0, 3),
    );
    if (focusCodes.size < Math.min(10, concepts.length)) {
      for (const { item } of concepts) {
        focusCodes.add(item.code);
        if (focusCodes.size >= 10) break;
      }
    }
    return focusCodes;
  }

  function applyConceptIntradayFlowScope(payload, scope) {
    state.conceptIntradayFlowScope = scope;
    state.conceptIntradayFlowHidden.clear();
    elements.conceptIntradayFlowScope
      .querySelectorAll("button[data-intraday-flow-scope]")
      .forEach((button) => {
        const active = button.dataset.intradayFlowScope === scope;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", String(active));
      });
  }

  function drawConceptIntradayFlowChart() {
    const payload = state.conceptIntradayFlowPayload;
    if (!payload || !elements.conceptIntradayFlowChartWrap.clientWidth) return;
    const allConcepts = Array.isArray(payload.concepts) ? payload.concepts : [];
    const eligibleConcepts = allConcepts.filter(
      (item) => item.showInChart !== false,
    );
    const focusCodes =
      state.conceptIntradayFlowScope === "focus"
        ? conceptIntradayFocusCodes(payload)
        : null;
    const concepts = eligibleConcepts.filter(
      (item) =>
        (!focusCodes || focusCodes.has(item.code)) &&
        !state.conceptIntradayFlowHidden.has(item.code),
    );
    const width = Math.max(520, elements.conceptIntradayFlowChartWrap.clientWidth);
    const height = Math.max(430, Math.min(650, 260 + eligibleConcepts.length * 9));
    const margin = {
      top: 18,
      right: width < 760 ? 130 : 150,
      bottom: 34,
      left: state.conceptIntradayFlowMode === "velocity" ? 86 : 58,
    };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const series = concepts.map((item, index) => ({
      ...item,
      color: conceptIntradayColor(
        eligibleConcepts.findIndex((entry) => entry.code === item.code),
      ),
      timestamped: conceptIntradayDisplayPoints(item),
    }));
    if (!series.length) {
      elements.conceptIntradayFlowChart.replaceChildren();
      return;
    }
    const timestamps = series.flatMap((item) =>
      item.timestamped.map((point) => point.timestamp),
    );
    const values = series.flatMap((item) =>
      item.timestamped.map((point) => point.value),
    );
    const start = Math.min(...timestamps);
    const end = Math.max(...timestamps);
    const rawMin = Math.min(0, ...values);
    const rawMax = Math.max(0, ...values);
    const padding = Math.max(1, (rawMax - rawMin) * 0.08);
    const yDomain = yTicks(rawMin - padding, rawMax + padding);
    const velocityTickDigits =
      state.conceptIntradayFlowMode === "velocity"
        ? Math.max(1, Math.min(3, 2 - Math.floor(Math.log10(Math.max(0.01, Math.max(Math.abs(rawMin), Math.abs(rawMax)))))))
        : Math.abs(rawMax - rawMin) < 10
          ? 1
          : 0;
    const xScale = (value) =>
      margin.left +
      ((value - start) / Math.max(1, end - start)) * plotWidth;
    const yScale = (value) =>
      margin.top +
      (1 - (value - yDomain.min) / (yDomain.max - yDomain.min)) * plotHeight;

    elements.conceptIntradayFlowChart.setAttribute(
      "viewBox",
      `0 0 ${width} ${height}`,
    );
    elements.conceptIntradayFlowChart.replaceChildren();
    const desc = document.createElementNS(SVG_NS, "desc");
    desc.textContent =
      state.conceptIntradayFlowMode === "velocity"
        ? "概念板块5分钟资金速度曲线，横轴为交易时间，纵轴单位为亿元每分钟。"
        : "概念板块盘中累计主力净流入曲线，横轴为交易时间，纵轴单位为亿元。";
    elements.conceptIntradayFlowChart.append(desc);

    yDomain.ticks.forEach((tick) => {
      const y = yScale(tick);
      elements.conceptIntradayFlowChart.append(
        svgElement("line", {
          x1: margin.left,
          y1: y,
          x2: width - margin.right,
          y2: y,
          class: tick === 0 ? "all-zero-line" : "all-grid-line",
        }),
      );
      const label = svgElement("text", {
        x: margin.left - 9,
        y: y + 3,
        "text-anchor": "end",
      });
      label.textContent = `${formatSignedFlowNumber(
        tick,
        velocityTickDigits,
      )}${state.conceptIntradayFlowMode === "velocity" ? "亿/分" : "亿"}`;
      elements.conceptIntradayFlowChart.append(label);
    });

    const xTickCount = width < 760 ? 4 : 7;
    for (let index = 0; index < xTickCount; index += 1) {
      const timestamp = start + ((end - start) * index) / (xTickCount - 1);
      const label = svgElement("text", {
        x: xScale(timestamp),
        y: height - 9,
        "text-anchor":
          index === 0 ? "start" : index === xTickCount - 1 ? "end" : "middle",
      });
      label.textContent = conceptIntradayMinuteLabel(timestamp);
      elements.conceptIntradayFlowChart.append(label);
    }

    series.forEach((item) => {
      const path = item.timestamped
        .map((point, index) => {
          const x = xScale(point.timestamp);
          const y = yScale(point.value);
          return `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(" ");
      elements.conceptIntradayFlowChart.append(
        svgElement("path", {
          class: "concept-intraday-flow-line",
          d: path,
          stroke: item.color,
        }),
      );
    });

    const finalLabels = series
      .map((item) => {
        const last = item.timestamped.at(-1);
        return {
          ...item,
          value: last?.value ?? 0,
          targetY: yScale(last?.value ?? 0),
        };
      })
      .sort((left, right) => left.targetY - right.targetY);
    const minGap = 12;
    finalLabels.forEach((item, index) => {
      item.labelY =
        index === 0
          ? Math.max(margin.top + 8, item.targetY)
          : Math.max(item.targetY, finalLabels[index - 1].labelY + minGap);
    });
    const overflow =
      finalLabels.at(-1).labelY - (margin.top + plotHeight);
    if (overflow > 0) {
      finalLabels.forEach((item) => {
        item.labelY -= overflow;
      });
    }
    finalLabels.forEach((item) => {
      const x = width - margin.right + 8;
      elements.conceptIntradayFlowChart.append(
        svgElement("circle", {
          cx: x,
          cy: item.labelY - 3,
          r: 2.5,
          fill: item.color,
        }),
      );
      const label = svgElement("text", {
        x: x + 7,
        y: item.labelY,
        fill: item.color,
        class: "concept-intraday-end-label",
      });
      label.textContent = `${item.name} ${formatSignedFlowNumber(item.value, 1)}`;
      elements.conceptIntradayFlowChart.append(label);
    });

    const hoverGroup = svgElement("g", {
      "aria-hidden": "true",
      opacity: "0",
    });
    const crosshair = svgElement("line", {
      class: "all-crosshair",
      y1: margin.top,
      y2: margin.top + plotHeight,
    });
    hoverGroup.append(crosshair);
    elements.conceptIntradayFlowChart.append(hoverGroup);
    state.conceptIntradayFlowGeometry = {
      width,
      height,
      margin,
      plotWidth,
      plotHeight,
      start,
      end,
      xScale,
      series,
      hoverGroup,
      crosshair,
    };
  }

  function renderConceptIntradayFlow(payload) {
    if (state.conceptIntradayFlowPayload !== payload) {
      applyConceptIntradayFlowScope(payload, state.conceptIntradayFlowScope);
    }
    state.conceptIntradayFlowPayload = payload;
    const concepts = (Array.isArray(payload.concepts) ? payload.concepts : [])
      .filter((item) => item.showInChart !== false);
    const focusCodes =
      state.conceptIntradayFlowScope === "focus"
        ? conceptIntradayFocusCodes(payload)
        : null;
    const visibleCount = concepts.filter(
      (item) =>
        (!focusCodes || focusCodes.has(item.code)) &&
        !state.conceptIntradayFlowHidden.has(item.code),
    ).length;
    const modeLabel =
      state.conceptIntradayFlowMode === "velocity"
        ? "概念分时资金速度"
        : "概念分时累计主力净流入";
    elements.conceptIntradayFlowHeading.textContent = modeLabel;
    elements.conceptIntradayFlowChart.setAttribute(
      "aria-label",
      `${modeLabel}曲线`,
    );
    elements.conceptIntradayFlowTime.textContent = payload.quoteTime
      ? `数据截至 ${payload.quoteTime.slice(11)}`
      : "分时资金快照";
    if (!concepts.length) {
      elements.conceptIntradayFlowSummary.textContent = "暂无分时资金流数据";
      elements.conceptIntradayFlowLegend.replaceChildren();
      elements.conceptIntradayFlowChart.replaceChildren();
      return;
    }
    const metricsByCode = new Map(
      concepts.map((item) => [item.code, conceptIntradayFlowMetrics(item)]),
    );
    const sorted = concepts.slice().sort((left, right) => {
      const leftValue =
        state.conceptIntradayFlowMode === "velocity"
          ? metricsByCode.get(left.code).velocity5
          : left.latest || 0;
      const rightValue =
        state.conceptIntradayFlowMode === "velocity"
          ? metricsByCode.get(right.code).velocity5
          : right.latest || 0;
      return rightValue - leftValue;
    });
    if (state.conceptIntradayFlowMode === "velocity") {
      const fastest = metricsByCode.get(sorted[0].code);
      const slowest = metricsByCode.get(sorted.at(-1).code);
      elements.conceptIntradayFlowSummary.innerHTML = `
        5分钟资金加速最快：<strong>${escapeHTML(sorted[0].name)}</strong>
        ${formatSignedFlowNumber(fastest.velocity5, 2)}亿元/分
        · 加速度 ${formatSignedFlowNumber(fastest.acceleration5, 2)}
        · 近10分钟正向率 ${formatRate(fastest.positiveRate10 * 100, 0)}
        · 减速最快：<strong>${escapeHTML(sorted.at(-1).name)}</strong>
        ${formatSignedFlowNumber(slowest.velocity5, 2)}亿元/分
        · 当前显示${visibleCount}/${concepts.length}个题材概念
      `;
    } else {
      elements.conceptIntradayFlowSummary.innerHTML = `
        当前流入最高：<strong>${escapeHTML(sorted[0].name)}</strong>
        ${formatSignedFlowNumber(sorted[0].latest, 2)}亿元
        · 流出最低：<strong>${escapeHTML(sorted.at(-1).name)}</strong>
        ${formatSignedFlowNumber(sorted.at(-1).latest, 2)}亿元
        · 当前显示${visibleCount}/${concepts.length}个题材概念
      `;
    }
    const legendConcepts = focusCodes
      ? concepts.filter((item) => focusCodes.has(item.code))
      : concepts;
    elements.conceptIntradayFlowLegend.innerHTML = legendConcepts
      .map((item) => {
        const hidden = state.conceptIntradayFlowHidden.has(item.code);
        const metrics = metricsByCode.get(item.code);
        const colorIndex = concepts.findIndex(
          (entry) => entry.code === item.code,
        );
        const displayValue =
          state.conceptIntradayFlowMode === "velocity"
            ? metrics.velocity5
            : item.latest;
        const unit =
          state.conceptIntradayFlowMode === "velocity" ? "亿/分" : "亿";
        return `
          <button
            type="button"
            class="concept-intraday-flow-legend-item ${hidden ? "is-hidden" : ""}"
            data-concept-flow-code="${escapeHTML(item.code)}"
            title="1分钟速度 ${formatSignedFlowNumber(metrics.velocity1, 2)}；5分钟速度 ${formatSignedFlowNumber(metrics.velocity5, 2)}；加速度 ${formatSignedFlowNumber(metrics.acceleration5, 2)}；近10分钟正向率 ${formatRate(metrics.positiveRate10 * 100, 0)}"
          >
            <i style="background:${conceptIntradayColor(colorIndex)}"></i>
            <span>${escapeHTML(item.name)}</span>
            <b>${formatSignedFlowNumber(displayValue, 2)}${unit}</b>
          </button>
        `;
      })
      .join("");
    requestAnimationFrame(drawConceptIntradayFlowChart);
  }

  async function loadConceptIntradayFlow(force = false) {
    if (
      !force &&
      (state.conceptIntradayFlowPayload || state.conceptIntradayFlowLoading)
    ) {
      return;
    }
    state.conceptIntradayFlowRequestId += 1;
    const requestId = state.conceptIntradayFlowRequestId;
    state.conceptIntradayFlowLoading = true;
    elements.conceptIntradayFlowRefresh.disabled = true;
    elements.conceptIntradayFlowTime.textContent = force
      ? "正在刷新分时资金流…"
      : "分时资金流载入中…";
    elements.conceptIntradayFlowSummary.textContent =
      "正在获取概念板块1分钟资金曲线…";
    if (standalone?.conceptIntradayFlow) {
      renderConceptIntradayFlow(standalone.conceptIntradayFlow);
      state.conceptIntradayFlowLoading = false;
      elements.conceptIntradayFlowRefresh.disabled = false;
      return;
    }
    if (standalone) {
      elements.conceptIntradayFlowSummary.textContent =
        "离线版未包含分时资金流快照";
      elements.conceptIntradayFlowChart.replaceChildren();
      state.conceptIntradayFlowLoading = false;
      elements.conceptIntradayFlowRefresh.disabled = false;
      return;
    }
    try {
      const query = force ? "?refresh=1" : "";
      const response = await fetch(`/api/concept-intraday-flow${query}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (requestId !== state.conceptIntradayFlowRequestId) return;
      renderConceptIntradayFlow(payload);
    } catch {
      if (requestId !== state.conceptIntradayFlowRequestId) return;
      elements.conceptIntradayFlowTime.textContent = "分时资金流暂时不可用";
      elements.conceptIntradayFlowSummary.textContent =
        "无法获取盘中概念资金流，请稍后刷新";
      elements.conceptIntradayFlowChart.replaceChildren();
      elements.conceptIntradayFlowLegend.replaceChildren();
    } finally {
      if (requestId === state.conceptIntradayFlowRequestId) {
        state.conceptIntradayFlowLoading = false;
        elements.conceptIntradayFlowRefresh.disabled = false;
      }
    }
  }

  function setConceptHeatMode(mode) {
    if (!["theme", "style", "all"].includes(mode)) return;
    state.conceptHeatMode = mode;
    elements.conceptHeatMode
      .querySelectorAll("button[data-heat-mode]")
      .forEach((button) => {
        const active = button.dataset.heatMode === mode;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", String(active));
      });
    if (state.conceptHeatPayload) renderConceptHeat(state.conceptHeatPayload);
  }

  function setConceptHeatSort(sortKey) {
    if (
      ![
        "hotspotScore",
        "heatScore",
        "shortTermScore",
        "changePct",
        "return60d",
        "return5d",
        "mainNetRatio",
        "upRatio",
      ].includes(sortKey)
    ) {
      return;
    }
    state.conceptHeatSort = sortKey;
    elements.conceptHeatSort
      .querySelectorAll("button[data-heat-sort]")
      .forEach((button) => {
        const active = button.dataset.heatSort === sortKey;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", String(active));
      });
    if (state.conceptHeatPayload) renderConceptHeat(state.conceptHeatPayload);
  }

  function conceptReturnSeries(item, mode, cellCount) {
    const source = Array.isArray(item[mode]) ? item[mode] : [];
    const returns = [];
    for (let index = 1; index < source.length; index += 1) {
      returns.push({
        date: source[index].date,
        value: source[index].close / source[index - 1].close - 1,
      });
    }
    return returns.slice(-cellCount);
  }

  function conceptWindowReturn(item, mode, cellCount) {
    const source = Array.isArray(item[mode]) ? item[mode] : [];
    if (source.length < 2) return Number.NaN;
    const window = source.slice(-(cellCount + 1));
    return window.at(-1).close / window[0].close - 1;
  }

  function heatPersistenceTone(label) {
    if (label === "强持续") return "is-strong";
    if (label === "偏持续") return "is-continuing";
    if (label === "一日脉冲") return "is-pulse";
    if (label === "退潮") return "is-fading";
    return "is-watch";
  }

  function renderConceptRotation(payload) {
    state.conceptRotationPayload = payload;
    const isDaily = state.conceptRotationMode === "day";
    const mode = isDaily ? "daily" : "weekly";
    const cellCount = isDaily ? 20 : 12;
    const periodName = isDaily ? "交易日" : "自然周";
    const concepts = (Array.isArray(payload.concepts) ? payload.concepts : [])
      .filter((item) => (item[mode] || []).length >= cellCount + 1)
      .map((item) => ({
        ...item,
        windowReturn: conceptWindowReturn(item, mode, cellCount),
        returns: conceptReturnSeries(item, mode, cellCount),
      }))
      .sort((left, right) => right.windowReturn - left.windowReturn);

    elements.conceptRotationTime.textContent = payload.quoteTime
      ? `数据截至 ${payload.sourceDate}`
      : "概念轮动快照";
    elements.conceptRotationIntro.textContent =
      `${payload.selectionRule || "选取当前活跃题材概念"} ` +
      `按近${isDaily ? "20个交易日" : "12周"}累计涨跌排序；名称旁的“持续”分数用于比较延续证据，不是上涨概率。`;
    elements.conceptRotationMethod.textContent =
      "热力图为概念板块指数区间涨跌；持续性评分综合趋势结构、资金连续性、上涨广度、动量、量能和过热程度，仅用于观察强弱迁移，不代表未来收益。";
    elements.conceptRotationLossLabel.textContent =
      `${isDaily ? "日" : "周"}跌幅`;
    elements.conceptRotationGainLabel.textContent =
      `${isDaily ? "日" : "周"}涨幅`;
    elements.conceptRotationGrid.classList.toggle("is-daily", isDaily);
    elements.conceptRotationGrid.classList.toggle("is-weekly", !isDaily);
    elements.conceptRotationGrid.setAttribute(
      "aria-label",
      isDaily
        ? "活跃概念最近20个交易日轮动热力图"
        : "活跃概念最近12周轮动热力图",
    );
    if (!concepts.length) {
      elements.conceptRotationGrid.innerHTML =
        '<p class="flow-empty">暂无可用的概念轮动数据</p>';
      return;
    }

    const fragment = document.createDocumentFragment();
    const corner = document.createElement("span");
    corner.className = "heat-week";
    corner.textContent = "概念";
    fragment.append(corner);
    concepts[0].returns.forEach((observation) => {
      const label = document.createElement("span");
      label.className = "heat-week";
      label.textContent = shortDate(observation.date);
      fragment.append(label);
    });

    concepts.forEach((item, rowIndex) => {
      const persistence = item.persistence || {};
      const persistenceScore = Number(persistence.score);
      const persistenceTone = heatPersistenceTone(persistence.label);
      const persistenceText = Number.isFinite(persistenceScore)
        ? `持续 ${persistenceScore.toFixed(1)} · ${persistence.label || "观察"}`
        : "持续数据待确认";
      const row = document.createElement("div");
      row.className = "heat-row-name";
      row.setAttribute("role", "row");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "heat-name";
      button.setAttribute("role", "rowheader");
      button.setAttribute(
        "aria-label",
        `查看${item.name}相关股票，近${cellCount}个${periodName}累计${formatPercent(item.windowReturn)}，${persistenceText}`,
      );
      button.innerHTML = `
        <span class="heat-rank">${String(rowIndex + 1).padStart(2, "0")}</span>
        <span class="heat-name-copy">
          <span class="heat-name-text">${escapeHTML(item.name)}</span>
          <span class="heat-persistence ${persistenceTone}">${escapeHTML(persistenceText)}</span>
        </span>
      `;
      button.addEventListener("click", () => {
        elements.conceptSearchInput.value = item.name;
        loadConceptStocks(item.name, true);
        elements.conceptScreenerPanel.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
          block: "start",
        });
      });
      row.append(button);
      item.returns.forEach((observation) => {
        const cell = document.createElement("span");
        cell.className = "heat-cell";
        cell.setAttribute("role", "gridcell");
        cell.setAttribute(
          "aria-label",
          `${item.name}，${observation.date}，${formatPercent(observation.value)}`,
        );
        cell.title = `${observation.date}  ${formatPercent(observation.value)}`;
        const scale = isDaily ? 0.02 : 0.045;
        const magnitude = Math.min(
          0.82,
          0.1 + (Math.abs(observation.value) / scale) * 0.72,
        );
        if (Math.abs(observation.value) < 0.0003) {
          cell.classList.add("is-flat");
        } else if (observation.value > 0) {
          cell.classList.add("is-up");
          cell.style.setProperty("--alpha", magnitude.toFixed(2));
        } else {
          cell.classList.add("is-down");
          cell.style.setProperty("--alpha", magnitude.toFixed(2));
        }
        row.append(cell);
      });
      fragment.append(row);
    });
    elements.conceptRotationGrid.replaceChildren(fragment);
  }

  async function loadConceptRotation(force = false) {
    if (
      !force &&
      (state.conceptRotationPayload || state.conceptRotationLoading)
    ) {
      return;
    }
    state.conceptRotationRequestId += 1;
    const requestId = state.conceptRotationRequestId;
    state.conceptRotationLoading = true;
    elements.conceptRotationRefresh.disabled = true;
    elements.conceptRotationTime.textContent = force
      ? "正在刷新概念轮动…"
      : "概念轮动载入中…";
    elements.conceptRotationGrid.innerHTML =
      '<p class="flow-empty">正在计算概念历史轮动…</p>';

    if (standalone) {
      if (standalone?.conceptRotation) {
        renderConceptRotation(standalone.conceptRotation);
      } else {
        elements.conceptRotationGrid.innerHTML =
          '<p class="flow-empty">离线版未包含概念轮动快照</p>';
      }
      state.conceptRotationLoading = false;
      elements.conceptRotationRefresh.disabled = false;
      return;
    }

    try {
      const query = force ? "?refresh=1" : "";
      const response = await fetch(`/api/concept-rotation${query}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (requestId !== state.conceptRotationRequestId) return;
      renderConceptRotation(payload);
    } catch {
      if (requestId !== state.conceptRotationRequestId) return;
      elements.conceptRotationTime.textContent = "概念轮动暂时不可用";
      elements.conceptRotationGrid.innerHTML =
        '<p class="flow-empty">暂时无法获取概念轮动数据，请稍后刷新。</p>';
    } finally {
      if (requestId === state.conceptRotationRequestId) {
        state.conceptRotationLoading = false;
        elements.conceptRotationRefresh.disabled = false;
      }
    }
  }

  function normalizeConceptQuery(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
  }

  function conceptLimitThreshold(stock) {
    const code = stock.stockCode || "";
    if (String(stock.name || "").includes("ST")) return 4.8;
    if (/^(300|301|688|689)/.test(code)) return 19.5;
    if (/^(4|8|92)/.test(code)) return 29.5;
    return 9.8;
  }

  function conceptLimitTimeScore(stock) {
    const raw = Number(stock.limitUp?.firstLimitTime);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    const seconds =
      raw > 100_000_000
        ? ((raw + 8 * 60 * 60) % 86_400 + 86_400) % 86_400
        : Math.floor(raw / 10_000) * 3600 +
          Math.floor((raw % 10_000) / 100) * 60 +
          (raw % 100);
    if (seconds <= 34_200) return 1;
    if (seconds <= 37_800) {
      return 1 - ((seconds - 34_200) / 3_600) * 0.4;
    }
    return Math.max(0, 0.6 - ((seconds - 37_800) / 16_200) * 0.6);
  }

  function attachConceptHistoryMetrics(stocks) {
    const historyStocks = stocks.filter(
      (stock) => Array.isArray(stock.history) && stock.history.length >= 3,
    );
    const returnsByDate = new Map();
    historyStocks.forEach((stock) => {
      const history = stock.history.slice(-6);
      const returns = history
        .slice(1)
        .map((bar, index) => ({
          date: bar.date,
          value: bar.close / history[index].close - 1,
        }));
      stock._historyReturns = returns;
      returns.forEach((observation) => {
        if (!returnsByDate.has(observation.date)) {
          returnsByDate.set(observation.date, []);
        }
        returnsByDate.get(observation.date).push({
          code: stock.code,
          value: observation.value,
        });
      });
    });
    const metrics = new Map();
    [...returnsByDate.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(-5)
      .forEach(([, observations]) => {
        if (observations.length < 3) return;
        const values = observations.map((item) => item.value);
        const positiveCount = values.filter((value) => value > 0).length;
        observations.forEach((observation) => {
          const item = metrics.get(observation.code) || {
            observedDays: 0,
            leadDays: 0,
            followSum: 0,
            followCount: 0,
          };
          item.observedDays += 1;
          if (valuePercentile(values, observation.value) >= 80) {
            item.leadDays += 1;
          }
          if (observation.value >= 0.02) {
            item.followSum += positiveCount / values.length;
            item.followCount += 1;
          }
          metrics.set(observation.code, item);
        });
      });
    stocks.forEach((stock) => {
      const item = metrics.get(stock.code);
      stock.leadRate = item?.observedDays
        ? item.leadDays / item.observedDays
        : 0;
      stock.followEffect = item?.followCount
        ? item.followSum / item.followCount
        : 0;
      stock.leadDays = item?.leadDays || 0;
      delete stock._historyReturns;
    });
  }

  function classifyConceptRoles(stocks) {
    if (!stocks.length) return [];
    attachConceptHistoryMetrics(stocks);
    const metricValues = {
      changePct: stocks.map((item) => item.changePct),
      return5d: stocks.map((item) => item.return5d),
      amount: stocks.map((item) => item.amount),
      mainNetRatio: stocks.map((item) => item.mainNetRatio),
      mainNetInflow: stocks.map((item) => item.mainNetInflow),
      marketCap: stocks.map((item) => item.marketCap),
      turnoverRate: stocks.map((item) => item.turnoverRate),
      volumeRatio: stocks.map((item) => item.volumeRatio),
    };
    const rank = (metric, value) =>
      valuePercentile(metricValues[metric], value) || 0;
    const enriched = stocks.map((item) => {
      const limitThreshold = conceptLimitThreshold(item);
      const isLimitUp =
        Boolean(item.limitUp) || (item.changePct || 0) >= limitThreshold;
      const boardCount = isLimitUp
        ? Math.max(1, Number(item.limitUp?.boardCount || 1))
        : 0;
      const boardScore = Math.min(1, Math.max(0, boardCount - 1) / 4);
      const earlyScore = isLimitUp ? conceptLimitTimeScore(item) : 0;
      const openCount = Math.max(0, Number(item.limitUp?.openCount || 0));
      const sealScore = isLimitUp ? Math.max(0, 1 - openCount * 0.12) : 0;
      const leadershipScore =
        rank("changePct", item.changePct) * 0.16 +
        rank("return5d", item.return5d) * 0.12 +
        rank("amount", item.amount) * 0.08 +
        rank("mainNetRatio", item.mainNetRatio) * 0.08 +
        rank("volumeRatio", item.volumeRatio) * 0.04 +
        rank("turnoverRate", item.turnoverRate) * 0.02 +
        (isLimitUp ? 8 : 0) +
        boardScore * 14 +
        earlyScore * 10 +
        sealScore * 3 +
        (item.leadRate || 0) * 9 +
        (item.followEffect || 0) * 6;
      const capacityScore =
        rank("marketCap", item.marketCap) * 0.4 +
        rank("amount", item.amount) * 0.22 +
        rank("mainNetInflow", item.mainNetInflow) * 0.08 +
        rank("mainNetRatio", item.mainNetRatio) * 0.05 +
        rank("changePct", item.changePct) * 0.05 +
        (item.leadRate || 0) * 8 +
        (item.followEffect || 0) * 5 +
        rank("turnoverRate", item.turnoverRate) * 0.04 +
        rank("volumeRatio", item.volumeRatio) * 0.03;
      const roleReasons = [];
      if (item.limitUp?.boardLabel) roleReasons.push(item.limitUp.boardLabel);
      else if (isLimitUp) roleReasons.push("涨停");
      if (earlyScore >= 0.8 && isLimitUp) roleReasons.push("早盘封板");
      if (openCount > 0 && isLimitUp) roleReasons.push(`炸板${openCount}次`);
      if ((item.leadRate || 0) >= 0.4) {
        roleReasons.push(`近5日${item.leadDays}次领先`);
      }
      if ((item.followEffect || 0) >= 0.6) {
        roleReasons.push("上涨时板块共振");
      }
      if ((item.mainNetRatio || 0) >= 10) roleReasons.push("主力占比高");
      return {
        ...item,
        historyLeadRate: item.leadRate || 0,
        historyFollowEffect: item.followEffect || 0,
        isLimitUp,
        limitThreshold,
        boardCount,
        leadershipScore:
          Math.round(Math.min(100, leadershipScore) * 10) / 10,
        capacityScore: Math.round(Math.min(100, capacityScore) * 10) / 10,
        roleReasons,
        role: "跟风/分歧",
        roleTone: "is-follower",
      };
    });
    const leaderCount = Math.min(
      12,
      Math.max(2, Math.ceil(enriched.length * 0.04)),
    );
    const midCount = Math.min(
      20,
      Math.max(3, Math.ceil(enriched.length * 0.06)),
    );
    const rankedLeaders = enriched
      .slice()
      .sort((left, right) => right.leadershipScore - left.leadershipScore);
    const leaderCodes = new Set(
      rankedLeaders.slice(0, leaderCount).map((item) => item.code),
    );
    rankedLeaders
      .filter(
        (item) =>
          item.leadershipScore >= 85 ||
          (item.isLimitUp &&
            item.boardCount >= 2 &&
            item.leadershipScore >= 65) ||
          (item.historyLeadRate >= 0.6 && item.leadershipScore >= 70),
      )
      .forEach((item) => leaderCodes.add(item.code));
    enriched
      .filter((item) => leaderCodes.has(item.code))
      .forEach((item) => {
        item.role = "龙头候选";
        item.roleTone = "is-leader";
      });
    enriched
      .filter((item) => item.role !== "龙头候选")
      .sort((left, right) => right.capacityScore - left.capacityScore)
      .slice(0, midCount)
      .forEach((item) => {
        item.role = "中军候选";
        item.roleTone = "is-core";
      });
    return enriched;
  }

  function renderConceptRoleSummary(stocks) {
    if (!stocks.length) {
      elements.conceptRoleSummary.hidden = true;
      elements.conceptRoleSummary.replaceChildren();
      return;
    }
    const leaders = stocks
      .filter((item) => item.role === "龙头候选")
      .sort((left, right) => right.leadershipScore - left.leadershipScore);
    const cores = stocks
      .filter((item) => item.role === "中军候选")
      .sort((left, right) => right.capacityScore - left.capacityScore);
    const candidateButton = (item) => `
      <button
        type="button"
        class="concept-role-candidate"
        data-role-company-code="${escapeHTML(item.code)}"
        data-role-company-name="${escapeHTML(item.name)}"
      >
        <span>${escapeHTML(item.name)}</span>
        <b class="${metricTone(item.changePct)}">${formatRate(item.changePct, 2, true)}</b>
        <small>${escapeHTML(
          (item.roleReasons.length
            ? item.roleReasons
            : [
                `5日 ${formatRate(item.return5d, 1, true)}`,
                `市值 ${formatYi(item.marketCap, 1, false)}`,
              ]
          )
            .slice(0, 3)
            .join(" · "),
        )}</small>
      </button>
    `;
    elements.conceptRoleSummary.hidden = false;
    elements.conceptRoleSummary.innerHTML = `
      <article class="concept-role-group is-leader">
        <div class="concept-role-group-heading">
          <strong>龙头候选</strong>
          <span>涨幅、5日动量、成交与资金共同领先</span>
        </div>
        <div class="concept-role-candidates">${leaders.map(candidateButton).join("")}</div>
      </article>
      <article class="concept-role-group is-core">
        <div class="concept-role-group-heading">
          <strong>中军候选</strong>
          <span>市值、成交容量和资金承接较强</span>
        </div>
        <div class="concept-role-candidates">${cores.map(candidateButton).join("")}</div>
      </article>
      <p class="concept-role-method">
        严格候选模型结合板块差异化涨停阈值、首次封板、连板、炸板、近5日板块内领导稳定性和共振跟随。角色仍会随行情变化，不是官方固定标签。
      </p>
    `;
  }

  function renderConceptPlaceholder(message) {
    elements.conceptMatchSummary.innerHTML =
      `<span>${escapeHTML(message)}</span>`;
    elements.conceptMarketNote.textContent = "";
    elements.conceptRoleSummary.hidden = true;
    elements.conceptRoleSummary.replaceChildren();
    elements.conceptStockBody.innerHTML =
      `<tr><td colspan="9" class="company-empty">${escapeHTML(message)}</td></tr>`;
  }

  function renderConceptStocks(payload) {
    state.conceptStocksPayload = payload;
    const concepts = Array.isArray(payload.concepts) ? payload.concepts : [];
    const stocks = Array.isArray(payload.stocks) ? payload.stocks : [];
    const roleStocks = classifyConceptRoles(stocks);
    const suggestions = Array.isArray(payload.suggestions)
      ? payload.suggestions
      : [];
    elements.conceptScreenerTime.textContent = payload.quoteTime
      ? `盘中快照 ${formatFlowTime(payload.quoteTime)}`
      : "概念数据快照";

    if (!concepts.length) {
      elements.conceptMatchSummary.innerHTML = suggestions.length
        ? `
          <span>未找到“${escapeHTML(payload.query)}”的直接概念，可尝试：</span>
          ${suggestions
            .map(
              (name) =>
                `<button type="button" class="concept-match-chip" data-concept-search="${escapeHTML(name)}">${escapeHTML(name)}</button>`,
            )
            .join("")}
        `
        : `<span>未找到“${escapeHTML(payload.query)}”的直接或相近概念</span>`;
      elements.conceptMarketNote.textContent =
        "东方财富概念板块名称会随市场调整；也可以输入更短的关键词。";
      elements.conceptStockBody.innerHTML =
        '<tr><td colspan="9" class="company-empty">没有匹配到成分股</td></tr>';
      elements.conceptRoleSummary.hidden = true;
      elements.conceptRoleSummary.replaceChildren();
      return;
    }

    elements.conceptMatchSummary.innerHTML = `
      <span>匹配概念：</span>
      ${concepts
        .map(
          (item) => `
            <button
              type="button"
              class="concept-match-chip ${item.matchType === "related" ? "is-related" : ""}"
              data-concept-search="${escapeHTML(item.name)}"
              title="${escapeHTML(item.matchType === "related" ? "相近概念" : "直接匹配")}"
            >
              ${escapeHTML(item.name)}
              · ${item.memberCount || 0}只
              · ${formatRate(item.changePct, 2, true)}
            </button>
          `,
        )
        .join("")}
      <span>共 ${stocks.length} 只去重股票</span>
    `;
    if (payload.isAliasMatch) {
      elements.conceptMarketNote.textContent =
        payload.aliasNote ||
        "概念库没有完全同名板块，当前结果为相近概念映射，不是官方同名概念。";
    } else {
      elements.conceptMarketNote.textContent =
        "股票按所属概念板块合并去重，并按主力净流入从高到低排列。";
    }
    if (!stocks.length) {
      elements.conceptStockBody.innerHTML =
        '<tr><td colspan="9" class="company-empty">概念存在，但未取得成分股行情</td></tr>';
      elements.conceptRoleSummary.hidden = true;
      elements.conceptRoleSummary.replaceChildren();
      return;
    }
    renderConceptRoleSummary(roleStocks);
    elements.conceptStockBody.innerHTML = roleStocks
      .map((item) => {
        const flowTone =
          item.mainNetInflow > 0
            ? "main-inflow-positive"
            : item.mainNetInflow < 0
              ? "main-inflow-negative"
              : "";
        return `
          <tr data-company-code="${escapeHTML(item.code)}" data-company-name="${escapeHTML(item.name)}">
            <td>
              <button type="button" class="company-name">${escapeHTML(item.name)}</button>
            </td>
            <td class="company-code">${escapeHTML(item.stockCode)}</td>
            <td>
              <span class="concept-role-pill ${item.roleTone}" title="龙头分 ${item.leadershipScore.toFixed(1)} · 中军分 ${item.capacityScore.toFixed(1)} · ${escapeHTML(item.roleReasons.join(" · ") || "暂无强证据")}">
                ${escapeHTML(item.role)}
              </span>
            </td>
            <td class="numeric">${Number.isFinite(item.price) ? item.price.toFixed(2) : "—"}</td>
            <td class="numeric ${metricTone(item.changePct)}">${formatRate(item.changePct, 2, true)}</td>
            <td class="numeric ${flowTone}">${formatAdaptiveFlow(item.mainNetInflow)}</td>
            <td class="numeric ${metricTone(item.mainNetRatio)}">${formatRate(item.mainNetRatio, 2, true)}</td>
            <td class="numeric">${formatMultiple(item.volumeRatio)}</td>
            <td><span class="concept-tags">${escapeHTML((item.concepts || []).join("、"))}</span></td>
          </tr>
        `;
      })
      .join("");
  }

  async function loadConceptStocks(queryText, force = false) {
    const query = String(queryText || "").trim();
    if (!query) {
      renderConceptPlaceholder("请输入概念名称");
      return;
    }
    const normalized = normalizeConceptQuery(query);
    if (
      !force &&
      state.conceptStocksPayload &&
      normalizeConceptQuery(state.conceptStocksPayload.query) === normalized
    ) {
      return;
    }
    state.conceptSearchRequestId += 1;
    const requestId = state.conceptSearchRequestId;
    state.conceptSearchLoading = true;
    elements.conceptSearchSubmit.disabled = true;
    elements.conceptScreenerTime.textContent = "正在匹配概念与成分股…";
    renderConceptPlaceholder("正在查询概念板块和成分股…");

    if (standalone) {
      const snapshot = standalone?.conceptStocks?.[normalized];
      if (snapshot) {
        renderConceptStocks(snapshot);
        elements.conceptScreenerTime.textContent =
          `离线快照 ${formatFlowTime(snapshot.quoteTime)}`;
      } else {
        elements.conceptScreenerTime.textContent = "离线版未包含该概念";
        renderConceptPlaceholder(
          "单文件离线版只包含预生成的概念股票快照，请使用服务版查询其他概念。",
        );
      }
      state.conceptSearchLoading = false;
      elements.conceptSearchSubmit.disabled = false;
      return;
    }

    try {
      const params = new URLSearchParams({ q: query });
      if (force) params.set("refresh", "1");
      const response = await fetch(`/api/concept-stocks?${params.toString()}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (requestId !== state.conceptSearchRequestId) return;
      renderConceptStocks(payload);
    } catch {
      if (requestId !== state.conceptSearchRequestId) return;
      elements.conceptScreenerTime.textContent = "概念查询暂时不可用";
      renderConceptPlaceholder("概念数据暂时无法获取，请稍后重试。");
    } finally {
      if (requestId === state.conceptSearchRequestId) {
        state.conceptSearchLoading = false;
        elements.conceptSearchSubmit.disabled = false;
      }
    }
  }

  function eventLifecycleTone(label) {
    if (label === "扩散") return "is-expanding";
    if (label === "延续") return "is-lasting";
    if (label === "新事件") return "is-new";
    if (label === "降温") return "is-cooling";
    if (label === "个股事件") return "is-single";
    return "is-watch";
  }

  function renderEventThemes(payload) {
    state.eventThemePayload = payload;
    const themes = Array.isArray(payload.themes) ? payload.themes : [];
    elements.eventThemeTime.textContent = payload.sourceDate
      ? `截至 ${payload.sourceDate}`
      : "事件主题快照";
    elements.eventThemeMethod.textContent =
      payload.method ||
      "事件主题来自近期涨停原因，只用于观察短线事件驱动，不代表主题能够持续。";
    if (!themes.length) {
      elements.eventThemeSummary.textContent = "暂无可用的涨停原因聚类";
      elements.eventThemeGrid.innerHTML =
        '<p class="flow-empty">最近交易日没有可聚合的事件主题。</p>';
      return;
    }
    const leaders = themes.slice(0, 3).map((item) => item.name);
    elements.eventThemeSummary.innerHTML = `
      最近交易日共扫描 <strong>${payload.scannedCount || 0}</strong> 只涨停股，
      自动识别 <strong>${payload.eventThemeCount || themes.length}</strong> 个事件标签。
      当前最强：<strong>${leaders.map(escapeHTML).join("、")}</strong>。
    `;
    elements.eventThemeGrid.innerHTML = themes
      .slice(0, 12)
      .map((theme, index) => {
        const tone = eventLifecycleTone(theme.lifecycle);
        const history = Array.isArray(theme.history) ? theme.history : [];
        const historyNote =
          `近${history.length || 5}日涨停股数 · 左→右：` +
          history.map((point) => shortDate(point.date)).join(" → ");
        const maxHistory = Math.max(
          1,
          ...history.map((point) => Number(point.count) || 0),
        );
        const stocks = Array.isArray(theme.stocks) ? theme.stocks : [];
        return `
          <article class="event-theme-card ${tone}">
            <div class="event-theme-card-head">
              <span class="event-theme-rank">${String(index + 1).padStart(2, "0")}</span>
              <div>
                <h3>${escapeHTML(theme.name)}</h3>
                <span class="event-theme-lifecycle ${tone}">${escapeHTML(theme.lifecycle || "观察")}</span>
              </div>
              <span class="event-theme-score">${Number(theme.score || 0).toFixed(1)}</span>
            </div>
            <div
              class="event-theme-history"
              style="grid-template-columns:repeat(${Math.max(1, history.length)},minmax(0,1fr))"
              aria-label="近${history.length}个交易日标签出现股票数"
            >
              ${history
                .map((point) => {
                  const count = Number(point.count || 0);
                  return `
                    <button
                      type="button"
                      class="event-theme-history-bar"
                      data-event-history-date="${escapeHTML(point.date)}"
                      data-event-history-count="${count}"
                      style="--level:${Math.max(6, (count / maxHistory) * 100).toFixed(1)}%"
                      title="${escapeHTML(point.date)}：${count}只涨停股"
                      aria-label="${escapeHTML(point.date)}，${count}只涨停股"
                    >
                      <b>${count}</b>
                      <span class="event-theme-history-track"><i></i></span>
                      <small>${shortDate(point.date)}</small>
                    </button>
                  `;
                })
                .join("")}
            </div>
            <p
              class="event-theme-history-note"
              data-default-note="${escapeHTML(historyNote)}"
            >${escapeHTML(historyNote)}</p>
            <div class="event-theme-metrics">
              <span><small>涨停股</small><b>${Number(theme.count || 0)}只</b></span>
              <span><small>最高连板</small><b>${Number(theme.maxBoard || 1)}板</b></span>
              <span><small>封单合计</small><b>${formatYi(theme.orderAmount)}</b></span>
              <span><small>5日复现</small><b>${Number(theme.appearances || 0)}/${history.length || 5}日</b></span>
            </div>
            <p class="event-theme-stocks-title">
              当前涉及涨停股 · ${stocks.length}只
              <span>点击公司查看研究</span>
            </p>
            <div class="event-theme-stocks">
              ${stocks
                .map(
                  (stock, stockIndex) => `
                    <button
                      type="button"
                      class="event-theme-stock ${stockIndex >= 6 ? "is-extra" : ""}"
                      data-event-company-code="${escapeHTML(stock.code)}"
                      data-event-company-name="${escapeHTML(stock.name)}"
                      title="${escapeHTML(stock.reasonText || "")}"
                    >
                      <span>${escapeHTML(stock.name)}</span>
                      <small>${escapeHTML(stock.boardLabel || "首板")} · ${escapeHTML(stock.code.replace(/\.(SH|SZ|BJ)$/i, ""))}</small>
                    </button>
                  `,
                )
                .join("")}
            </div>
            ${stocks.length > 6
              ? `
                <button
                  type="button"
                  class="event-theme-expand"
                  data-event-expand
                  aria-expanded="false"
                >
                  查看全部 ${stocks.length} 只
                </button>
              `
              : ""}
          </article>
        `;
      })
      .join("");
  }

  async function loadEventThemes(force = false) {
    if (!force && (state.eventThemePayload || state.eventThemeLoading)) return;
    state.eventThemeRequestId += 1;
    const requestId = state.eventThemeRequestId;
    state.eventThemeLoading = true;
    elements.eventThemeRefresh.disabled = true;
    elements.eventThemeTime.textContent = force
      ? "正在刷新涨停原因…"
      : "事件主题载入中…";
    elements.eventThemeSummary.textContent = "正在整理最近交易日的涨停原因…";
    elements.eventThemeGrid.innerHTML =
      '<p class="flow-empty">正在聚合动态事件标签…</p>';

    if (standalone) {
      if (standalone?.eventThemes) {
        renderEventThemes(standalone.eventThemes);
        elements.eventThemeTime.textContent =
          `离线快照 ${standalone.eventThemes.sourceDate || ""}`.trim();
      } else {
        elements.eventThemeSummary.textContent = "离线版未包含事件主题快照";
        elements.eventThemeGrid.innerHTML =
          '<p class="flow-empty">请使用联网版刷新事件主题。</p>';
      }
      state.eventThemeLoading = false;
      elements.eventThemeRefresh.disabled = false;
      return;
    }

    try {
      const query = force ? "?refresh=1" : "";
      const response = await fetch(`/api/event-themes${query}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (requestId !== state.eventThemeRequestId) return;
      renderEventThemes(payload);
    } catch {
      if (requestId !== state.eventThemeRequestId) return;
      elements.eventThemeTime.textContent = "事件主题暂时不可用";
      elements.eventThemeSummary.textContent = "暂时无法获取涨停原因数据";
      elements.eventThemeGrid.innerHTML =
        '<p class="flow-empty">请稍后刷新事件主题。</p>';
    } finally {
      if (requestId === state.eventThemeRequestId) {
        state.eventThemeLoading = false;
        elements.eventThemeRefresh.disabled = false;
      }
    }
  }

  function setupEventThemes() {
    elements.eventThemeRefresh.addEventListener("click", () =>
      loadEventThemes(true),
    );
    elements.eventThemeGrid.addEventListener("click", (event) => {
      const expandButton = event.target.closest("button[data-event-expand]");
      if (expandButton) {
        const card = expandButton.closest(".event-theme-card");
        const expanded = card.classList.toggle("is-expanded");
        expandButton.setAttribute("aria-expanded", String(expanded));
        const total = card.querySelectorAll(".event-theme-stock").length;
        expandButton.textContent = expanded
          ? "收起个股"
          : `查看全部 ${total} 只`;
        return;
      }
      const historyBar = event.target.closest(
        "button[data-event-history-date]",
      );
      if (historyBar) {
        const card = historyBar.closest(".event-theme-card");
        const wasActive = historyBar.classList.contains("is-active");
        card
          ?.querySelectorAll(".event-theme-history-bar")
          .forEach((item) =>
            item.classList.toggle(
              "is-active",
              item === historyBar && !wasActive,
            ),
          );
        const note = card?.querySelector(".event-theme-history-note");
        if (note) {
          note.textContent = wasActive
            ? note.dataset.defaultNote || ""
            : `${historyBar.dataset.eventHistoryDate} · ` +
              `${historyBar.dataset.eventHistoryCount}只涨停股`;
        }
        return;
      }
      const button = event.target.closest("button[data-event-company-code]");
      if (!button) return;
      openCompanyFromSearch({
        code: button.dataset.eventCompanyCode,
        name: button.dataset.eventCompanyName,
      });
    });
    if (state.activeView === "concept") loadEventThemes();
    window.setInterval(() => {
      if (
        state.activeView === "concept" &&
        !document.hidden &&
        !standalone &&
        isChinaTradingWindow()
      ) {
        loadEventThemes();
      }
    }, 60_000);
  }

  function setupConceptHeat() {
    elements.conceptHeatMode.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-heat-mode]");
      if (button) setConceptHeatMode(button.dataset.heatMode);
    });
    elements.conceptHeatSort.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-heat-sort]");
      if (button) setConceptHeatSort(button.dataset.heatSort);
    });
    elements.conceptHeatRefresh.addEventListener("click", () =>
      loadConceptHeat(true),
    );
    elements.conceptHeatGrid.addEventListener("click", (event) => {
      const card = event.target.closest("button[data-heat-concept]");
      if (!card) return;
      const query = card.dataset.heatConcept;
      elements.conceptSearchInput.value = query;
      loadConceptStocks(query, true);
      elements.conceptScreenerPanel.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "start",
      });
    });
    if (state.activeView === "concept") loadConceptHeat();
    window.setInterval(() => {
      if (
        state.activeView === "concept" &&
        !document.hidden &&
        !standalone &&
        isChinaTradingWindow()
      ) {
        loadConceptHeat();
      }
    }, 60_000);
  }

  function hideConceptIntradayPointer() {
    const geometry = state.conceptIntradayFlowGeometry;
    if (!geometry) return;
    geometry.hoverGroup.setAttribute("opacity", "0");
    elements.conceptIntradayFlowReadout.textContent =
      state.conceptIntradayFlowMode === "velocity"
        ? "移到曲线上查看各概念同一时刻的5分钟资金速度"
        : "移到曲线上查看各概念同一时刻的累计资金流";
  }

  function handleConceptIntradayPointer(event) {
    const geometry = state.conceptIntradayFlowGeometry;
    if (!geometry) return;
    const rect = elements.conceptIntradayFlowChart.getBoundingClientRect();
    const chartX =
      ((event.clientX - rect.left) / Math.max(1, rect.width)) *
      geometry.width;
    if (
      chartX < geometry.margin.left ||
      chartX > geometry.margin.left + geometry.plotWidth
    ) {
      hideConceptIntradayPointer();
      return;
    }
    const ratio =
      (chartX - geometry.margin.left) / Math.max(1, geometry.plotWidth);
    const targetTimestamp =
      geometry.start + ratio * (geometry.end - geometry.start);
    const rows = geometry.series.map((item) => {
      const point = item.timestamped.reduce((best, current) =>
        Math.abs(current.timestamp - targetTimestamp) <
        Math.abs(best.timestamp - targetTimestamp)
          ? current
          : best,
      );
      return {
        name: item.name,
        time: point.time,
        timestamp: point.timestamp,
        value: point.value,
      };
    });
    const anchor = rows[0];
    geometry.crosshair.setAttribute("x1", chartX);
    geometry.crosshair.setAttribute("x2", chartX);
    geometry.hoverGroup.setAttribute("opacity", "1");
    rows.sort((left, right) => right.value - left.value);
    const top = rows.slice(0, 5);
    const bottom = rows.slice(-3).reverse();
    const unit =
      state.conceptIntradayFlowMode === "velocity" ? "亿/分" : "亿";
    elements.conceptIntradayFlowReadout.innerHTML = `
      <strong>${anchor.time.slice(11)}</strong>
      · 流入：${top
        .map(
          (item) =>
            `${escapeHTML(item.name)} ${formatSignedFlowNumber(item.value, 2)}${unit}`,
        )
        .join(" / ")}
      · 流出：${bottom
        .map(
          (item) =>
            `${escapeHTML(item.name)} ${formatSignedFlowNumber(item.value, 2)}${unit}`,
        )
        .join(" / ")}
    `;
  }

  function setupConceptIntradayFlow() {
    elements.conceptIntradayFlowMode.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-intraday-flow-mode]");
      if (!button) return;
      const mode = button.dataset.intradayFlowMode;
      if (!["cumulative", "velocity"].includes(mode)) return;
      state.conceptIntradayFlowMode = mode;
      elements.conceptIntradayFlowMode
        .querySelectorAll("button[data-intraday-flow-mode]")
        .forEach((item) => {
          const active = item.dataset.intradayFlowMode === mode;
          item.classList.toggle("is-active", active);
          item.setAttribute("aria-pressed", String(active));
        });
      if (state.conceptIntradayFlowPayload) {
        if (state.conceptIntradayFlowScope === "focus") {
          applyConceptIntradayFlowScope(
            state.conceptIntradayFlowPayload,
            "focus",
          );
        }
        renderConceptIntradayFlow(state.conceptIntradayFlowPayload);
      }
    });
    elements.conceptIntradayFlowScope.addEventListener("click", (event) => {
      const button = event.target.closest(
        "button[data-intraday-flow-scope]",
      );
      if (!button || !state.conceptIntradayFlowPayload) return;
      applyConceptIntradayFlowScope(
        state.conceptIntradayFlowPayload,
        button.dataset.intradayFlowScope,
      );
      renderConceptIntradayFlow(state.conceptIntradayFlowPayload);
    });
    elements.conceptIntradayFlowRefresh.addEventListener("click", () =>
      loadConceptIntradayFlow(true),
    );
    elements.conceptIntradayFlowLegend.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-concept-flow-code]");
      if (!button) return;
      const code = button.dataset.conceptFlowCode;
      if (state.conceptIntradayFlowHidden.has(code)) {
        state.conceptIntradayFlowHidden.delete(code);
      } else {
        state.conceptIntradayFlowHidden.add(code);
      }
      if (state.conceptIntradayFlowPayload) {
        renderConceptIntradayFlow(state.conceptIntradayFlowPayload);
      }
    });
    elements.conceptIntradayFlowChart.addEventListener(
      "pointermove",
      handleConceptIntradayPointer,
    );
    elements.conceptIntradayFlowChart.addEventListener(
      "pointerleave",
      hideConceptIntradayPointer,
    );
    if ("ResizeObserver" in window) {
      const observer = new ResizeObserver(() =>
        requestAnimationFrame(drawConceptIntradayFlowChart),
      );
      observer.observe(elements.conceptIntradayFlowChartWrap);
    }
    if (state.activeView === "concept") loadConceptIntradayFlow();
    window.setInterval(() => {
      if (
        state.activeView === "concept" &&
        !document.hidden &&
        !standalone &&
        isChinaTradingWindow()
      ) {
        loadConceptIntradayFlow();
      }
    }, 60_000);
  }

  function setupConceptRotation() {
    elements.conceptRotationMode.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-concept-rotation-mode]");
      if (!button) return;
      const mode = button.dataset.conceptRotationMode;
      if (!["week", "day"].includes(mode)) return;
      state.conceptRotationMode = mode;
      elements.conceptRotationMode
        .querySelectorAll("button[data-concept-rotation-mode]")
        .forEach((item) => {
          const active = item.dataset.conceptRotationMode === mode;
          item.classList.toggle("is-active", active);
          item.setAttribute("aria-pressed", String(active));
        });
      if (state.conceptRotationPayload) {
        renderConceptRotation(state.conceptRotationPayload);
      }
    });
    elements.conceptRotationRefresh.addEventListener("click", () =>
      loadConceptRotation(true),
    );
    if (state.activeView === "concept") loadConceptRotation();
  }

  function setupConceptSearch() {
    elements.conceptSearchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      loadConceptStocks(elements.conceptSearchInput.value, true);
    });
    elements.conceptPresets.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-concept-preset]");
      if (!button) return;
      elements.conceptSearchInput.value = button.dataset.conceptPreset;
      loadConceptStocks(button.dataset.conceptPreset, true);
    });
    elements.conceptMatchSummary.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-concept-search]");
      if (!button) return;
      const query = button.dataset.conceptSearch;
      elements.conceptSearchInput.value = query;
      loadConceptStocks(query, true);
    });
    elements.conceptRoleSummary.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-role-company-code]");
      if (!button) return;
      void openCompanyFromSearch({
        code: button.dataset.roleCompanyCode,
        name: button.dataset.roleCompanyName,
      });
    });
    elements.conceptStockBody.addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-company-code]");
      if (!row) return;
      openCompanyFromSearch({
        code: row.dataset.companyCode,
        name: row.dataset.companyName,
      });
    });
  }

  function setupMarketPulse() {
    elements.marketPulseRefresh.addEventListener("click", () =>
      loadMarketPulse(true),
    );
    if (state.activeView === "flow") loadMarketPulse();
    window.setInterval(() => {
      if (
        state.activeView === "flow" &&
        !document.hidden &&
        !standalone &&
        isChinaTradingWindow()
      ) {
        loadMarketPulse();
      }
    }, 60_000);
    document.addEventListener("visibilitychange", () => {
      if (
        state.activeView === "flow" &&
        !document.hidden &&
        !standalone &&
        isChinaTradingWindow()
      ) {
        loadMarketPulse();
      }
    });
  }

  function setupIndustryFlow() {
    elements.industryFlowControls.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-flow-sort]");
      if (!button) return;
      state.industryFlowSort = button.dataset.flowSort;
      elements.industryFlowControls
        .querySelectorAll("button[data-flow-sort]")
        .forEach((item) => {
          const active = item === button;
          item.classList.toggle("is-active", active);
          item.setAttribute("aria-pressed", String(active));
        });
      renderIndustryFlow();
    });
    elements.industryFlowGrid.addEventListener("click", (event) => {
      const card = event.target.closest("button[data-industry-code]");
      if (!card?.dataset.industryCode) return;
      setActiveView("industry");
      selectIndustry(card.dataset.industryCode);
      document.getElementById("chart-heading")?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "start",
      });
    });
    elements.industryFlowRefresh.addEventListener("click", () =>
      loadIndustryFlow(true),
    );
    loadIndustryFlow();
    state.industryFlowRefreshTimer = window.setInterval(() => {
      if (
        !document.hidden &&
        !standalone &&
        isChinaTradingWindow()
      ) {
        loadIndustryFlow();
        if (state.activeView === "flow") loadLevel2Flow();
      }
    }, 60_000);
    document.addEventListener("visibilitychange", () => {
      if (
        !document.hidden &&
        !standalone &&
        isChinaTradingWindow()
      ) {
        loadIndustryFlow();
        if (state.activeView === "flow") loadLevel2Flow();
      }
    });
  }

  function resolveCompanyIndustry(payload) {
    const path = Array.isArray(payload.industryPath)
      ? payload.industryPath
      : [];
    const level1 = path.find((item) => item.level === 1);
    const level2 = path.find((item) => item.level === 2);
    const level3 = path.find((item) => item.level === 3);
    const fallbackParts = String(payload.industry || "").split("-");
    const level1Name = level1?.name || fallbackParts[0];
    const level2Name = level2?.name || fallbackParts[1];
    const primary = industries.find((item) => item.name === level1Name);
    const secondary = primary
      ? (subIndustriesByParent.get(primary.code) || []).find(
          (item) => item.name === level2Name,
        )
      : null;
    return {
      primary,
      secondary,
      level1Name,
      level2Name,
      level3Name: level3?.name || fallbackParts[2],
    };
  }

  async function focusCompanyIndustry(payload, level) {
    const path = resolveCompanyIndustry(payload);
    if (!path.primary) return;
    setActiveView("industry");
    selectIndustry(path.primary.code);
    if (level >= 2 && path.secondary) {
      await selectSubIndustry(path.secondary.code);
    }
    document.querySelector(".trend-panel").scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "start",
    });
  }

  function clearGlobalCompanyResults() {
    state.companySearchResults = [];
    elements.globalCompanyResults.hidden = true;
    elements.globalCompanyResults.replaceChildren();
  }

  function renderGlobalCompanyResults(companies) {
    state.companySearchResults = companies;
    if (!companies.length) {
      clearGlobalCompanyResults();
      return;
    }
    const fragment = document.createDocumentFragment();
    companies.forEach((company) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "company-locator-result";
      button.setAttribute("role", "option");
      button.innerHTML = `
        <span>${escapeHTML(company.name)}</span>
        <code>${escapeHTML(company.code)}</code>
      `;
      button.addEventListener("click", () => openCompanyFromSearch(company));
      fragment.append(button);
    });
    elements.globalCompanyResults.replaceChildren(fragment);
    elements.globalCompanyResults.hidden = false;
  }

  async function openCompanyFromSearch(company) {
    setActiveView("company");
    clearGlobalCompanyResults();
    elements.globalCompanySearch.value =
      `${company.name} · ${company.code}`;
    elements.globalCompanyStatus.textContent =
      `正在识别 ${company.name} 的行业和概念…`;
    try {
      const payload = await ensureCompanyInfo(company.code, true);
      const path = resolveCompanyIndustry(payload);
      if (path.primary) {
        selectIndustry(path.primary.code);
        if (path.secondary) {
          await selectSubIndustry(path.secondary.code);
        }
      }
      elements.companySection.hidden = false;
      syncCompanyViewHelp();
      await loadCompanyInfo(
        {
          code: payload.code || company.code,
          name: payload.name || company.name,
        },
        payload,
      );
      const pathText = [path.level1Name, path.level2Name, path.level3Name]
        .filter(Boolean)
        .join(" → ");
      elements.globalCompanyStatus.textContent =
        `${company.name} · ${pathText || "行业待确认"}`;
      elements.companyDetail.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "start",
      });
    } catch {
      elements.globalCompanyStatus.textContent =
        standalone
          ? `离线单文件版暂未内置 ${company.name} 的详细资料。`
          : "公司与行业信息暂时无法载入，请稍后重试。";
    }
  }

  async function searchGlobalCompanies(query) {
    state.companySearchRequestId += 1;
    const requestId = state.companySearchRequestId;
    const term = query.trim();
    if (!term) {
      clearGlobalCompanyResults();
      elements.globalCompanyStatus.textContent =
        "无需先选择行业，可直接从公司开始。";
      return;
    }
    elements.globalCompanyStatus.textContent = "正在搜索公司…";
    if (standalone?.companyDirectory) {
      const normalizedTerm = term.toLowerCase().replace(/\s+/g, "");
      const cachedCodes = new Set(
        Object.keys(standalone.companyInfo || {}).map((code) =>
          code.toUpperCase(),
        ),
      );
      const companies = standalone.companyDirectory
        .filter((company) => cachedCodes.has(company.code.toUpperCase()))
        .filter((company) => {
          const haystack =
            `${company.name}${company.stockCode}${company.code}`.toLowerCase();
          return haystack.replace(/\s+/g, "").includes(normalizedTerm);
        })
        .sort((left, right) => {
          const leftExact =
            left.stockCode === term ||
            left.name.replace(/\s+/g, "").toLowerCase() === normalizedTerm;
          const rightExact =
            right.stockCode === term ||
            right.name.replace(/\s+/g, "").toLowerCase() === normalizedTerm;
          return Number(rightExact) - Number(leftExact);
        })
        .slice(0, 8);
      if (requestId !== state.companySearchRequestId) return;
      renderGlobalCompanyResults(companies);
      elements.globalCompanyStatus.textContent = companies.length
        ? `离线版找到 ${companies.length} 家已缓存公司`
        : "当前离线单文件版没有这家公司的详细资料";
      return;
    }
    try {
      const response = await fetch(
        `/api/company-search?q=${encodeURIComponent(term)}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (requestId !== state.companySearchRequestId) return;
      const companies = Array.isArray(payload.companies)
        ? payload.companies
        : [];
      renderGlobalCompanyResults(companies);
      elements.globalCompanyStatus.textContent = companies.length
        ? `找到 ${companies.length} 家公司，选择后自动定位行业`
        : "没有找到匹配公司，请尝试股票代码";
    } catch {
      if (requestId !== state.companySearchRequestId) return;
      clearGlobalCompanyResults();
      elements.globalCompanyStatus.textContent = "公司搜索暂时不可用";
    }
  }

  function companyTradingCatalysts(securityCode) {
    const eventPayload = state.eventThemePayload || standalone?.eventThemes;
    const themes = Array.isArray(eventPayload?.themes)
      ? eventPayload.themes
      : [];
    const normalizedCode = String(securityCode || "").toUpperCase();
    return themes
      .map((theme) => {
        const stock = (theme.stocks || []).find(
          (item) => String(item.code || "").toUpperCase() === normalizedCode,
        );
        return stock ? { theme, stock } : null;
      })
      .filter(Boolean);
  }

  function renderCompanyInfo(payload, company) {
    const fragment = document.createDocumentFragment();
    const market = payload.market;
    const financials = payload.financials;
    const industry = state.selectedSubIndustry;
    const overview = document.createElement("div");
    overview.className = "investment-overview";

    const shortTermMetrics = market
      ? [
          {
            label: "5日收益",
            value: formatSignedNumber(market.return5d, 2),
            note: `最新价 ${companyMetric(market.close, 2)}`,
            tone: metricTone(market.return5d),
          },
          {
            label: "20日收益",
            value: formatSignedNumber(market.return20d, 2),
            note: "近20个交易日",
            tone: metricTone(market.return20d),
          },
          {
            label: "20日均线偏离",
            value: formatSignedNumber(market.ma20Distance, 2),
            note: market.ma20Distance >= 0 ? "位于均线上方" : "位于均线下方",
            tone: metricTone(market.ma20Distance),
          },
          {
            label: "20日量比",
            value: companyMetric(market.volumeRatio20, 2),
            note: market.volumeRatio20 >= 1 ? "成交活跃" : "成交低于均量",
          },
        ]
      : [
          {
            label: "短线行情",
            value: "—",
            note: "数据暂时不可用",
          },
        ];
    overview.append(
      createInvestmentSection(
        "短线交易",
        "价格位置与成交活跃度",
        shortTermMetrics,
        market ? `行情截至 ${formatDate(market.asOf)}` : "",
      ),
    );

    const asOf = market?.asOf || payload.sourceDate;
    const industryReturns = industry
      ? {
          "5": companyPeriodReturn(industry.points, 5, asOf),
          "20": companyPeriodReturn(industry.points, 20, asOf),
          "60": companyPeriodReturn(industry.points, 60, asOf),
        }
      : {};
    const relativeMetric = (days, companyReturn) => {
      const sectorReturn = industryReturns[String(days)];
      if (!Number.isFinite(companyReturn) || !Number.isFinite(sectorReturn)) {
        return {
          label: `相对行业${days}日`,
          value: "—",
          note: "行业数据不足",
        };
      }
      const relative = companyReturn - sectorReturn;
      return {
        label: `相对行业${days}日`,
        value: `${relative > 0 ? "+" : ""}${relative.toFixed(2)}pp`,
        note: `${industry.name}同期 ${formatSignedNumber(sectorReturn, 2)}`,
        tone: metricTone(relative),
      };
    };
    const rotationMetrics = market
      ? [
          relativeMetric(5, market.return5d),
          relativeMetric(20, market.return20d),
          relativeMetric(60, market.return60d),
          {
            label: "行业20日表现",
            value: formatSignedNumber(industryReturns["20"], 2),
            note: industry ? industry.name : "未选择二级行业",
            tone: metricTone(industryReturns["20"]),
          },
        ]
      : [
          {
            label: "行业相对表现",
            value: "—",
            note: "行情数据暂时不可用",
          },
        ];
    overview.append(
      createInvestmentSection(
        "行业轮动",
        industry ? `相对 ${industry.name} 的强弱` : "选择二级行业后计算相对强弱",
        rotationMetrics,
        "相对表现以同一交易日区间计算，单位 pp。",
      ),
    );

    const checksByKey = new Map(
      (financials?.checks || []).map((item) => [item.key, item]),
    );
    const fundamentalNote = (key, fallback = "") => {
      const check = checksByKey.get(key);
      if (!check) return fallback;
      const rank = check.rank
        ? `行业排名 ${check.rank.rank}/${check.rank.total}`
        : "";
      const verified = check.status === "verified" ? "双源一致" : "数据待核";
      return [rank, verified, fallback].filter(Boolean).join(" · ");
    };
    const fundamentalMetrics = financials
      ? [
          {
            label: "营收同比",
            value: formatSignedNumber(financials.revenueGrowth, 2),
            note: fundamentalNote("revenueGrowth", "报告期累计"),
            tone: metricTone(financials.revenueGrowth),
          },
          {
            label: "归母净利同比",
            value: formatSignedNumber(financials.profitGrowth, 2),
            note: fundamentalNote("profitGrowth", "报告期累计"),
            tone: metricTone(financials.profitGrowth),
          },
          {
            label: "ROE",
            value: formatRate(financials.roe, 2),
            note: fundamentalNote("roe", "年初至今"),
            tone: metricTone(financials.roe),
          },
          {
            label: "毛利率",
            value: formatRate(financials.grossMargin, 2),
            note: fundamentalNote("grossMargin"),
            tone: metricTone(financials.grossMargin),
          },
          {
            label: "资产负债率",
            value: formatRate(financials.debtRatio, 2),
            note: fundamentalNote("debtRatio"),
          },
          {
            label: "净利现金含量",
            value: formatRate(financials.cashToProfit, 2, true),
            note: fundamentalNote("cashToProfit"),
            tone: metricTone(financials.cashToProfit),
          },
        ]
      : [
          {
            label: "基本面指标",
            value: "—",
            note: "财务数据暂时不可用",
          },
        ];
    const scoreText = financials?.scores
      ? [
          ["盈利", financials.scores.profit],
          ["成长", financials.scores.grow],
          ["偿债", financials.scores.pay],
          ["运营", financials.scores.operate],
          ["现金流", financials.scores.cash],
        ]
          .filter(([, score]) => Number.isFinite(score))
          .map(([label, score]) => `${label} ${score}/5`)
          .join(" · ")
      : "";
    overview.append(
      createInvestmentSection(
        "基本面筛选",
        financials
          ? `${financials.reportName || "最新报告期"} · 财务能力 ${
              scoreText || "待补充"
            }`
          : "最新报告期",
        fundamentalMetrics,
        financials
          ? `财务截至 ${formatDate(financials.reportDate)}；数据经东方财富与同花顺交叉核验。`
          : "",
      ),
    );
    fragment.append(overview);

    if (payload.bankValuation?.scenarios?.length) {
      const valuation = payload.bankValuation;
      const valuationSection = document.createElement("section");
      valuationSection.className = "company-valuation";
      valuationSection.innerHTML = `
        <div class="company-valuation-heading">
          <div>
            <p class="panel-kicker">SCENARIO VALUATION</p>
            <h5>三情景估值 · 银行 PB-ROE</h5>
          </div>
          <span>估值日 ${formatDate(valuation.valuationDate)}</span>
        </div>
        <div class="valuation-basis-grid">
          <span><small>当前价</small><b>${companyMetric(valuation.currentPrice)}</b></span>
          <span><small>当前PB</small><b>${companyMetric(valuation.currentPb)}x</b></span>
          <span><small>归一ROE</small><b>${formatRate(valuation.normalizedRoe, 2)}</b></span>
          <span><small>分红率</small><b>${formatRate(valuation.payoutRatio, 2)}${valuation.payoutEstimated ? " *" : ""}</b></span>
          <span><small>当前股息率</small><b>${formatRate(valuation.currentDividendYield, 2)}</b></span>
        </div>
        <div class="valuation-scenarios">
          ${valuation.scenarios
            .map(
              (scenario) => `
                <article class="valuation-scenario is-${scenario.key}">
                  <div class="valuation-scenario-label">${escapeHTML(scenario.label)}</div>
                  <strong>${companyMetric(scenario.targetPrice)}</strong>
                  <span class="${metricTone(scenario.upside)}">${formatSignedNumber(scenario.upside, 2)} 相对现价</span>
                  <dl>
                    <div><dt>目标PB</dt><dd>${companyMetric(scenario.targetPb)}x</dd></div>
                    <div><dt>ROE</dt><dd>${formatRate(scenario.roe, 2)}</dd></div>
                    <div><dt>净资产增速</dt><dd>${formatRate(scenario.growth, 2)}</dd></div>
                    <div><dt>隐含股息率</dt><dd>${formatRate(scenario.dividendYield, 2)}</dd></div>
                  </dl>
                </article>
              `,
            )
            .join("")}
        </div>
        <p class="company-valuation-note">
          ${escapeHTML(valuation.assumption)}
          目标PB参考公司近三年分位和 ${valuation.industryPeerCount} 家上市银行的行业PB分位。
          ${valuation.payoutEstimated ? "分红率缺失时暂按 30% 估算，已用 * 标记。" : ""}
          该结果为估值参考，不构成目标价承诺。
        </p>
      `;
      fragment.append(valuationSection);
    } else if (payload.scenarioValuation?.scenarios?.length) {
      const valuation = payload.scenarioValuation;
      const multipleLabel = valuation.method === "PE" ? "PE" : "PB";
      const perShareLabel =
        valuation.method === "PE" ? "未来EPS" : "未来BPS";
      const valuationSection = document.createElement("section");
      valuationSection.className = "company-valuation";
      valuationSection.innerHTML = `
        <div class="company-valuation-heading">
          <div>
            <p class="panel-kicker">SCENARIO VALUATION</p>
            <h5>三情景估值 · ${escapeHTML(valuation.methodLabel)}</h5>
          </div>
          <span>估值日 ${formatDate(valuation.valuationDate)}</span>
        </div>
        <div class="valuation-basis-grid">
          <span><small>当前价</small><b>${companyMetric(valuation.currentPrice)}</b></span>
          <span><small>当前${multipleLabel}</small><b>${companyMetric(valuation.currentMultiple)}x</b></span>
          <span><small>基准增速</small><b>${formatRate(valuation.baseGrowth, 2)}</b></span>
          <span><small>行业基准${multipleLabel}</small><b>${companyMetric(valuation.industryPercentiles.base)}x</b></span>
          <span><small>行业样本</small><b>${valuation.industryPeerCount} 家</b></span>
        </div>
        <div class="valuation-scenarios">
          ${valuation.scenarios
            .map(
              (scenario) => `
                <article class="valuation-scenario is-${scenario.key}">
                  <div class="valuation-scenario-label">${escapeHTML(scenario.label)}</div>
                  <strong>${companyMetric(scenario.targetPrice)}</strong>
                  <span class="${metricTone(scenario.upside)}">${formatSignedNumber(scenario.upside, 2)} 相对现价</span>
                  <dl>
                    <div><dt>目标${multipleLabel}</dt><dd>${companyMetric(scenario.multiple)}x</dd></div>
                    <div><dt>盈利增速</dt><dd>${formatRate(scenario.growth, 2)}</dd></div>
                    <div><dt>${perShareLabel}</dt><dd>${companyMetric(scenario.perShare, 4)}</dd></div>
                    <div><dt>自身估值分位</dt><dd>${companyMetric(valuation.ownPercentiles[scenario.key])}x</dd></div>
                  </dl>
                </article>
              `,
            )
            .join("")}
        </div>
        <p class="company-valuation-note">
          ${escapeHTML(valuation.assumption)}
          当前采用 ${multipleLabel} 模型，行业样本 ${valuation.industryPeerCount} 家。
          该结果为估值参考，不构成目标价承诺。
        </p>
      `;
      fragment.append(valuationSection);
    }

    const industryPath = resolveCompanyIndustry(payload);
    const industrySwitch = document.createElement("div");
    industrySwitch.className = "company-industry-switch";
    industrySwitch.innerHTML = `
      <span class="company-industry-label">所属行业</span>
      <span class="company-industry-chain"></span>
    `;
    const chain = industrySwitch.querySelector(".company-industry-chain");
    const appendIndustryNode = (label, name, level, enabled) => {
      if (!name) return;
      if (chain.childElementCount) {
        const arrow = document.createElement("span");
        arrow.className = "company-industry-arrow";
        arrow.textContent = "›";
        chain.append(arrow);
      }
      const node = document.createElement(enabled ? "button" : "span");
      node.className = "company-industry-node";
      if (enabled) {
        node.type = "button";
        node.setAttribute(
          "aria-label",
          `切换到${label}${name}并查看走势`,
        );
        node.addEventListener("click", () =>
          focusCompanyIndustry(payload, level),
        );
      }
      node.innerHTML = `
        <small>${escapeHTML(label)}</small>
        <strong>${escapeHTML(name)}</strong>
      `;
      chain.append(node);
    };
    appendIndustryNode(
      "一级",
      industryPath.level1Name,
      1,
      Boolean(industryPath.primary),
    );
    appendIndustryNode(
      "二级",
      industryPath.level2Name,
      2,
      Boolean(industryPath.primary && industryPath.secondary),
    );
    appendIndustryNode("三级", industryPath.level3Name, 3, false);
    fragment.append(industrySwitch);

    const catalysts = companyTradingCatalysts(payload.code || company.code);
    if (catalysts.length) {
      const catalystSection = document.createElement("section");
      catalystSection.className = "company-catalyst";
      const primary = catalysts[0];
      const reasonParts = String(primary.stock.reasonText || "")
        .split("+")
        .map((item) => item.trim())
        .filter(Boolean);
      const eventDate =
        primary.stock.lastLimitTime || primary.stock.firstLimitTime
          ? new Date(
              (primary.stock.lastLimitTime || primary.stock.firstLimitTime) *
                1000,
            )
          : null;
      catalystSection.innerHTML = `
        <div class="company-catalyst-heading">
          <div>
            <p class="panel-kicker">TRADING CATALYST</p>
            <h5>最近涨停催化</h5>
          </div>
          <span>${eventDate ? `涨停 ${formatFlowTime(eventDate.toISOString())}` : "最近交易日"}</span>
        </div>
        <div class="company-catalyst-summary">
          <span>
            <small>所属申万行业</small>
            <strong>${escapeHTML(industryPath.level2Name || industryPath.level1Name || payload.industry || "—")}</strong>
          </span>
          <span>
            <small>当日涨停原因</small>
            <div class="company-catalyst-tags">
              ${reasonParts
                .map(
                  (reason) =>
                    `<b>${escapeHTML(reason)}</b>`,
                )
                .join("")}
            </div>
          </span>
          <span>
            <small>涨停状态</small>
            <strong>${escapeHTML(primary.stock.boardLabel || "涨停")} · ${escapeHTML(primary.stock.limitUpType || "涨停")}</strong>
          </span>
        </div>
        <p>
          涨停原因来自最近交易日涨停池，是价格异动的交易催化；“所属行业”和“核心业务相关度”仍用于基本面分类，两者不能混用。
        </p>
      `;
      fragment.append(catalystSection);
    }

    if (payload.concepts?.length) {
      const conceptSection = document.createElement("section");
      conceptSection.className = "company-concepts";
      conceptSection.innerHTML = `
        <div class="company-concepts-heading">
          <h5>概念关联</h5>
          <span>${payload.concepts.length} 个题材标签 · 按业务相关性分档</span>
        </div>
        <p class="company-concepts-note">
          规则初筛：主营产品优先，其次为应用与产业链延伸；分类不代表收入占比。
        </p>
        <div class="company-concept-groups"></div>
        <div class="company-concept-reason" aria-live="polite">
          选择一个概念查看入选依据与关联判断。
        </div>
      `;
      const groupsRoot = conceptSection.querySelector(".company-concept-groups");
      const reason = conceptSection.querySelector(".company-concept-reason");
      const conceptGroups = [
        {
          key: "core",
          label: "核心业务相关",
          description: "主营产品或所属核心行业",
        },
        {
          key: "extension",
          label: "业务延伸",
          description: "下游应用、客户或产业链",
        },
        {
          key: "weak",
          label: "弱题材关联",
          description: "股东、地域、历史投资或预期",
        },
      ];
      payload.concepts.forEach((concept) => {
        if (!conceptGroups.some((group) => group.key === concept.relevance)) {
          concept.relevance = "weak";
          concept.relevanceLabel = "弱题材关联";
          concept.relevanceBasis = "暂无足够证据判断，按弱题材关联处理";
        }
      });
      conceptGroups.forEach((group) => {
        const groupConcepts = payload.concepts.filter(
          (concept) => concept.relevance === group.key,
        );
        if (!groupConcepts.length) return;
        const groupElement = document.createElement("section");
        groupElement.className = `company-concept-group is-${group.key}`;
        groupElement.innerHTML = `
          <div class="company-concept-group-heading">
            <span class="company-concept-tier-dot"></span>
            <h6>${escapeHTML(group.label)}</h6>
            <span>${groupConcepts.length}</span>
            <small>${escapeHTML(group.description)}</small>
          </div>
          <div class="company-concept-tags"></div>
        `;
        const tags = groupElement.querySelector(".company-concept-tags");
        groupConcepts.forEach((concept) => {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = `company-concept-tag is-${group.key}`;
          chip.textContent = concept.name;
          chip.addEventListener("click", () => {
            groupsRoot
              .querySelectorAll(".company-concept-tag")
              .forEach((item) =>
                item.classList.toggle("is-active", item === chip),
              );
            const head = document.createElement("div");
            head.className = "company-concept-reason-head";
            const tier = document.createElement("span");
            tier.className = `company-concept-tier-label is-${group.key}`;
            tier.textContent = concept.relevanceLabel || group.label;
            head.append(tier);
            if (concept.evidenceDate) {
              const date = document.createElement("span");
              date.textContent = `依据 ${concept.evidenceDate}`;
              head.append(date);
            }
            if (concept.stale) {
              const stale = document.createElement("span");
              stale.className = "company-concept-stale";
              stale.textContent = "原依据较早";
              head.append(stale);
            }
            const detail = document.createElement("p");
            detail.textContent =
              concept.reason || `${concept.name}暂无详细入选原因。`;
            const basis = document.createElement("small");
            basis.textContent =
              `分类依据：${concept.relevanceBasis || "业务相关性规则初筛"}。` +
              "来源：东方财富公司题材及公告说明。";
            reason.replaceChildren(head, detail, basis);
          });
          tags.append(chip);
        });
        groupsRoot.append(groupElement);
      });
      fragment.append(conceptSection);
    }

    const profileDetails = document.createElement("details");
    profileDetails.className = "company-profile-details";
    const profileSummary = document.createElement("summary");
    profileSummary.textContent = "工商信息与公司简介";
    profileDetails.append(profileSummary);
    const facts = document.createElement("dl");
    facts.className = "company-fact-grid";
    const number = new Intl.NumberFormat("zh-CN");
    const factRows = [
      ["公司全称", payload.fullName],
      ["所属行业", payload.industry],
      ["证监会行业", payload.csrcIndustry],
      ["上市日期", payload.listingDate ? formatDate(payload.listingDate) : null],
      ["成立日期", payload.foundedDate ? formatDate(payload.foundedDate) : null],
      ["实际控制人", payload.actualController],
      ["董事长", payload.chairman],
      ["总经理", payload.president],
      ["法定代表人", payload.legalPerson],
      ["董事会秘书", payload.secretary],
      [
        "注册资本（万元）",
        Number.isFinite(payload.registeredCapital)
          ? number.format(payload.registeredCapital)
          : payload.registeredCapital,
      ],
      [
        "员工人数",
        Number.isFinite(payload.employees)
          ? number.format(payload.employees)
          : payload.employees,
      ],
      ["公司电话", payload.phone],
      ["公司邮箱", payload.email],
      ["公司网站", payload.website],
      ["注册地址", payload.registeredAddress],
      ["办公地址", payload.officeAddress],
    ];
    factRows.forEach(([label, value]) =>
      appendCompanyFact(facts, label, value, {
        link: label === "公司网站",
      }),
    );
    const copy = document.createElement("div");
    copy.className = "company-copy";
    appendCompanyCopy(copy, "公司简介", payload.profile);
    appendCompanyCopy(copy, "主营业务与经营范围", [
      payload.mainBusiness,
      payload.businessScope,
    ].filter(Boolean).join("\n\n"));
    profileDetails.append(facts, copy);
    fragment.append(profileDetails);

    const allChecks = [
      ...(payload.market?.checks || []),
      ...(financials?.checks || []),
    ];
    if (allChecks.length) {
      const audit = document.createElement("details");
      audit.className = "company-audit";
      const summary = document.createElement("summary");
      summary.textContent = "查看行情与财务数据交叉核验";
      const list = document.createElement("ul");
      allChecks.forEach((check) => {
        const item = document.createElement("li");
        const status =
          check.status === "verified"
            ? "一致"
            : check.status === "warning"
              ? "存在差异"
              : "未通过";
        item.textContent =
          `${check.label}：${companyMetric(check.primary, 2)} / ` +
          `${companyMetric(check.secondary, 2)}，${status}`;
        list.append(item);
      });
      audit.append(summary, list);
      fragment.append(audit);
    }
    elements.companyDetailBody.replaceChildren(fragment);
  }

  async function loadCompanyInfo(company, preparedPayload = null) {
    state.companyInfoRequestId += 1;
    const requestId = state.companyInfoRequestId;
    state.selectedCompanyCode = company.code;
    elements.companyTableBody.querySelectorAll("tr").forEach((row) => {
      row.classList.toggle("is-selected", row.dataset.companyCode === company.code);
    });
    elements.companyDetail.hidden = false;
    elements.companyDetailName.textContent = company.name;
    elements.companyDetailCode.textContent = company.code;
    elements.companyDetailBody.innerHTML =
      '<p class="company-detail-loading">正在载入公司资料…</p>';
    try {
      const payload =
        preparedPayload || (await ensureCompanyInfo(company.code, true));
      if (!state.eventThemePayload) {
        await loadEventThemes();
      }
      if (
        requestId !== state.companyInfoRequestId ||
        state.selectedCompanyCode !== company.code
      ) {
        return;
      }
      elements.companyDetailName.textContent =
        payload.name || company.name;
      elements.companyDetailCode.textContent =
        `${payload.code || company.code} · 行情与财务多源核验`;
      renderCompanyInfo(payload, company);
    } catch {
      if (requestId !== state.companyInfoRequestId) return;
      elements.companyDetailBody.innerHTML =
        '<p class="company-detail-loading">公司资料暂时无法载入，请稍后重试。</p>';
    }
  }

  function hideRotationStockDrawer() {
    elements.rotationStockDrawer.hidden = true;
    elements.rotationStockList.replaceChildren();
    elements.rotationStockFull.hidden = true;
    state.rotationStockCompanies.clear();
    state.rotationStockIndustry = null;
  }

  function showRotationStockDrawerLoading(industry) {
    state.rotationStockIndustry = industry;
    state.rotationStockCompanies.clear();
    elements.rotationStockDrawer.hidden = false;
    elements.rotationStockHeading.textContent = `${industry.name} · 成分公司`;
    elements.rotationStockSource.textContent = industry.code;
    elements.rotationStockList.innerHTML =
      '<p class="rotation-stock-loading">正在载入成分公司…</p>';
    elements.rotationStockFull.hidden = true;
    requestAnimationFrame(() => {
      elements.rotationStockDrawer.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "nearest",
      });
    });
  }

  function renderRotationStockDrawer(payload, industry) {
    if (state.rotationStockIndustry?.code !== industry.code) return;
    const companies = (Array.isArray(payload.companies) ? payload.companies : [])
      .slice()
      .sort(
        (left, right) =>
          (Number.isFinite(right.change1d) ? right.change1d : -Infinity) -
          (Number.isFinite(left.change1d) ? left.change1d : -Infinity),
      );
    const upCount = companies.filter((company) => company.change1d > 0).length;
    const downCount = companies.filter((company) => company.change1d < 0).length;
    const flatCount = companies.length - upCount - downCount;
    const averageChange =
      companies.reduce(
        (sum, company) =>
          sum + (Number.isFinite(company.change1d) ? company.change1d : 0),
        0,
      ) / Math.max(1, companies.length);
    state.rotationStockCompanies = new Map(
      companies.map((company) => [company.code, company]),
    );
    elements.rotationStockDrawer.hidden = false;
    elements.rotationStockHeading.textContent =
      `${payload.industryName || industry.name} · 成分公司`;
    elements.rotationStockSource.textContent =
      `${companies.length}家 · ${upCount}涨/${downCount}跌/${flatCount}平 · ` +
      `均幅 ${formatRate(averageChange, 2, true)} · ` +
      `${payload.sourceDate ? formatDate(payload.sourceDate) : industry.code}`;
    elements.rotationStockFull.hidden = companies.length <= 20;
    elements.rotationStockFull.textContent =
      `查看完整 ${companies.length} 家成分公司`;
    elements.rotationStockList.innerHTML = companies
      .slice(0, 20)
      .map(
        (company) => `
          <button
            type="button"
            class="rotation-stock-item"
            data-rotation-company="${escapeHTML(company.code)}"
          >
            <span>${escapeHTML(company.name)}</span>
            <small>${escapeHTML(company.code)}</small>
            <b class="${metricTone(company.change1d)}">${formatRate(company.change1d, 2, true)}</b>
          </button>
        `,
      )
      .join("");
  }

  function renderRotationStockDrawerError(industry) {
    if (state.rotationStockIndustry?.code !== industry.code) return;
    elements.rotationStockDrawer.hidden = false;
    elements.rotationStockList.innerHTML =
      '<p class="rotation-stock-loading">该行业的成分公司暂时无法载入，请稍后重试。</p>';
    elements.rotationStockFull.hidden = true;
  }

  function hideCompanySection() {
    hideCompanyInfo();
    hideRotationStockDrawer();
    elements.companySection.hidden = true;
    syncCompanyViewHelp();
    elements.companyJump.hidden = true;
    elements.companyJump.disabled = false;
    elements.companyTableBody.replaceChildren();
    state.activeCompanyPayload = null;
    state.companyQuery = "";
  }

  function companyMetric(value, digits = 2) {
    return Number.isFinite(value) ? value.toFixed(digits) : "—";
  }

  function renderCompanyRows() {
    const payload = state.activeCompanyPayload;
    if (!payload) return;
    const query = state.companyQuery.trim().toLowerCase();
    const companies = payload.companies
      .slice()
      .sort(
        (a, b) =>
          (Number.isFinite(b.change1d) ? b.change1d : -Infinity) -
          (Number.isFinite(a.change1d) ? a.change1d : -Infinity),
      )
      .filter(
        (company) =>
          !query ||
          company.name.toLowerCase().includes(query) ||
          company.code.toLowerCase().includes(query),
      );

    const fragment = document.createDocumentFragment();
    companies.forEach((company) => {
      const row = document.createElement("tr");
      row.dataset.companyCode = company.code;
      row.classList.toggle(
        "is-selected",
        company.code === state.selectedCompanyCode,
      );
      const change1d = Number.isFinite(company.change1d)
        ? formatSignedNumber(company.change1d, 2)
        : "—";
      const change5d = Number.isFinite(company.change5d)
        ? formatSignedNumber(company.change5d, 2)
        : "—";
      const change1dClass =
        company.change1d > 0
          ? "up-text"
          : company.change1d < 0
            ? "down-text"
            : "";
      const change5dClass =
        company.change5d > 0
          ? "up-text"
          : company.change5d < 0
            ? "down-text"
            : "";
      row.innerHTML = `
        <td><button type="button" class="company-name" aria-label="查看${escapeHTML(company.name)}基本信息">${escapeHTML(company.name)}</button></td>
        <td><span class="company-code">${escapeHTML(company.code)}</span></td>
        <td class="numeric">${companyMetric(company.close)}</td>
        <td class="numeric ${change1dClass}">${change1d}</td>
        <td class="numeric ${change5dClass}">${change5d}</td>
        <td class="numeric">${companyMetric(company.marketCap, 1)}</td>
        <td class="numeric">${companyMetric(company.peTtm, 1)}</td>
      `;
      row
        .querySelector(".company-name")
        .addEventListener("click", () => loadCompanyInfo(company));
      fragment.append(row);
    });
    if (!companies.length) {
      const row = document.createElement("tr");
      row.innerHTML = `<td class="company-empty" colspan="7">没有匹配的公司</td>`;
      fragment.append(row);
    }
    elements.companyTableBody.replaceChildren(fragment);
    elements.companyCount.textContent =
      query && companies.length !== payload.companies.length
        ? `${companies.length} / ${payload.companies.length} 家`
        : `${payload.companies.length} 家`;
    elements.companyJump.hidden = false;
    elements.companyJump.disabled = false;
    elements.companyJump.textContent =
      `${payload.companies.length} 家成分公司 ↓`;
    elements.companyTableBody.closest(".company-table-wrap").scrollTop = 0;
  }

  async function loadCompaniesForSelected() {
    state.companyRequestId += 1;
    const requestId = state.companyRequestId;
    const industry = state.selectedSubIndustry;
    if (!industry || !state.showAllSubIndustries) {
      hideCompanySection();
      return;
    }

    hideCompanyInfo();
    state.companyQuery = "";
    elements.companySearch.value = "";
    elements.companySearch.disabled = false;
    elements.companySection.hidden = false;
    syncCompanyViewHelp();
    elements.companyJump.hidden = false;
    elements.companyJump.disabled = true;
    elements.companyJump.textContent = "成分公司载入中…";
    elements.companyHeading.textContent = `${industry.name} · 成分公司`;
    elements.companyCount.textContent = "正在载入…";
    elements.companySourceDate.textContent = industry.code;
    elements.companyFootnote.textContent =
      "成分公司来自乐咕乐股，按申万二级行业分类展示。";

    const cached = state.companyGroups.get(industry.code);
    if (cached) {
      state.activeCompanyPayload = cached;
      elements.companyHeading.textContent =
        `${cached.industryName || industry.name} · 成分公司`;
      elements.companySourceDate.textContent = cached.sourceDate
        ? `行情 ${formatDate(cached.sourceDate)}`
        : industry.code;
      elements.companyFootnote.textContent =
        `成分公司来自乐咕乐股，按申万二级行业分类展示；行情日期 ${
          cached.sourceDate ? formatDate(cached.sourceDate) : "未知"
        }。`;
      renderCompanyRows();
      renderRotationStockDrawer(cached, industry);
    }

    if (!cached) {
      elements.companySearch.disabled = true;
      elements.companyTableBody.innerHTML = `
        <tr><td class="company-empty" colspan="7">正在载入 ${escapeHTML(industry.name)} 成分公司…</td></tr>
      `;
    }
    try {
      const payload = await ensureCompanies(industry.code, true);
      if (
        requestId !== state.companyRequestId ||
        state.selectedSubIndustry?.code !== industry.code
      ) {
        return;
      }
      state.activeCompanyPayload = payload;
      elements.companyHeading.textContent =
        `${payload.industryName || industry.name} · 成分公司`;
      elements.companySourceDate.textContent = payload.sourceDate
        ? `行情 ${formatDate(payload.sourceDate)}`
        : industry.code;
      elements.companyFootnote.textContent =
        `成分公司来自乐咕乐股，按申万二级行业分类展示；行情日期 ${
          payload.sourceDate ? formatDate(payload.sourceDate) : "未知"
        }。`;
      elements.companySearch.disabled = false;
      renderCompanyRows();
      renderRotationStockDrawer(payload, industry);
    } catch {
      if (requestId !== state.companyRequestId) return;
      elements.companyCount.textContent = "载入失败";
      elements.companyJump.textContent = "成分公司载入失败";
      elements.companyTableBody.innerHTML = `
        <tr><td class="company-empty" colspan="7">成分公司数据暂时无法载入，请稍后重试。</td></tr>
      `;
      renderRotationStockDrawerError(industry);
    }
  }

  async function selectSubIndustry(code) {
    state.subIndustryRequestId += 1;
    state.companyRequestId += 1;
    const requestId = state.subIndustryRequestId;
    const parentCode = state.selectedCode;
    if (code === ALL_SUB_INDUSTRIES) {
      const children = subIndustriesByParent.get(parentCode) || [];
      const parent = industryByCode.get(parentCode);
      state.selectedSubIndustry = null;
      state.showAllSubIndustries = true;
      hideCompanySection();
      elements.subSelect.value = ALL_SUB_INDUSTRIES;
      elements.chartHeading.textContent =
        `${parent?.name || ""} · ${children.length} 个二级行业 · 正在载入`;
      elements.subSelectNote.textContent =
        `全部 ${children.length} 个二级行业 · 正在载入走势…`;
      elements.selectionNote.textContent = "正在载入二级行业数据…";
      try {
        await ensureSubIndustryGroup(parentCode);
        if (
          state.selectedCode !== parentCode ||
          state.subIndustryRequestId !== requestId
        ) {
          return;
        }
        elements.subSelectNote.textContent =
          `已展示全部 ${children.length} 个二级行业`;
        renderSelection();
      } catch {
        if (
          state.selectedCode !== parentCode ||
          state.subIndustryRequestId !== requestId
        ) {
          return;
        }
        state.showAllSubIndustries = false;
        elements.subSelect.value = "";
        elements.subSelectNote.textContent = "二级行业数据载入失败";
        renderSelection();
      }
      return;
    }
    if (!code) {
      state.selectedSubIndustry = null;
      state.showAllSubIndustries = false;
      hideCompanySection();
      renderSelection();
      return;
    }
    state.showAllSubIndustries = true;
    const child = (subIndustriesByParent.get(parentCode) || []).find(
      (entry) => entry.code === code,
    );
    elements.subSelect.value = code;
    if (child) {
      hideCompanyInfo();
      state.companyQuery = "";
      elements.companySearch.value = "";
      elements.companySearch.disabled = true;
      elements.companySection.hidden = false;
      syncCompanyViewHelp();
      elements.companyJump.hidden = false;
      elements.companyJump.disabled = true;
      elements.companyJump.textContent = "成分公司载入中…";
      elements.companyHeading.textContent = `${child.name} · 成分公司`;
      elements.companyCount.textContent = "正在载入…";
      elements.companySourceDate.textContent = child.code;
      elements.companyTableBody.innerHTML = `
        <tr><td class="company-empty" colspan="7">正在载入 ${escapeHTML(child.name)} 成分公司…</td></tr>
      `;
      showRotationStockDrawerLoading(child);
      elements.chartHeading.textContent =
        `${child.name}（${child.parentName || state.selectedCode}） · 正在载入`;
      elements.subSelectNote.textContent = `${child.name} · 正在载入走势…`;
      elements.selectionNote.textContent = "正在载入二级行业数据…";
    }
    try {
      const group = await ensureSubIndustryGroup(parentCode);
      if (
        state.selectedCode !== parentCode ||
        state.subIndustryRequestId !== requestId
      ) {
        return;
      }
      const item = group.industries.find((entry) => entry.code === code);
      if (!item) throw new Error("二级行业不存在");
      state.selectedSubIndustry = item;
      elements.subSelect.value = code;
      elements.subSelectNote.textContent = `${item.name} · ${item.parentName}`;
      renderSelection();
      await loadCompaniesForSelected();
    } catch {
      if (
        state.selectedCode !== parentCode ||
        state.subIndustryRequestId !== requestId
      ) {
        return;
      }
      state.selectedSubIndustry = null;
      state.showAllSubIndustries = false;
      hideCompanySection();
      elements.subSelect.value = "";
      elements.subSelectNote.textContent = "二级行业数据载入失败";
      renderSelection();
    }
  }

  function renderSelection() {
    const parentItem = state.periodStats.find(
      (entry) => entry.code === state.selectedCode,
    );
    const subIndustryGroup = state.subIndustryGroups.get(state.selectedCode);
    const isOverview = state.showAllSubIndustries;
    const overviewStats =
      isOverview && subIndustryGroup
        ? subIndustryGroup.industries
            .map((entry) => calculatePeriod(entry, state.weeks))
            .sort((a, b) => b.periodReturn - a.periodReturn)
        : [];
    const item = state.selectedSubIndustry
      ? calculatePeriod(state.selectedSubIndustry, state.weeks)
      : parentItem;
    if (!item) return;

    if (isOverview) {
      const subCount =
        overviewStats.length ||
        (subIndustriesByParent.get(state.selectedCode) || []).length;
      elements.chartHeading.textContent =
        state.selectedSubIndustry
          ? `${item.parentName} · 二级对比（突出${item.name}） vs 大盘指数`
          : `${item.name} · ${subCount} 个二级行业 vs 大盘指数`;
      renderDetailLegend(overviewStats.length ? overviewStats : [item], true);
      elements.trendPill.textContent = state.selectedSubIndustry
        ? item.trend
        : "二级全景";
      elements.trendPill.dataset.trend = elements.trendPill.textContent;
      elements.industryCode.textContent = state.selectedSubIndustry
        ? item.code
        : `${item.code} · ${subCount}条`;
    } else {
      elements.chartHeading.textContent =
        `${item.name}${item.parentName ? `（${item.parentName}）` : ""} vs 大盘指数`;
      renderDetailLegend([item]);
      elements.trendPill.textContent = item.trend;
      elements.trendPill.dataset.trend = item.trend;
      elements.industryCode.textContent = item.code;
    }
    elements.selectionNote.textContent = isOverview
      ? state.selectedSubIndustry
        ? `${formatDate(item.visible[0].date)} 起，突出${item.name}，其余二级行业变虚`
        : `${formatDate(item.visible[0].date)} 起，起点归一为 0% · 指标为一级行业整体`
      : `${formatDate(item.visible[0].date)} 起，起点归一为 0%`;
    elements.select.value = state.selectedCode;
    elements.statReturn.textContent = formatPercent(item.periodReturn);
    elements.statExcess.textContent = formatPoints(item.excessReturn);
    elements.statDrawdown.textContent = formatPercent(item.drawdown);
    elements.statVolatility.textContent = formatPercent(item.volatility);
    setValueTone(elements.statReturn, item.periodReturn);
    setValueTone(elements.statExcess, item.excessReturn);
    setValueTone(elements.statDrawdown, item.drawdown);
    drawChart();
    hideChartPointer();
  }

  function renderAll() {
    state.periodStats = industries
      .map((item) => calculatePeriod(item, state.weeks))
      .sort((a, b) => b.periodReturn - a.periodReturn);
    if (!industryByCode.has(state.selectedCode)) {
      state.selectedCode = state.periodStats[0].code;
    }
    renderSummary(state.periodStats);
    renderAllIndustriesLegend(state.periodStats);
    drawAllIndustriesChart(state.periodStats);
    renderRanking(state.periodStats);
    renderHeatmap(state.periodStats);
    renderSelection();
  }

  function selectIndustry(code) {
    if (!industryByCode.has(code)) return;
    state.subIndustryRequestId += 1;
    state.companyRequestId += 1;
    state.selectedCode = code;
    state.selectedSubIndustry = null;
    hideCompanySection();
    elements.select.value = code;
    elements.subSelect.value = "";
    updateSubIndustryOptions(code);
    renderAll();
  }

  function setRange(weeks) {
    state.weeks = weeks;
    elements.rangeControl.querySelectorAll("button").forEach((button) => {
      const active = Number(button.dataset.range) === weeks;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    renderAll();
  }

  function setFrequency(frequency) {
    if (!["day", "week", "month"].includes(frequency)) return;
    state.frequency = frequency;
    elements.frequencyControl.querySelectorAll("button").forEach((button) => {
      const active = button.dataset.frequency === frequency;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const label = {
      day: "日线",
      week: "周线",
      month: "月线",
    }[frequency];
    elements.frequencyBadge.textContent = label;
    elements.boardIntro.textContent =
      `31 条行业${label}走势与上证指数、沪深300、中证1000、中证2000` +
      "叠加在同一时间轴和收益尺度上；移动到曲线可单独高亮，点击图例可切换下方走势详情。";
    renderAll();
  }

  function setHeatmapMode(mode) {
    if (!["week", "day"].includes(mode)) return;
    state.heatmapMode = mode;
    elements.heatmapModeControl.querySelectorAll("button").forEach((button) => {
      const active = button.dataset.heatmapMode === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    renderHeatmap(state.periodStats);
  }

  async function setIndustryHeatmapLevel(level) {
    if (!["primary", "secondary"].includes(level)) return;
    state.industryHeatmapLevel = level;
    elements.heatmapLevelControl
      .querySelectorAll("button[data-heatmap-level]")
      .forEach((button) => {
        const active = button.dataset.heatmapLevel === level;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", String(active));
      });
    if (level === "primary") {
      renderHeatmap(state.periodStats);
      return;
    }
    renderHeatmap(state.periodStats);
    try {
      await ensureAllSecondaryIndustries();
      if (state.industryHeatmapLevel === "secondary") {
        renderHeatmap(state.periodStats);
      }
    } catch {
      if (state.industryHeatmapLevel !== "secondary") return;
      elements.heatmap.replaceChildren();
      elements.heatmapIntro.textContent =
        "申万二级行业数据暂时无法载入，请切换回一级行业或稍后重试。";
    }
  }

  function setActiveView(view, options = {}) {
    if (!["industry", "bias", "company", "flow", "concept"].includes(view)) return;
    state.activeView = view;
    document.body.dataset.activeView = view;
    elements.viewTabs.querySelectorAll("button[data-view-tab]").forEach((button) => {
      const active = button.dataset.viewTab === view;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    elements.industryView.hidden = view !== "industry";
    elements.biasView.hidden = view !== "bias";
    elements.flowView.hidden = view !== "flow";
    elements.conceptView.hidden = view !== "concept";
    elements.companyView.hidden = view !== "company";
    elements.frequencyBadge.textContent = frequencyLabel(
      view === "bias" ? state.biasFrequency : state.frequency,
    );
    try {
      localStorage.setItem("sw-active-view", view);
    } catch {
      // Local storage may be unavailable in locked-down browser contexts.
    }
    if (view === "industry") {
      requestAnimationFrame(() => {
        drawAllIndustriesChart(state.periodStats);
        drawChart();
      });
    }
    if (view === "bias") {
      requestAnimationFrame(renderBiasView);
    }
    if (view === "flow") {
      requestAnimationFrame(() => {
        loadMarketPulse();
        if (state.level2FlowIndustryCode) loadLevel2Flow();
      });
    }
    if (view === "concept") {
      requestAnimationFrame(() => {
        loadConceptHeat();
        loadConceptIntradayFlow();
        loadEventThemes();
        loadConceptRotation();
      });
    }
    if (options.scroll) {
      requestAnimationFrame(() => {
        elements.viewTabs.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
          block: "start",
        });
      });
    }
  }

  function syncCompanyViewHelp() {
    elements.companyViewHelp.hidden = !elements.companySection.hidden;
  }

  function setupViewTabs() {
    elements.flowViewMain.append(elements.flowPanel);
    elements.conceptViewMain.append(
      elements.conceptHeatPanel,
      elements.conceptIntradayFlowPanel,
      elements.eventThemePanel,
      elements.conceptRotationPanel,
      elements.conceptScreenerPanel,
    );
    elements.companyViewTop.append(elements.companyLocator);
    elements.companyViewMain.append(elements.companySection);
    syncCompanyViewHelp();
    elements.viewTabs.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-view-tab]");
      if (button) setActiveView(button.dataset.viewTab, { scroll: true });
    });
    let initialView = "industry";
    try {
      const savedView = localStorage.getItem("sw-active-view");
      if (["industry", "bias", "company", "flow", "concept"].includes(savedView)) {
        initialView = savedView;
      }
    } catch {
      // Keep the industry view as the default.
    }
    setActiveView(initialView);
  }

  function setupControls() {
    industries
      .slice()
      .sort((a, b) => a.code.localeCompare(b.code))
      .forEach((item) => {
        const option = document.createElement("option");
        option.value = item.code;
        option.textContent = item.name;
        elements.select.append(option);
      });
    elements.select.addEventListener("change", (event) => selectIndustry(event.target.value));
    elements.subSelect.addEventListener("change", (event) => {
      selectSubIndustry(event.target.value);
    });
    elements.globalCompanySearch.addEventListener("input", (event) => {
      window.clearTimeout(state.companySearchTimer);
      state.companySearchTimer = window.setTimeout(
        () => searchGlobalCompanies(event.target.value),
        220,
      );
    });
    elements.globalCompanySearch.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && state.companySearchResults.length) {
        event.preventDefault();
        openCompanyFromSearch(state.companySearchResults[0]);
      } else if (event.key === "Escape") {
        clearGlobalCompanyResults();
      }
    });
    elements.companySearch.addEventListener("input", (event) => {
      state.companyQuery = event.target.value;
      renderCompanyRows();
    });
    elements.companyJump.addEventListener("click", () => {
      setActiveView("company", { scroll: true });
      requestAnimationFrame(() => {
        elements.companySection.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
          block: "start",
        });
      });
    });
    elements.rotationStockClose.addEventListener("click", () =>
      hideRotationStockDrawer(),
    );
    elements.rotationStockFull.addEventListener("click", () => {
      elements.companySection.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "start",
      });
    });
    elements.rotationStockList.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-rotation-company]");
      if (!button) return;
      const company = state.rotationStockCompanies.get(
        button.dataset.rotationCompany,
      );
      if (company) void openCompanyFromSearch(company);
    });
    elements.companyDetailClose.addEventListener("click", hideCompanyInfo);
    elements.rangeControl.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-range]");
      if (button) setRange(Number(button.dataset.range));
    });
    elements.frequencyControl.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-frequency]");
      if (button) setFrequency(button.dataset.frequency);
    });
    elements.heatmapModeControl.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-heatmap-mode]");
      if (button) setHeatmapMode(button.dataset.heatmapMode);
    });
    elements.heatmapLevelControl.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-heatmap-level]");
      if (button) void setIndustryHeatmapLevel(button.dataset.heatmapLevel);
    });
    elements.biasFrequencyControl.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-bias-frequency]");
      if (button) setBiasFrequency(button.dataset.biasFrequency);
    });
    elements.biasMaControl.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-bias-ma]");
      if (button) setBiasMaPeriod(Number(button.dataset.biasMa));
    });
  }

  function setupTheme() {
    const syncThemeLabel = () => {
      elements.themeLabel.textContent =
        document.documentElement.dataset.theme === "dark" ? "浅色" : "深色";
    };
    syncThemeLabel();
    elements.themeToggle.addEventListener("click", () => {
      const next =
        document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("sw-trend-theme", next);
      syncThemeLabel();
      requestAnimationFrame(() => {
        renderAllIndustriesLegend(state.periodStats);
        drawAllIndustriesChart(state.periodStats);
        renderSelection();
        if (state.activeView === "bias") renderBiasView();
      });
    });
  }

  function setupChartInteractions() {
    elements.chart.addEventListener("pointermove", handleChartPointer);
    elements.chart.addEventListener("pointerdown", handleChartPointer);
    elements.chart.addEventListener("pointerleave", hideChartPointer);
    elements.chart.addEventListener("pointerup", (event) => {
      if (event.pointerType === "mouse") hideChartPointer();
    });
    elements.allChart.addEventListener("pointermove", handleAllChartPointer);
    elements.allChart.addEventListener("pointerdown", handleAllChartPointer);
    elements.allChart.addEventListener("pointerleave", hideAllChartPointer);
    elements.allChart.addEventListener("click", () => {
      if (state.highlightedCode) selectIndustry(state.highlightedCode);
    });
    elements.biasChart.addEventListener("pointermove", handleBiasChartPointer);
    elements.biasChart.addEventListener("pointerdown", handleBiasChartPointer);
    elements.biasChart.addEventListener("pointerleave", hideBiasChartPointer);
    if ("ResizeObserver" in window) {
      const observer = new ResizeObserver(() =>
        requestAnimationFrame(() => {
          drawAllIndustriesChart(state.periodStats);
          drawChart();
          if (state.activeView === "bias") renderBiasView();
        }),
      );
      observer.observe(elements.chartWrap);
      observer.observe(elements.allChartWrap);
      observer.observe(elements.biasChartWrap);
    } else {
      window.addEventListener("resize", () =>
        requestAnimationFrame(() => {
          drawAllIndustriesChart(state.periodStats);
          drawChart();
          if (state.activeView === "bias") renderBiasView();
        }),
      );
    }
  }

  elements.sourceDate.textContent = `截至 ${formatDate(data.sourceDate)}`;
  elements.dataSource.textContent =
    `申万宏源研究所申万一级及二级行业指数；` +
    `${benchmarks.map((item) => item.name).join("、")}来自东方财富`;
  elements.updatedAt.textContent = `更新 ${new Date(data.updatedAt).toLocaleString("zh-CN", {
    hour12: false,
  })}`;
  state.selectedCode = industries[0].code;
  state.biasSelectedCode = state.selectedCode;
  renderBiasMaOptions();
  setupViewTabs();
  setupControls();
  setupMarketPulse();
  setupIndustryFlow();
  setupLevel2Flow();
  setupConceptHeat();
  setupConceptIntradayFlow();
  setupEventThemes();
  setupConceptRotation();
  setupConceptSearch();
  setupTheme();
  setupChartInteractions();
  updateSubIndustryOptions(state.selectedCode);
  renderAll();
  void loadIndustryFundHistory()
    .then(() => renderHeatmap(state.periodStats))
    .catch(() => {
      elements.heatmapIntro.textContent += " 资金历史暂时不可用，当前显示价格评分。";
    });
})();
