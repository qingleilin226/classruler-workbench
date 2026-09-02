/**
 * API 封装：统一 fetch、Token 注入、统一错误 Toast、401 跳登录。
 * 后端统一返回 {code, message, data}。
 */
(function (global) {
  const TOKEN_KEY = "class_mgr_token";

  const api = {
    getToken() {
      return localStorage.getItem(TOKEN_KEY) || "";
    },
    setToken(token) {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    },

    async request(method, url, body, opts = {}) {
      const headers = { "Content-Type": "application/json" };
      const token = this.getToken();
      if (token) headers["Authorization"] = "Bearer " + token;
      if (opts.raw) delete headers["Content-Type"]; // 上传文件用 FormData

      let res;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: opts.raw ? body : body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        // 网络错误必须明确 Toast，不能白屏
        ElMessage.error("网络连接失败，请检查后端服务是否启动");
        throw e;
      }
      const data = await res.json().catch(() => ({ code: 500, message: "响应解析失败", data: {} }));

      if (data.code === 401) {
        this.setToken("");
        location.hash = "#/login";
        ElMessage.warning("登录已过期，请重新登录");
        throw new Error(data.message || "未登录");
      }
      if (data.code !== 0) {
        ElMessage.error(data.message || "请求失败");
        throw new Error(data.message || "请求失败");
      }
      return data.data;
    },

    get(url, params) {
      if (params) {
        const qs = Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&");
        if (qs) url += (url.includes("?") ? "&" : "?") + qs;
      }
      return this.request("GET", url);
    },
    post(url, body) {
      return this.request("POST", url, body);
    },
    put(url, body) {
      return this.request("PUT", url, body);
    },
    del(url) {
      return this.request("DELETE", url);
    },

    /** 下载文件（导出 Excel 等） */
    async download(url, params, filename) {
      let full = url;
      if (params) {
        const qs = Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&");
        if (qs) full += "?" + qs;
      }
      const token = this.getToken();
      const res = await fetch(full, {
        headers: token ? { Authorization: "Bearer " + token } : {},
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        ElMessage.error(data.message || "导出失败");
        return;
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename || "download.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    },

    /** 上传文件并返回解析结果（导入三步走 Step 1） */
    async uploadFile(file) {
      const fd = new FormData();
      fd.append("file", file);
      return this.request("POST", "/api/import/upload", fd, { raw: true });
    },
  };

  global.api = api;
})(window);
