/* A local commit is durable before upload. Server revisions prevent lost updates. */
(() => {
  "use strict";
  const H = window.HomeBook;
  const API = document
    .querySelector('meta[name="homes-api"]')
    .content.replace(/\/$/, "");
  const $ = (s) => document.querySelector(s);
  let adapter,
    running = false,
    retry = false;
  const equal = (a, b) =>
    a &&
    b &&
    JSON.stringify({ ...a, revision: 0 }) ===
      JSON.stringify({ ...b, revision: 0 });
  function status(text, options = {}) {
    $("#cloud-status").textContent = text;
    $("#cloud-merge").hidden = !options.conflict;
    $("#cloud-sync").hidden = !options.connected;
    $("#cloud-share").hidden = !options.connected;
    $("#cloud-connect").textContent = options.connected
      ? "同步设置"
      : "连接私人看房本";
  }
  function snapshot() {
    return new Promise((resolve, reject) => {
      const tx = adapter.db.transaction("notebook", "readonly"),
        store = tx.objectStore("notebook");
      const book = store.get("state"),
        cloud = store.get("cloud");
      tx.oncomplete = () =>
        resolve({
          state: book.result ? H.validate(book.result) : H.defaults(),
          cloud: cloud.result || {},
        });
      tx.onabort = () => reject(tx.error);
    });
  }
  function change(work) {
    return new Promise((resolve, reject) => {
      const tx = adapter.db.transaction("notebook", "readwrite"),
        store = tx.objectStore("notebook");
      let result, failure;
      const book = store.get("state"),
        cloud = store.get("cloud");
      cloud.onsuccess = () => {
        try {
          result = work(book.result || H.defaults(), cloud.result || {}, store);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || tx.error);
    });
  }
  async function request(token, method = "GET", body, since) {
    const controller = new AbortController(),
      timer = setTimeout(
        () => controller.abort(),
        method === "PUT" ? 120000 : 20000,
      );
    try {
      const response = await fetch(
        API + "/notebook" + (Number.isInteger(since) ? `?since=${since}` : ""),
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          cache: "no-store",
          credentials: "omit",
        },
      );
      if (!response.ok) {
        const error = new Error(
          response.status === 401
            ? "同步码无效，请重新连接；本机记录仍保留。"
            : response.status === 413
              ? "记录与照片超过服务器容量限制，请导出后删减。"
              : "暂时无法连接服务器，记录已保存在此设备。联网后会重试。",
        );
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
  async function updateMeta(original, remote, uploaded) {
    return change((state, cloud, store) => {
      if (
        cloud.token !== original.cloud.token ||
        (cloud.baseRevision || 0) > remote.revision
      )
        return false;
      cloud.baseRevision = remote.revision;
      cloud.savedAt = remote.savedAt;
      cloud.conflict = false;
      cloud.pending = state.revision !== original.state.revision;
      store.put(cloud, "cloud");
      return !cloud.pending;
    });
  }
  async function synchronize() {
    if (!adapter) return;
    if (running) {
      retry = true;
      return;
    }
    running = true;
    retry = false;
    try {
      const current = await snapshot(),
        meta = current.cloud;
      if (!meta.token) {
        status(
          "连接私人看房本后，收藏、笔记和照片会同步到你的服务器。目前保存在此设备。",
        );
        return;
      }
      status("正在同步…", { connected: true });
      const remote = await request(
        meta.token,
        "GET",
        undefined,
        meta.baseRevision,
      );
      const hasLocalEdits =
        meta.pending ||
        (meta.baseRevision == null && current.state.revision > 0);
      if (hasLocalEdits) {
        if (remote.state && equal(remote.state, current.state)) {
          const done = await updateMeta(current, remote);
          status(
            done
              ? "已同步到私人看房本 · 两台设备共用"
              : "本机有新记录，等待同步",
            { connected: true },
          );
          retry = !done;
        } else if (
          remote.revision === meta.baseRevision ||
          remote.revision === 0
        ) {
          const saved = await request(meta.token, "PUT", {
            baseRevision: remote.revision,
            state: current.state,
          });
          const done = await updateMeta(current, saved);
          status(
            done
              ? "已同步到私人看房本 · 两台设备共用"
              : "本机有新记录，等待同步",
            { connected: true },
          );
          retry = !done;
        } else {
          await change((state, cloud, store) => {
            if (cloud.token === meta.token)
              store.put({ ...cloud, pending: true, conflict: true }, "cloud");
          });
          status("另一设备也修改了记录。两边内容均保留，请合并后继续同步。", {
            connected: true,
            conflict: true,
          });
        }
      } else if (!remote.unchanged) {
        if (adapter.isEditing()) {
          status("服务器有更新，保存或关闭正在填写的内容后同步。", {
            connected: true,
          });
          return;
        }
        const clean = remote.state ? H.validate(remote.state) : null;
        const applied = await change((state, cloud, store) => {
          if (
            cloud.token !== meta.token ||
            state.revision !== current.state.revision ||
            cloud.pending
          )
            return false;
          if (clean)
            store.put({ ...clean, revision: state.revision + 1 }, "state");
          store.put(
            {
              ...cloud,
              baseRevision: remote.revision,
              savedAt: remote.savedAt,
              pending: false,
              conflict: false,
            },
            "cloud",
          );
          return true;
        });
        if (applied) await adapter.refreshed();
        status(
          applied
            ? "已同步到私人看房本 · 两台设备共用"
            : "本机有新记录，等待同步",
          { connected: true },
        );
        retry = !applied;
      } else {
        status("已同步到私人看房本 · 两台设备共用", { connected: true });
      }
    } catch (error) {
      if (error.status === 409) {
        status("另一设备刚刚更新了记录，正在重新检查…", { connected: true });
        retry = true;
      } else {
        status(
          error.status
            ? error.message
            : "暂时无法连接服务器，记录已保存在此设备。联网后会重试。",
          { connected: true },
        );
      }
    } finally {
      running = false;
      if (retry) setTimeout(synchronize, 300);
    }
  }
  async function connect(token) {
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(token))
      throw new Error("请填写完整同步码，或粘贴私人同步链接。");
    await request(token);
    await change((state, cloud, store) => {
      if (cloud.token !== token)
        store.put(
          { token, baseRevision: null, pending: state.revision > 0 },
          "cloud",
        );
    });
    $("#sync-dialog").dataset.dirty = "0";
    $("#sync-dialog").close();
    $("#sync-token").value = "";
    await synchronize();
  }
  async function merge() {
    if (running || adapter.isEditing()) return;
    if (
      !confirm(
        "将保留两边现有房源；同一房源内容不同会另存副本，另一边已删除的房源也可能恢复。请在合并后检查副本。继续？",
      )
    )
      return;
    running = true;
    try {
      const current = await snapshot(),
        remote = await request(current.cloud.token);
      const incoming = remote.state ? H.validate(remote.state) : H.defaults();
      const result = H.merge(current.state, incoming);
      if (new Blob([JSON.stringify(result.state)]).size > H.MAX_BACKUP - 1024)
        throw new Error("合并后的记录超过 60 MB，请先导出并减少照片。");
      await change((state, cloud, store) => {
        if (
          state.revision !== current.state.revision ||
          cloud.token !== current.cloud.token
        )
          throw new Error("本机记录刚刚变化，请再合并一次。");
        store.put({ ...result.state, revision: state.revision + 1 }, "state");
        store.put(
          {
            ...cloud,
            baseRevision: remote.revision,
            pending: true,
            conflict: false,
          },
          "cloud",
        );
      });
      adapter.message(
        `已合并两边记录${result.conflicts ? `，${result.conflicts} 套差异记录另存为“导入副本”` : ""}。找房条件采用本机设置（本机为空时采用服务器设置）。`,
      );
      await adapter.refreshed();
    } catch (error) {
      status(error.message, { connected: true, conflict: true });
      return;
    } finally {
      running = false;
    }
    await synchronize();
  }
  function showSettings() {
    $("#sync-error").textContent = "";
    $("#sync-link-output").hidden = true;
    $("#sync-dialog").dataset.dirty = "0";
    $("#sync-dialog").showModal();
  }
  async function receiveLink() {
    const match = /^#sync=([A-Za-z0-9_-]{40,100})$/.exec(location.hash);
    if (!match) return false;
    history.replaceState(null, "", location.pathname + location.search);
    try {
      await connect(match[1]);
    } catch {
      showSettings();
      $("#sync-token").value = match[1];
      $("#sync-error").textContent = "暂时无法连接，私人同步码已填好，请重试。";
    }
    return true;
  }
  window.HomeCloud = {
    sync: synchronize,
    async init(options) {
      adapter = options;
      $("#cloud-connect").addEventListener("click", showSettings);
      $("#cloud-sync").addEventListener("click", synchronize);
      $("#cloud-merge").addEventListener("click", merge);
      $("#cloud-share").addEventListener("click", async () => {
        const { cloud } = await snapshot();
        if (!cloud.token) return;
        const link =
          new URL(location.pathname, location.origin).href +
          "#sync=" +
          cloud.token;
        try {
          await navigator.clipboard.writeText(link);
          adapter.message(
            "私人同步链接已复制。发给一起看房的人，在另一设备打开即可共用；持有链接的人能查看和编辑记录。",
          );
        } catch {
          showSettings();
          $("#sync-link-output").value = link;
          $("#sync-link-output").hidden = false;
          $("#sync-link-output").select();
        }
      });
      $("#sync-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        let token = $("#sync-token").value.trim();
        if (token.includes("#sync=")) token = token.split("#sync=")[1];
        const button = $("#sync-submit");
        button.disabled = true;
        $("#sync-error").textContent = "正在连接…";
        try {
          await connect(token);
        } catch (error) {
          $("#sync-error").textContent = error.status
            ? error.message
            : "连接失败，请检查网络和同步码后重试。";
        } finally {
          button.disabled = false;
        }
      });
      // Capture before removing the fragment. It is never sent in an HTTP request.
      window.addEventListener("hashchange", receiveLink);
      if (!(await receiveLink())) await synchronize();
      window.addEventListener("online", synchronize);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) synchronize();
      });
      setInterval(() => {
        if (!document.hidden && navigator.onLine) synchronize();
      }, 60000);
    },
  };
})();
