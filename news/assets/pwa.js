(() => {
  "use strict";
  const button = document.querySelector("#install-app");
  const standalone = window.matchMedia("(display-mode: standalone)");
  const isInstalled = () => standalone.matches || navigator.standalone === true;
  let installPrompt;
  const updateButton = () => {
    button.hidden = isInstalled();
  };
  updateButton();
  standalone.addEventListener?.("change", updateButton);
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    updateButton();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    button.hidden = true;
  });
  button.addEventListener("click", async () => {
    if (installPrompt) {
      const prompt = installPrompt;
      installPrompt = null;
      try {
        await prompt.prompt();
        await prompt.userChoice;
        return;
      } catch {
        /* Browser may have withdrawn its installation prompt. */
      }
    }
    document.querySelector("#dialog-title").textContent = "安装到桌面";
    document.querySelector("#dialog-content").innerHTML =
      "<p>安装后可从桌面直接打开资讯，使用独立窗口阅读。</p>" +
      "<h3>电脑 Chrome / Edge</h3><p>点击地址栏的安装图标，或在浏览器菜单中选择“安装资讯”或“将此网站安装为应用”。</p>" +
      "<h3>iPhone / iPad</h3><p>在 Safari 的普通标签页中打开本站，点击分享按钮，选择“添加到主屏幕”。添加后先保持联网，从桌面图标打开一次，进入生活指南或小游戏，等显示“已准备好，可离线阅读”或“已准备好，可离线玩”再断网。Safari 与桌面入口需要分别准备。</p>" +
      "<h3>Android</h3><p>在浏览器菜单中选择“安装应用”或“添加到主屏幕”。</p>" +
      "<h3>Mac Safari</h3><p>在支持的版本中，选择“文件 → 添加到程序坞”。</p>" +
      "<p>生活指南、小游戏和杭州房源分别在对应页面准备离线资源。完成后，可离线阅读已下载的指南、已保存的资讯、收藏和房源，玩已准备好的小游戏。更新内容、打开原文链接需要联网；清除浏览器数据会移除本地缓存。Safari 与桌面入口需要分别准备。</p>";
    document.querySelector("#info-dialog").showModal();
  });

  const offlineStatus = document.querySelector("#offline-status"),
    offlineTools = document.querySelector("#offline-tools"),
    prepareButton = document.querySelector("#prepare-offline"),
    offlineHint = document.querySelector("#offline-hint"),
    secureLink = document.querySelector("#offline-secure-link"),
    isGames = !!document.querySelector("#library"),
    isGuide = !!document.querySelector("#life-guide"),
    isHomes = !!document.querySelector("#home-book"),
    hasOfflineTools = isGames || isGuide || isHomes;
  let registration,
    checking,
    starting,
    automaticRepair = false;
  const pageCache = document.querySelector('meta[name="news-shell-cache"]')?.content;
  const messages = {
    ready: isGuide
      ? "已准备好，可离线阅读"
      : isHomes
        ? "已准备好，可离线查看已保存房源"
        : "已准备好，可离线玩",
    checking: "正在检查离线资源…",
    downloading: "正在准备离线资源，请保持联网…",
    controller: "还未完成离线准备，请保持联网后重试。",
    version: "正在同步离线版本，请保持联网；稍后可刷新页面重新检查。",
    missing: "离线资源不完整，请联网后点“准备离线使用”。",
    download: "离线资源未下载完整，请保持联网后重试。",
    storage:
      "浏览器未能读写离线资源，请在普通标签页中重试，并检查设备可用空间。",
    timeout: "离线检查未完成，请点“重新检查”。",
    insecure: "当前页面不是安全连接，无法启用离线使用。",
    unavailable: "当前打开方式没有提供离线功能，请在 Safari 普通标签页中打开。",
    registration: "离线功能未能启动，请保持联网后重试。",
  };
  function status(reason) {
    if (!offlineStatus) return;
    offlineStatus.textContent = messages[reason] || messages.registration;
    offlineStatus.classList.toggle("ready", reason === "ready");
    offlineStatus.dataset.state = reason;
    if (offlineTools) offlineTools.hidden = !hasOfflineTools;
    if (prepareButton) {
      prepareButton.textContent = ["ready", "timeout", "version"].includes(
        reason,
      )
        ? "重新检查"
        : "准备离线使用";
      prepareButton.disabled = [
        "checking",
        "downloading",
        "insecure",
        "unavailable",
      ].includes(reason);
    }
    if (secureLink)
      secureLink.hidden = !["insecure", "unavailable"].includes(reason);
    if (offlineHint)
      offlineHint.textContent = isInstalled()
        ? "请在这个桌面入口完成准备，再断网使用。"
        : "iPhone 添加到主屏幕后，请从桌面图标联网打开一次，再准备离线使用。";
  }
  function support() {
    if (!window.isSecureContext) {
      status("insecure");
      return false;
    }
    try {
      if (!("serviceWorker" in navigator) || !navigator.serviceWorker) {
        status("unavailable");
        return false;
      }
    } catch {
      status("unavailable");
      return false;
    }
    return true;
  }
  function activateWaiting() {
    const waiting = registration?.waiting;
    if (waiting?.state === "installed")
      waiting.postMessage({ type: "SKIP_WAITING" });
  }
  function keepPageVersion() {
    if (pageCache && navigator.serviceWorker.controller)
      navigator.serviceWorker.controller.postMessage({
        type: "CLIENT_VERSION",
        cacheName: pageCache,
      });
  }
  function watch(worker) {
    if (!worker) return;
    const changed = () => {
      activateWaiting();
      if (worker.state === "activated") checkOffline();
      if (worker.state === "redundant" && !navigator.serviceWorker.controller)
        status("download");
    };
    worker.addEventListener("statechange", changed);
    changed();
  }
  function askWorker(worker, type, paths) {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      let timer;
      const overall = setTimeout(
        () => finish({ ready: false, reason: "timeout" }),
        type === "PREPARE_OFFLINE" ? 300000 : 8000,
      );
      const heartbeat = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => finish({ ready: false, reason: "timeout" }),
          type === "PREPARE_OFFLINE" ? 60000 : 8000,
        );
      };
      function finish(value) {
        clearTimeout(timer);
        clearTimeout(overall);
        channel.port1.close();
        resolve(value);
      }
      channel.port1.onmessage = (event) => {
        if (event.data?.progress) {
          heartbeat();
          if (isGuide && offlineStatus)
            offlineStatus.textContent = `正在保存指南：${event.data.done}/${event.data.total} 章，请保持联网…`;
          return;
        }
        finish(event.data || { ready: false, reason: "storage" });
      };
      heartbeat();
      try {
        worker.postMessage(
          {
            type,
            paths,
            cacheName: pageCache,
            page: isGuide ? "guide" : isHomes ? "homes" : "games",
          },
          [channel.port2],
        );
      } catch {
        finish({ ready: false, reason: "controller" });
      }
    });
  }
  async function checkOffline(repair = false) {
    if (!hasOfflineTools || !support()) return;
    if (checking) return checking;
    checking = (async () => {
      const controller = navigator.serviceWorker.controller;
      if (!controller) {
        status("controller");
        return;
      }
      const paths = [
        ...new Set([
          "/",
          ...(isGuide ? ["/guide/"] : isHomes ? ["/homes/"] : ["/games/"]),
          "/manifest.webmanifest",
          ...Array.from(
            document.querySelectorAll("script[src], link[rel=stylesheet]"),
            (el) => new URL(el.src || el.href).pathname,
          ),
          ...(isGuide
            ? [
                new URL(
                  document.querySelector('meta[name="guide-book"]').content,
                  location.href,
                ).pathname,
              ]
            : []),
        ]),
      ];
      status(repair ? "downloading" : "checking");
      // Older installed workers understand CHECK_OFFLINE only. Always negotiate
      // through that message before asking a capable worker to repair its cache.
      let result = await askWorker(controller, "CHECK_OFFLINE", paths);
      if (
        !result.ready &&
        result.reason === "missing" &&
        navigator.onLine &&
        (repair || !automaticRepair)
      ) {
        automaticRepair = true;
        status("downloading");
        result = await askWorker(controller, "PREPARE_OFFLINE", paths);
      }
      activateWaiting();
      status(
        result.ready
          ? "ready"
          : result.reason || (registration?.waiting ? "version" : "missing"),
      );
      if (result.ready && isGuide)
        window.dispatchEvent(new Event("guide-offline-ready"));
    })().finally(() => {
      checking = null;
    });
    return checking;
  }
  async function start() {
    // News gets the network first. Games still prepare immediately on entry.
    if (isGuide) await window.guideInitialLoad;
    else if (!isGames) await window.newsInitialLoad;
    if (!support()) return;
    if (starting) return starting;
    starting = (async () => {
      try {
        registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
        keepPageVersion();
        activateWaiting();
        watch(registration.installing);
        registration.addEventListener("updatefound", () =>
          watch(registration.installing),
        );
        // A normal refresh also retries a previously failed offline update;
        // register() alone may reuse the browser's recent worker check.
        if (navigator.onLine && registration.active)
          registration.update().catch(() => {});
        navigator.serviceWorker.ready
          .then(() => checkOffline())
          .catch(() => status("registration"));
        await checkOffline();
      } catch (error) {
        // A cold offline launch may reject register() while a saved controller
        // and its cache are already usable. Check that installed version first.
        if (navigator.serviceWorker.controller) {
          keepPageVersion();
          await checkOffline();
          return;
        }
        status(
          error.name === "SecurityError" || error.name === "InvalidStateError"
            ? "unavailable"
            : "registration",
        );
      }
    })().finally(() => {
      starting = null;
    });
    return starting;
  }
  prepareButton?.addEventListener("click", async () => {
    if (!support()) return;
    status("downloading");
    if (
      !registration ||
      (!registration.active &&
        !registration.installing &&
        !registration.waiting)
    )
      await start();
    if (navigator.onLine && registration) {
      try {
        await registration.update();
      } catch {
        /* Existing cached files may still work. */
      }
    }
    activateWaiting();
    await checkOffline(true);
    activateWaiting();
  });
  if (support()) {
    window.addEventListener("guide-index-ready", () => {
      if (registration) checkOffline();
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      activateWaiting();
      keepPageVersion();
      Promise.resolve(checking).then(() => checkOffline());
    });
    // News waits for its first data check; the games page starts immediately.
    start();
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        automaticRepair = false;
        keepPageVersion();
        checkOffline();
        if (navigator.onLine && registration)
          registration.update().catch(() => {});
      }
    });
    window.addEventListener("online", () => {
      automaticRepair = false;
      if (registration) {
        checkOffline();
        registration.update().catch(() => {});
      } else start();
    });
  }
})();
