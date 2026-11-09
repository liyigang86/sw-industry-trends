(() => {
  const statusElement = document.getElementById("refresh-status");
  const initialData = window.SW_TREND_DATA;

  function formatDate(value) {
    return value ? value.replaceAll("-", ".") : "--";
  }

  const appLoaded = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "app.js?v=20261109-companycatalyst1";
    script.onload = resolve;
    script.onerror = reject;
    document.body.append(script);
  });

  const refreshed = fetch("/api/data", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return {
        data: await response.json(),
        sourceDate: response.headers.get("X-Source-Date"),
        targetDate: response.headers.get("X-Target-Date"),
        refreshError: response.headers.get("X-Refresh-Error") === "1",
      };
    })
    .catch(() => null);

  Promise.allSettled([appLoaded, refreshed]).then(([, refreshResult]) => {
    const result = refreshResult.status === "fulfilled" ? refreshResult.value : null;
    if (!result) {
      statusElement.textContent = "离线缓存";
      return;
    }
    const latest = result.data;
    if (initialData?.sourceDate && latest?.sourceDate > initialData.sourceDate) {
      statusElement.textContent = "发现新数据，正在刷新…";
      window.location.reload();
      return;
    }
    if (result.refreshError) {
      statusElement.textContent = `更新检查失败 · ${formatDate(latest?.sourceDate)}`;
      return;
    }
    if (latest?.sourceDate && result.targetDate && latest.sourceDate < result.targetDate) {
      statusElement.textContent = `上游尚未更新 · 截至 ${formatDate(latest.sourceDate)}`;
      return;
    }
    statusElement.textContent = "已是最新";
  });
})();
