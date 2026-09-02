/**
 * 工作台首页：班级概览卡片 + 快捷入口 + 最近考试情况。
 */
(function () {
  const { ref, computed, onMounted, watch } = Vue;

  window.DashboardView = {
    name: "DashboardView",
    setup() {
      const store = window.useMainStore();
      const stats = ref({ student_total: 0, exam_count: 0, active: 0 });
      const recentExams = ref([]);
      const loading = ref(false);

      const greeting = computed(() => {
        const h = new Date().getHours();
        return h < 6 ? "夜深了" : h < 12 ? "早上好" : h < 14 ? "中午好" : h < 18 ? "下午好" : "晚上好";
      });

      // hash 路由跳转：模板内不能直接访问全局 location（Vue3 模板编译为 _ctx.location）
      const navigate = (path) => { location.hash = path; };

      const quickLinks = [
        { path: "/students", label: "导入学生名单", desc: "Excel 批量导入，字段人工映射", icon: "Upload" },
        { path: "/seats", label: "调整座次", desc: "拖拽换座，自动保存新版本", icon: "Grid" },
        { path: "/exams", label: "录入成绩", desc: "手动录入或 Excel 多表导入", icon: "DataLine" },
        { path: "/timetable", label: "临时调课", desc: "原课置灰，新课标记「调」", icon: "Tickets" },
      ];

      async function load() {
        // 学期未就绪时不发请求（登录后 loadClasses 异步完成，watch 会补跑）
        if (!store.currentClassId || !store.currentSemesterId) return;
        loading.value = true;
        try {
          const cid = store.currentClassId;
          const sid = store.currentSemesterId;
          const [students, exams] = await Promise.all([
            window.api.get("/api/students", { class_id: cid }),
            window.api.get("/api/exams", { class_id: cid, semester_id: sid }),
          ]);
          stats.value = {
            student_total: students.length,
            exam_count: exams.length,
            active: students.filter((s) => s.status === "在读").length,
          };
          recentExams.value = exams.slice(0, 3);
        } finally {
          loading.value = false;
        }
      }

      onMounted(load);
      // 切换班级/学期后刷新
      watch(() => [store.currentClassId, store.currentSemesterId], load);

      return { store, greeting, quickLinks, stats, recentExams, loading, navigate };
    },
    template: `
    <div v-loading="loading">
      <div class="page-card">
        <div style="font-size:20px;font-weight:700">
          {{ greeting }}，{{ store.user?.display_name || '班主任' }}！
        </div>
        <div style="color:#7a8194;margin-top:6px">
          当前工作台：<b style="color:#2b5da8">{{ store.currentClass?.name || '未选择班级' }}</b>
          · {{ store.currentSemester?.name || '' }}
          （{{ store.currentClass?.academic_year || '' }}学年）
          · 已激活学期自动恢复上次选择
        </div>
      </div>

      <!-- 班级概览 -->
      <div class="stat-cards">
        <div class="stat-card">
          <div class="label">本班学生数</div>
          <div class="value">{{ stats.student_total }}<small> 人</small></div>
        </div>
        <div class="stat-card accent-green">
          <div class="label">在读学生</div>
          <div class="value green">{{ stats.active }}<small> 人</small></div>
        </div>
        <div class="stat-card accent-orange">
          <div class="label">本学期考试</div>
          <div class="value orange">{{ stats.exam_count }}<small> 次</small></div>
        </div>
        <div class="stat-card accent-purple">
          <div class="label">已保存座次方案</div>
          <div class="value" style="color:#7d6fd8">历史版本自动保留</div>
        </div>
      </div>

      <!-- 快捷入口 -->
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;margin-top:16px">
        <div v-for="q in quickLinks" :key="q.path" class="committee-card" style="cursor:pointer"
             @click="navigate(q.path)">
          <div style="display:flex;align-items:center;gap:10px">
            <el-icon :size="22" style="color:#2b5da8"><component :is="q.icon" /></el-icon>
            <div>
              <div style="font-weight:600">{{ q.label }}</div>
              <div style="color:#7a8194;font-size:12px;margin-top:4px">{{ q.desc }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 最近考试 -->
      <div class="page-card" style="margin-top:16px">
        <div style="font-weight:600;margin-bottom:12px">最近考试</div>
        <el-empty v-if="!recentExams.length" description="本学期还没有考试记录" :image-size="80" />
        <el-table v-else :data="recentExams" border>
          <el-table-column prop="name" label="考试名称" />
          <el-table-column prop="exam_date" label="考试日期" />
          <el-table-column prop="subjects" label="科目">
            <template #default="{ row }">
              <el-tag v-for="s in row.subjects" :key="s" size="small" style="margin-right:4px">{{ s }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="120">
            <template #default>
              <el-button link type="primary" @click="navigate('/exams')">查看分析</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>
    `,
  };
})();
