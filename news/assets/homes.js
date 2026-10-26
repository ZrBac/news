(() => {
  "use strict";
  const H = window.HomeBook,
    $ = (selector) => document.querySelector(selector);
  const esc = (value) =>
    String(value == null ? "" : value).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const display = (value, suffix = "") =>
    value == null || value === "" ? "待补充" : `${value}${suffix}`;
  const money = (value) =>
    display(value == null ? null : Math.round(value * 100) / 100, " 万");
  const minute = (value) => display(value, " 分钟");
  const priority = {
    new: "新房优先，二手房也可",
    resale: "二手房优先，新房也可",
    any: "新房、二手房均可",
  };
  let db,
    ready = false,
    state = H.defaults(),
    selected = new Set(),
    editorId = null,
    detailId = null,
    editorRevision = 0,
    profileRevision = 0,
    detailRevision = 0;
  let channel = null;
  try {
    if (typeof BroadcastChannel === "function")
      channel = new BroadcastChannel("zrbac-home-book");
  } catch {
    // Version checks in the storage transaction still prevent stale writes.
  }
  function message(text) {
    $("#home-message").textContent = text;
    $("#home-message").hidden = !text;
  }
  function errorText(error) {
    if (error?.name === "QuotaExceededError")
      return "设备存储空间不足，未能保存。请先导出已有记录，再减少照片或释放空间。";
    return error?.message || "未能保存，请检查浏览器存储权限后重试。";
  }
  function formError(form, error) {
    const el = form.querySelector(".home-form-error");
    el.textContent = error ? errorText(error) : "";
    el.hidden = !error;
    if (error) el.scrollIntoView({ block: "nearest" });
  }
  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("zrbac-home-book", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("notebook");
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(
          new Error("另一页面正在使用旧版存储，请关闭其他看房页面后重试。"),
        );
      request.onsuccess = () => {
        db = request.result;
        db.onversionchange = () => {
          db.close();
          message("看房存储版本已更新，请保存填写内容后重新打开页面。");
        };
        resolve();
      };
    });
  }
  function read() {
    return new Promise((resolve, reject) => {
      const request = db
        .transaction("notebook", "readonly")
        .objectStore("notebook")
        .get("state");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        try {
          resolve(request.result ? H.validate(request.result) : H.defaults());
        } catch (error) {
          reject(error);
        }
      };
    });
  }
  async function commit(next, revision) {
    const clean = H.validate(next);
    if (new Blob([JSON.stringify(clean)]).size > H.MAX_BACKUP - 1024)
      throw new Error(
        "记录及照片已超过 60 MB。请先导出备份，再删减不需要的照片记录。",
      );
    await new Promise((resolve, reject) => {
      const tx = db.transaction("notebook", "readwrite"),
        store = tx.objectStore("notebook");
      let failure;
      tx.oncomplete = resolve;
      tx.onabort = () =>
        reject(
          failure || tx.error || new Error("保存未完成，原有记录未改变。"),
        );
      const request = store.get("state");
      request.onsuccess = () => {
        if ((request.result?.revision || 0) !== revision) {
          failure = new Error(
            "另一页面已更新记录。请先保留当前填写内容，关闭后重新编辑，避免覆盖新记录。",
          );
          tx.abort();
          return;
        }
        clean.revision = revision + 1;
        store.put(clean, "state");
        const cloud = store.get("cloud");
        cloud.onsuccess = () => {
          if (cloud.result?.token)
            store.put({ ...cloud.result, pending: true }, "cloud");
        };
      };
    });
    state = clean;
    channel?.postMessage({ revision: state.revision });
    render();
    window.HomeCloud?.sync();
  }
  async function refresh() {
    if (!db || document.querySelector(".home-dialog[open]")) return;
    try {
      state = await read();
      render();
    } catch (error) {
      message(errorText(error));
    }
  }
  channel?.addEventListener("message", refresh);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
  const dirty = (dialog) => dialog.dataset.dirty === "1";
  function closeDialog(dialog) {
    if (dialog.dataset.busy === "1") return;
    if (dirty(dialog) && !confirm("有尚未保存的填写内容，确定放弃吗？")) return;
    dialog.dataset.dirty = "0";
    dialog.close();
    refresh();
  }
  document
    .querySelectorAll("[data-close]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        closeDialog(document.getElementById(button.dataset.close)),
      ),
    );
  document.querySelectorAll(".home-dialog").forEach((dialog) => {
    dialog.addEventListener("close", () => window.HomeCloud?.sync());
    dialog.addEventListener("input", () => {
      dialog.dataset.dirty = "1";
    });
    dialog.addEventListener("change", () => {
      dialog.dataset.dirty = "1";
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDialog(dialog);
    });
  });
  window.addEventListener("beforeunload", (event) => {
    if (
      document.querySelector(
        '.home-dialog[open][data-dirty="1"], .home-dialog[open][data-busy="1"]',
      )
    ) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  $("#close-dialog").addEventListener("click", () => $("#info-dialog").close());
  $("#theme-toggle").addEventListener("click", () => {
    const theme =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content =
      theme === "dark" ? "#181818" : "#ffffff";
    try {
      localStorage.setItem("zrbac-news-theme", theme);
    } catch {}
  });
  function direction(c) {
    return c.driver === "undecided"
      ? "开车方向待确定"
      : `开车去${H.campuses[c.driver]}，送站后去${H.campuses[c.driver === "yungu" ? "xixi" : "yungu"]}`;
  }
  function warnings(h) {
    const p = state.profile,
      total = H.totals(h),
      c = h.commute,
      transit = H.passenger(c),
      notes = [];
    if (
      p.budgetMax != null &&
      total.amount != null &&
      total.amount > p.budgetMax
    )
      notes.push(`已知金额超预算 ${money(total.amount - p.budgetMax)}`);
    if (
      p.maxDrive != null &&
      c.driverTotal != null &&
      c.driverTotal > p.maxDrive
    )
      notes.push("开车时间超过预期");
    if (p.maxTransit != null && transit != null && transit > p.maxTransit)
      notes.push("送站＋地铁时间超过预期");
    return notes.join(" · ");
  }
  function render() {
    if (!ready) return;
    const p = state.profile;
    $("#profile-summary").innerHTML =
      `<strong>${p.budgetMin != null && p.budgetMax != null ? `${esc(p.budgetMin)}–${esc(p.budgetMax)} 万` : p.budgetMax != null ? `预算不超过 ${esc(p.budgetMax)} 万` : p.budgetMin != null ? `预算 ${esc(p.budgetMin)} 万起` : "预算待确定"}</strong><p>${esc(priority[p.priority])} · ${esc(p.areas || "区域待确定")}</p><p>云谷园区 ＋ 西溪园区 · ${esc(direction(p))}</p>`;
    selected = new Set(
      [...selected].filter((id) => state.homes.some((h) => h.id === id)),
    );
    const query = $("#home-search").value.trim().toLowerCase(),
      status = $("#status-filter").value,
      kind = $("#kind-filter").value;
    const homes = state.homes.filter(
      (h) =>
        (!status || h.status === status) &&
        (!kind || h.kind === kind) &&
        (!query ||
          [
            h.name,
            h.district,
            h.address,
            h.detail,
            h.reason,
            ...h.visits.map((v) => v.note),
          ]
            .join(" ")
            .toLowerCase()
            .includes(query)),
    );
    const sort = $("#sort-homes").value;
    homes.sort(
      (a, b) =>
        (sort === "price"
          ? (H.latest(a)?.amount ?? Infinity) -
            (H.latest(b)?.amount ?? Infinity)
          : sort === "priority"
            ? Number(b.kind === p.priority) - Number(a.kind === p.priority)
            : 0) || b.updatedAt.localeCompare(a.updatedAt),
    );
    $("#home-count").textContent =
      `${state.homes.length} 套房源${homes.length !== state.homes.length ? ` · 当前显示 ${homes.length} 套` : ""}`;
    $("#home-list").innerHTML = homes.length
      ? homes
          .map((h) => {
            const q = H.latest(h),
              total = H.totals(h),
              warning = warnings(h);
            return `<article class="home-card" data-home="${h.id}"><div class="home-card-top"><span><span class="home-tag">${H.kinds[h.kind]}</span><span class="home-tag ${h.status === "shortlist" ? "active" : ""}">${H.statuses[h.status]}</span></span><label class="home-check"><input type="checkbox" data-compare="${h.id}" ${selected.has(h.id) ? "checked" : ""} aria-label="比较 ${esc(h.name)}" />比较</label></div><h2>${esc(h.name)}</h2><p class="home-muted">${esc([h.district, h.size ? `${h.size}㎡` : "", h.layout].filter(Boolean).join(" · ") || "区域、面积待补充")}</p><p class="home-price">${q ? esc(q.amount) : "价格待补充"}${q ? "<small>万元</small>" : ""}</p><p class="home-quote">${q ? `${H.priceTypes[q.type]} · ${esc(q.date)}${q.source ? ` · ${esc(q.source)}` : ""}` : "添加报价后可比较预算"}</p>${total.amount != null ? `<p class="home-quote">含已填费用 ${esc(money(total.amount))}${total.complete ? "" : " · 费用未填全"}</p>` : ""}<div class="home-commute"><p>${esc(direction(h.commute))}</p><p>开车 ${esc(minute(h.commute.driverTotal))} · 送站＋地铁 ${esc(minute(H.passenger(h.commute)))}</p></div>${warning ? `<p class="home-caution">${esc(warning)}</p>` : ""}${h.reason ? `<p class="home-muted">${esc(h.reason.slice(0, 100))}</p>` : ""}<div class="home-card-bottom"><span class="home-muted">${h.visits.length ? `${h.visits.length} 次看房记录` : "还未记录看房"}</span><div><button data-edit="${h.id}">编辑</button> <button data-detail="${h.id}">查看 / 记看房</button></div></div></article>`;
          })
          .join("")
      : state.homes.length
        ? '<div class="home-empty"><h2>没有符合筛选的房源</h2><p>试试其他关键词，或清除筛选条件。</p><button id="reset-filters" class="home-primary">清除筛选</button></div>'
        : '<div class="home-empty"><div class="home-empty-icon" aria-hidden="true"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8" /></svg></div><h2>收藏想看的房子</h2><p>在上方候选中点“收藏”，来源和报价会一起带过来。也可以自己补充其他房源。</p><button id="empty-add" class="home-primary">添加其他房源</button></div>';
    $("#compare-bar").hidden = selected.size === 0;
    $("#compare-count").textContent = `已选 ${selected.size} / 3 套`;
    $("#show-compare").disabled = selected.size < 2;
    window.dispatchEvent(new CustomEvent("homebookchange"));
  }
  function fill(form, fields) {
    for (const [key, value] of Object.entries(fields)) {
      const el = form.elements.namedItem(key);
      if (el) el.value = value == null ? "" : value;
    }
  }
  function values(form) {
    return Object.fromEntries(new FormData(form).entries());
  }
  async function submit(form, work) {
    const dialog = form.closest("dialog"),
      button = form.querySelector('[type="submit"]');
    if (dialog.dataset.busy === "1") return;
    dialog.dataset.busy = "1";
    button.disabled = true;
    formError(form, null);
    try {
      await work();
    } catch (error) {
      formError(form, error);
    } finally {
      dialog.dataset.busy = "0";
      button.disabled = false;
    }
  }
  function editHome(id = null) {
    if (!ready) return;
    const h = id ? state.homes.find((home) => home.id === id) : null;
    if (id && !h) return;
    editorId = id;
    editorRevision = state.revision;
    const form = $("#home-form"),
      dialog = $("#home-editor");
    form.reset();
    formError(form, null);
    fill(form, {
      kind: state.profile.priority === "resale" ? "resale" : "new",
      driver: state.profile.driver,
      priceDate: today(),
    });
    if (h)
      fill(form, {
        ...h,
        ...h.costs,
        ...h.commute,
        commuteDate: h.commute.date,
        commuteNote: h.commute.note,
      });
    $("#home-editor-title").textContent = h
      ? "编辑房源 / 新增报价"
      : "添加房源";
    dialog.querySelectorAll("details").forEach((details) => {
      details.open = details.id === "quote-fields";
    });
    dialog.dataset.dirty = "0";
    dialog.showModal();
    dialog.scrollTop = 0;
  }
  $("#add-home").addEventListener("click", () => editHome());
  $("#home-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    submit(form, async () => {
      const v = values(form),
        now = new Date().toISOString(),
        old = editorId ? state.homes.find((h) => h.id === editorId) : null;
      if (editorId && !old) throw new Error("此房源已不存在，请重新添加。");
      const h = {
        ...v,
        id: old?.id || H.id(),
        createdAt: old?.createdAt || now,
        updatedAt: now,
        prices: H.copy(old?.prices || []),
        visits: H.copy(old?.visits || []),
        costs: { parking: v.parking, tax: v.tax, decoration: v.decoration },
        commute: {
          driver: v.driver,
          station: v.station,
          driverTotal: v.driverTotal,
          detour: v.detour,
          drop: v.drop,
          wait: v.wait,
          metro: v.metro,
          lastLeg: v.lastLeg,
          date: v.commuteDate,
          note: v.commuteNote,
        },
      };
      if (v.price !== "")
        h.prices.push({
          id: H.id(),
          amount: v.price,
          type: v.priceType,
          date: v.priceDate,
          source: v.priceSource,
          createdAt: now,
        });
      const normalized = H.home(h),
        next = H.copy(state);
      if (old)
        next.homes[next.homes.findIndex((h) => h.id === old.id)] = normalized;
      else next.homes.push(normalized);
      await commit(next, editorRevision);
      $("#home-editor").dataset.dirty = "0";
      $("#home-editor").close();
      message(`已保存「${normalized.name}」。`);
    });
  });
  $("#edit-profile").addEventListener("click", () => {
    const form = $("#profile-form"),
      dialog = $("#profile-editor");
    form.reset();
    fill(form, state.profile);
    formError(form, null);
    profileRevision = state.revision;
    dialog.dataset.dirty = "0";
    dialog.showModal();
  });
  $("#profile-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    submit(form, async () => {
      const next = H.copy(state);
      next.profile = H.profile(values(form));
      await commit(next, profileRevision);
      $("#profile-editor").dataset.dirty = "0";
      $("#profile-editor").close();
      message("找房条件已保存。");
    });
  });
  for (const selector of [
    "#home-search",
    "#status-filter",
    "#kind-filter",
    "#sort-homes",
  ])
    $(selector).addEventListener(
      selector === "#home-search" ? "input" : "change",
      render,
    );
  $("#home-list").addEventListener("click", (event) => {
    const el = event.target.closest("button");
    if (!el) return;
    if (el.dataset.edit) editHome(el.dataset.edit);
    if (el.dataset.detail) showDetail(el.dataset.detail);
    if (el.id === "empty-add") editHome();
    if (el.id === "reset-filters") {
      $("#home-search").value = "";
      $("#status-filter").value = "";
      $("#kind-filter").value = "";
      render();
    }
  });
  $("#home-list").addEventListener("change", (event) => {
    const id = event.target.dataset.compare;
    if (!id) return;
    if (event.target.checked && selected.size >= 3) {
      event.target.checked = false;
      message("一次最多比较 3 套，请先取消一套。");
      return;
    }
    if (event.target.checked) selected.add(id);
    else selected.delete(id);
    render();
  });
  function detailRows(h) {
    const q = H.latest(h),
      total = H.totals(h),
      c = h.commute;
    return [
      ["房源", `${H.kinds[h.kind]} · ${H.statuses[h.status]}`],
      [
        "区域 / 地址",
        [h.district, h.address].filter(Boolean).join(" · ") || "待补充",
      ],
      [
        "面积 / 户型",
        [h.size ? `${h.size}㎡` : "面积待补充", h.layout]
          .filter(Boolean)
          .join(" · "),
      ],
      [
        "最新价格",
        q
          ? `${money(q.amount)} · ${H.priceTypes[q.type]} · ${q.date}`
          : "待补充",
      ],
      [
        "含已填费用",
        total.amount == null
          ? "待补充"
          : `${money(total.amount)}${total.complete ? "" : "（费用未填全）"}`,
      ],
      [
        "其他费用",
        `车位 ${money(h.costs.parking)} / 税费及其他 ${money(h.costs.tax)} / 另需装修 ${money(h.costs.decoration)}`,
      ],
      ["房屋情况", h.detail || "待补充"],
      ["考虑 / 排除", h.reason || "待补充"],
      ["通勤方向", direction(c)],
      [
        "开车全程",
        `${minute(c.driverTotal)}（含送站）；绕路 ${minute(c.detour)}`,
      ],
      [
        "送站＋地铁",
        `${minute(H.passenger(c))}；送达站点：${c.station || "待补充"}`,
      ],
      [
        "地铁者分段",
        `家到站 ${minute(c.drop)} → 进站候车 ${minute(c.wait)} → 地铁含换乘 ${minute(c.metro)} → 出站到园区 ${minute(c.lastLeg)}`,
      ],
      ["通勤依据", [c.date, c.note].filter(Boolean).join(" · ") || "尚未核实"],
    ];
  }
  function renderDetail() {
    const h = state.homes.find((h) => h.id === detailId);
    if (!h) return;
    $("#detail-title").textContent = h.name;
    const query = `杭州 ${h.address || h.name}`;
    $("#detail-content").innerHTML =
      `<div class="home-actions"><button data-edit-detail class="home-primary">编辑 / 记报价</button>${h.sourceUrl ? `<a href="${esc(h.sourceUrl)}" target="_blank" rel="noopener noreferrer">房源原文 ↗</a>` : ""}<a href="https://uri.amap.com/search?keyword=${encodeURIComponent(query)}&city=${encodeURIComponent("杭州")}&callnative=0" target="_blank" rel="noopener noreferrer">地图搜位置 ↗</a></div><dl class="home-detail-grid">${detailRows(
        h,
      )
        .map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`)
        .join(
          "",
        )}</dl><section class="home-detail-section"><h3>价格记录 · ${h.prices.length} 条</h3><p class="home-muted">不同性质的报价不能直接当作成交或降价，保留原始来源方便复核。</p>${
        h.prices.length
          ? `<ul class="home-history">${[...h.prices]
              .sort(
                (a, b) =>
                  b.date.localeCompare(a.date) ||
                  b.createdAt.localeCompare(a.createdAt),
              )
              .map(
                (q) =>
                  `<li><p><strong>${esc(money(q.amount))}</strong> · ${H.priceTypes[q.type]}</p><p class="home-muted">${esc(q.date)} · ${esc(q.source || "来源待补充")}</p><button class="home-delete-record" data-delete-price="${q.id}">删除这条报价</button></li>`,
              )
              .join("")}</ul>`
          : '<p class="home-muted">还没有报价记录。</p>'
      }</section><section class="home-detail-section"><h3>看房记录 · ${h.visits.length} 次</h3>${
        h.visits.length
          ? `<ul class="home-history">${[...h.visits]
              .sort((a, b) => b.date.localeCompare(a.date))
              .map(
                (v) =>
                  `<li><strong>${esc(v.date)}</strong><p>${esc(v.note)}</p>${v.photos.length ? `<div class="home-photo-grid">${v.photos.map((photo, i) => `<a href="${photo}" download="看房-${esc(v.date)}-${i + 1}.jpg" title="保存照片"><img src="${photo}" alt="${esc(v.date)} 看房照片 ${i + 1}" loading="lazy" /></a>`).join("")}</div>` : ""}<button class="home-delete-record" data-delete-visit="${v.id}">删除这次记录</button></li>`,
              )
              .join("")}</ul>`
          : '<p class="home-muted">看完房后，在下面记下第一感受。</p>'
      }</section><div class="home-actions"><button data-delete-home class="home-link">删除这套房源</button></div>`;
  }
  function showDetail(id) {
    detailId = id;
    detailRevision = state.revision;
    renderDetail();
    const form = $("#visit-form"),
      dialog = $("#home-detail");
    form.reset();
    form.elements.date.value = today();
    formError(form, null);
    $("#photo-count").textContent = "";
    dialog.dataset.dirty = "0";
    dialog.showModal();
    dialog.scrollTop = 0;
  }
  $("#detail-content").addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const dialog = $("#home-detail");
    if (dialog.dataset.busy === "1") return;
    if (button.hasAttribute("data-edit-detail")) {
      closeDialog(dialog);
      if (!dialog.open) editHome(detailId);
      return;
    }
    const price = button.dataset.deletePrice,
      visit = button.dataset.deleteVisit,
      all = button.hasAttribute("data-delete-home");
    if (!price && !visit && !all) return;
    if (dirty(dialog)) {
      formError(
        $("#visit-form"),
        new Error("请先保存当前看房记录，再删除已有内容。"),
      );
      return;
    }
    if (
      !confirm(
        all
          ? "删除这套房源及全部价格、笔记和照片？此操作无法撤销，建议先导出备份。"
          : "确定删除这条记录？此操作无法撤销。",
      )
    )
      return;
    dialog.dataset.busy = "1";
    try {
      const next = H.copy(state),
        h = next.homes.find((h) => h.id === detailId);
      if (all) next.homes = next.homes.filter((h) => h.id !== detailId);
      else {
        if (price) h.prices = h.prices.filter((p) => p.id !== price);
        if (visit) h.visits = h.visits.filter((v) => v.id !== visit);
        h.updatedAt = new Date().toISOString();
      }
      await commit(next, detailRevision);
      detailRevision = state.revision;
      if (all) {
        dialog.close();
        message("房源已删除。");
      } else {
        renderDetail();
        formError($("#visit-form"), null);
      }
    } catch (error) {
      formError($("#visit-form"), error);
    } finally {
      dialog.dataset.busy = "0";
    }
  });
  function compress(file) {
    return new Promise((resolve, reject) => {
      if (
        !/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type) ||
        file.size > 25 * 1024 * 1024
      ) {
        reject(
          new Error(
            "请选择小于 25 MB 的照片；如 HEIC 无法读取，请先转成 JPEG。",
          ),
        );
        return;
      }
      const image = new Image(),
        url = URL.createObjectURL(file);
      image.onload = () => {
        try {
          const scale = Math.min(
              1,
              1280 / Math.max(image.naturalWidth, image.naturalHeight),
            ),
            canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.78));
        } catch {
          reject(new Error("照片处理失败，请选择较小的 JPEG 照片重试。"));
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(
          new Error("浏览器无法读取这张照片，请换成 JPEG 或 PNG 后重试。"),
        );
      };
      image.src = url;
    });
  }
  $("#visit-photos").addEventListener("change", () => {
    const count = $("#visit-photos").files.length;
    $("#photo-count").textContent = count
      ? `已选择 ${count} 张${count > 6 ? "，请重新选择，最多 6 张。" : "，保存时压缩。"}`
      : "";
  });
  $("#visit-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    submit(form, async () => {
      const v = values(form),
        files = Array.from($("#visit-photos").files);
      if (files.length > 6)
        throw new Error("每次最多保存 6 张照片，请重新选择。");
      if (!v.note.trim() && !files.length)
        throw new Error("请填写看房感受，或添加一张照片。");
      const photos = [];
      for (const file of files) photos.push(await compress(file));
      const next = H.copy(state),
        h = next.homes.find((h) => h.id === detailId);
      if (!h) throw new Error("房源已不存在，请关闭后重新打开。");
      h.visits.push({ id: H.id(), date: v.date, note: v.note, photos });
      h.updatedAt = new Date().toISOString();
      if (h.status === "planned") h.status = "visited";
      await commit(next, detailRevision);
      detailRevision = state.revision;
      form.reset();
      form.elements.date.value = today();
      $("#photo-count").textContent = "已保存看房记录。";
      $("#home-detail").dataset.dirty = "0";
      renderDetail();
    });
  });
  $("#clear-compare").addEventListener("click", () => {
    selected.clear();
    render();
  });
  $("#show-compare").addEventListener("click", () => {
    const homes = [...selected].map((id) =>
      state.homes.find((h) => h.id === id),
    );
    if (homes.length < 2) return;
    const rows = detailRows(homes[0]).map(([label], index) => [
      label,
      homes.map((h) => detailRows(h)[index][1]),
    ]);
    rows.push([
      "预算 / 通勤提示",
      homes.map((h) => warnings(h) || "已填信息未触发提醒；未知项仍需核实"),
    ]);
    rows.push([
      "最近看房感受",
      homes.map((h) => {
        const v = [...h.visits].sort((a, b) => b.date.localeCompare(a.date))[0];
        return v ? `${v.date}\n${v.note || "仅记录了照片"}` : "还未记录";
      }),
    ]);
    $("#compare-content").innerHTML =
      `<table class="home-table"><thead><tr><th scope="col">对比项</th>${homes.map((h) => `<th scope="col">${esc(h.name)}</th>`).join("")}</tr></thead><tbody>${rows.map(([key, values]) => `<tr><th scope="row">${esc(key)}</th>${values.map((value) => `<td>${esc(value)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    $("#compare-dialog").showModal();
  });
  $("#export-homes").addEventListener("click", async () => {
    try {
      const fresh = await read(),
        blob = new Blob(
          [JSON.stringify({ ...fresh, exportedAt: new Date().toISOString() })],
          { type: "application/json" },
        );
      const url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = `我的看房-${today()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      message(
        `已生成 ${fresh.homes.length} 套房源的完整备份（含照片），请确认保存到“文件”或下载目录。换设备时在同一页面导入。`,
      );
    } catch (error) {
      message(errorText(error));
    }
  });
  $("#import-homes").addEventListener("click", () => $("#backup-file").click());
  $("#backup-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    $("#import-homes").disabled = true;
    try {
      if (file.size > H.MAX_BACKUP)
        throw new Error("备份过大，最多支持 60 MB。");
      const imported = H.parse(await file.text()),
        fresh = await read(),
        result = H.merge(fresh, imported);
      if (
        !confirm(
          `备份中有 ${imported.homes.length} 套房源。将添加 ${result.added} 套，跳过 ${result.skipped} 套相同记录${result.conflicts ? `；其中 ${result.conflicts} 套有差异，会另存为导入副本` : ""}。\n现有记录不会被覆盖。${!fresh.homes.length ? "找房条件将采用备份中的设置。" : "找房条件保持当前设置。"}\n确认导入？`,
        )
      )
        return;
      await commit(result.state, fresh.revision);
      message(
        `导入完成：添加 ${result.added} 套，跳过 ${result.skipped} 套${result.conflicts ? `，${result.conflicts} 套差异记录保留为副本` : ""}。`,
      );
    } catch (error) {
      message(`导入失败，原有记录未改变。${errorText(error)}`);
    } finally {
      $("#import-homes").disabled = false;
    }
  });
  window.HomeNotebook = {
    snapshot: () => H.copy(state),
    async save(next, revision) {
      if (!ready) throw new Error("请先允许浏览器存储，再收藏房源。");
      await commit(next, revision);
    },
    message,
  };
  window.homesInitialLoad = (async () => {
    try {
      await openDB();
      state = await read();
      ready = true;
      render();
      for (const id of [
        "add-home",
        "edit-profile",
        "export-homes",
        "import-homes",
      ])
        document.getElementById(id).disabled = false;
      window.HomeCloud?.init({
        db,
        message,
        isEditing: () => !!document.querySelector(".home-dialog[open]"),
        async refreshed() {
          await refresh();
          channel?.postMessage({ cloud: true });
        },
      }).catch((error) => message(`同步暂不可用。${errorText(error)}`));
    } catch (error) {
      $("#storage-error").textContent =
        `无法读取看房存储，已暂停编辑，避免丢失记录。请在普通浏览器标签页打开并允许网站存储，再重新加载。${errorText(error)}`;
      $("#storage-error").hidden = false;
      $("#home-count").textContent = "存储暂不可用";
      $("#profile-summary").textContent = "记录读取失败";
    }
  })();
})();
