/**
 * 应用入口：全局注册、hash 路由、左侧固定导航 + 右侧动态内容区布局。
 */
(function () {
  const { createApp, ref, computed, onMounted, watch, h } = Vue;
  const { ElMessage, ElMessageBox } = ElementPlus;

  // 菜单配置
  const MENUS = [
    { path: "/dashboard", label: "工作台首页", icon: "HomeFilled" },
    { path: "/students", label: "学生名单", icon: "User" },
    { path: "/seats", label: "座次表", icon: "Grid" },
    { path: "/duty", label: "值日表", icon: "Calendar" },
    { path: "/exams", label: "成绩分析", icon: "DataLine" },
    { path: "/committee", label: "班委名单", icon: "Medal" },
    { path: "/parents", label: "家长联系方式", icon: "Phone" },
    { path: "/timetable", label: "课程表", icon: "Tickets" },
    { path: "/settings", label: "班级学期与设置", icon: "Setting" },
  ];

  // 简易 hash 路由
  const currentPath = ref(location.hash.replace(/^#/, "") || "/dashboard");
  window.addEventListener("hashchange", () => {
    currentPath.value = location.hash.replace(/^#/, "") || "/dashboard";
  });

  const App = {
    setup() {
      const store = window.useMainStore();
      const booted = ref(false);
      // hash 路由跳转：模板内不能直接访问全局 location（Vue3 模板编译为 _ctx.location）
      const navigate = (path) => { location.hash = path; };

      onMounted(async () => {
        await store.bootstrap();
        booted.value = true;
        if (store.token && currentPath.value === "/login") {
          location.hash = "/dashboard";
        }
      });

      const isLogin = computed(() => currentPath.value === "/login");
      const viewComponent = computed(() => {
        const map = {
          "/login": "login-view",
          "/dashboard": "dashboard-view",
          "/students": "students-view",
          "/seats": "seats-view",
          "/duty": "duty-view",
          "/exams": "exams-view",
          "/committee": "committee-view",
          "/parents": "parents-view",
          "/timetable": "timetable-view",
          "/settings": "settings-view",
        };
        return map[currentPath.value] || "dashboard-view";
      });

      const pageTitle = computed(() => {
        const m = MENUS.find((x) => x.path === currentPath.value);
        return m ? m.label : "班主任工作台";
      });

      async function onLogout() {
        try {
          await ElMessageBox.confirm("确定退出登录吗？", "提示", { type: "warning" });
          store.logout();
        } catch (e) { /* 取消 */ }
      }

      return { store, booted, isLogin, viewComponent, pageTitle, MENUS, currentPath, onLogout, navigate };
    },
    template: `
    <div v-if="!booted" style="height:100%;display:flex;align-items:center;justify-content:center">
      <el-icon class="is-loading" style="font-size:32px;color:#2b5da8"><Loading /></el-icon>
    </div>

    <login-view v-else-if="isLogin || !store.token" />

    <div v-else class="app-shell">
      <!-- 左侧固定导航 -->
      <aside class="sidebar">
        <div class="brand">
          <div class="logo">班</div>
          <span>班主任工作台</span>
        </div>
        <nav class="menu">
          <div v-for="m in MENUS" :key="m.path" class="menu-item"
               :class="{ active: currentPath === m.path }" @click="navigate(m.path)">
            <el-icon><component :is="m.icon" /></el-icon>
            <span>{{ m.label }}</span>
          </div>
        </nav>
        <div class="sidebar-footer">私有化部署 · v1.0.0<br>数据每日凌晨自动备份</div>
      </aside>

      <!-- 右侧内容区 -->
      <div class="main-area">
        <header class="topbar">
          <el-select class="mobile-nav" :model-value="currentPath" @change="navigate($event)">
            <el-option v-for="m in MENUS" :key="m.path" :label="m.label" :value="m.path" />
          </el-select>
          <span class="page-title">{{ pageTitle }}</span>
          <div class="spacer"></div>
          <!-- 班级/学期切换（核心维度，全局生效） -->
          <el-select :model-value="store.currentClassId" style="width:150px"
                     @change="store.switchClass($event)" size="default">
            <el-option v-for="c in store.classes" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
          <el-select :model-value="store.currentSemesterId" style="width:130px"
                     @change="store.switchSemester($event)" size="default">
            <el-option v-for="s in store.semesters" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
          <div class="user-info">
            <el-icon><UserFilled /></el-icon>
            <span>{{ store.user?.display_name || store.user?.username }}</span>
            <el-button link type="danger" @click="onLogout">退出</el-button>
          </div>
        </header>
        <main class="content-area">
          <component :is="viewComponent" />
        </main>
      </div>
    </div>
    `,
  };

  const app = createApp(App);
  app.use(Pinia.createPinia());
  app.use(ElementPlus, { locale: window.ElementPlusLocaleZhCn });
  // 注册全部图标
  Object.entries(window.ElementPlusIconsVue || {}).forEach(([name, comp]) => {
    app.component(name, comp);
  });
  app.component("login-view", window.LoginView);
  app.component("dashboard-view", window.DashboardView);
  app.component("students-view", window.StudentsView);
  app.component("seats-view", window.SeatsView);
  app.component("duty-view", window.DutyView);
  app.component("exams-view", window.ExamsView);
  app.component("committee-view", window.CommitteeView);
  app.component("parents-view", window.ParentsView);
  app.component("timetable-view", window.TimetableView);
  app.component("settings-view", window.SettingsView);
  app.mount("#app");
})();
