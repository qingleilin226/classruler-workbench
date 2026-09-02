/**
 * 全局状态（Pinia）：用户信息、班级列表、当前班级/学期。
 * 状态持久化：关闭浏览器再打开自动恢复上次选中的班级和学期（localStorage）。
 */
(function () {
  const { defineStore } = Pinia;

  const CLASS_KEY = "class_mgr_class";
  const SEMESTER_KEY = "class_mgr_semester";

  window.useMainStore = defineStore("main", {
    state: () => ({
      token: window.api.getToken(),
      user: null,
      classes: [],
      semesters: [],
      currentClassId: parseInt(localStorage.getItem(CLASS_KEY) || "0", 10) || null,
      currentSemesterId: parseInt(localStorage.getItem(SEMESTER_KEY) || "0", 10) || null,
      loaded: false,
    }),
    getters: {
      currentClass(state) {
        return state.classes.find((c) => c.id === state.currentClassId) || null;
      },
      currentSemester(state) {
        return state.semesters.find((s) => s.id === state.currentSemesterId) || null;
      },
    },
    actions: {
      /** 应用启动时初始化：登录信息 + 班级列表 + 恢复上次选择 */
      async bootstrap() {
        if (!this.token) return;
        try {
          this.user = await window.api.get("/api/auth/me");
          await this.loadClasses();
        } catch (e) {
          /* 401 已由 api 层处理 */
        }
        this.loaded = true;
      },

      async loadClasses() {
        const classes = await window.api.get("/api/classes");
        this.classes = classes;
        // 恢复或默认选择第一个班级
        if (!this.currentClassId || !classes.find((c) => c.id === this.currentClassId)) {
          this.currentClassId = classes.length ? classes[0].id : null;
        }
        if (this.currentClassId) {
          await this.loadSemesters();
          const cls = classes.find((c) => c.id === this.currentClassId);
          if (!this.currentSemesterId && cls) {
            this.currentSemesterId = cls.active_semester_id;
          }
        }
        this.persist();
      },

      async loadSemesters() {
        if (!this.currentClassId) {
          this.semesters = [];
          this.currentSemesterId = null;
          return;
        }
        this.semesters = await window.api.get(
          `/api/classes/${this.currentClassId}/semesters`);
        const active = this.semesters.find((s) => s.is_active);
        if (!this.semesters.find((s) => s.id === this.currentSemesterId)) {
          this.currentSemesterId = active ? active.id : (this.semesters[0]?.id || null);
        }
        this.persist();
      },

      async switchClass(classId) {
        this.currentClassId = classId;
        this.currentSemesterId = null;
        await this.loadSemesters();
        this.persist();
      },

      async switchSemester(semesterId) {
        this.currentSemesterId = semesterId;
        this.persist();
      },

      persist() {
        if (this.currentClassId) localStorage.setItem(CLASS_KEY, String(this.currentClassId));
        if (this.currentSemesterId) localStorage.setItem(SEMESTER_KEY, String(this.currentSemesterId));
      },

      async logout() {
        this.token = "";
        this.user = null;
        this.loaded = false;
        window.api.setToken("");
        location.hash = "#/login";
      },
    },
  });
})();
