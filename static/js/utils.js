/** 通用工具函数 */
(function (global) {
  const utils = {
    /** 导出当前表格为 Excel（前端降级方案；正常走后端接口，保留筛选条件） */
    exportTableExcel(headers, rows, filename) {
      if (typeof XLSX === "undefined") {
        ElMessage.warning("xlsx 库未加载，无法导出");
        return;
      }
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "数据");
      XLSX.writeFile(wb, filename || "export.xlsx");
      ElMessage.success("导出成功（前端导出）");
    },

    /** 从文件读取文本（docx/pdf 备用解析，正常由后端解析） */
    readFileAsText(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsText(file, "utf-8");
      });
    },

    /** 身份证/手机号脱敏 */
    maskPhone(phone) {
      if (!phone) return "";
      return phone.length >= 11 ? phone.slice(0, 3) + "****" + phone.slice(-4) : phone;
    },

    /** 下载文本/HTML 文件 */
    downloadText(content, filename) {
      const blob = new Blob([content], { type: "text/html;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    },

    /** 打开可打印窗口 */
    openPrintWindow(html) {
      const w = window.open("", "_blank");
      if (!w) {
        ElMessage.error("浏览器拦截了弹窗，请允许弹出窗口");
        return;
      }
      w.document.write(html);
      w.document.close();
    },

    /** 星期数字转中文 */
    weekdayCN(wd) {
      return ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"][wd] || "";
    },

    today() {
      return new Date().toISOString().slice(0, 10);
    },
  };

  global.utils = utils;
})(window);
