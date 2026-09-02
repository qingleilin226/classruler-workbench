/**
 * 模块3：值日表
 * 周视图 + 高亮当天 + 点击某天批量勾选学生 + 下周自动轮换 + 导出
 */
(function () {
  const { ref, reactive, computed, onMounted, watch } = Vue;

  window.DutyView = {
    name: "DutyView",
    setup() {
      const store = window.useMainStore();
      const weekOffset = ref(0);
      const view = ref(null);
      const loading = ref(false);
      const editDay = ref(null);          // 正在编辑的星期
      const editDate = ref("");
      const selected = reactive({});      // studentId -> [duty_types]
      const allStudents = ref([]);
      const dialogVisible = ref(false);

      const weekdayCN = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

      const todayWeekday = computed(() => (new Date().getDay() + 6) % 7 + 1);

      async function load() {
        if (!store.currentClassId) {
          view.value = null;
          return;
        }
        loading.value = true;
        try {
          view.value = await window.api.get("/api/duty/week", {
            class_id: store.currentClassId, week_offset: weekOffset.value });
        } finally {
          loading.value = false;
        }
      }

      onMounted(load);
      watch(() => store.currentClassId, load);

      function weekRangeText() {
        if (!view.value) return "";
        const dates = Object.values(view.value.week_dates);
        return `${dates[0]} ~ ${dates[6]}`;
      }

      // ---------------- 编辑某天 ----------------
      async function openEditDay(wd) {
        if (weekOffset.value !== 0) {
          ElMessage.warning("只能编辑本周的值日安排，其他周请先点「回到本周」");
          return;
        }
        editDay.value = wd;
        editDate.value = view.value?.week_dates[String(wd)] || "";
        Object.keys(selected).forEach((k) => delete selected[k]);
        // 预填当天现有安排
        (view.value?.days[String(wd)] || []).forEach((item) => {
          selected[String(item.id)] = item.duty_type;
        });
        // 加载全班学生
        allStudents.value = await window.api.get("/api/students", {
          class_id: store.currentClassId });
        dialogVisible.value = true;
      }

      async function saveDay() {
        const assignments = Object.entries(selected)
          .map(([sid, dtype]) => ({ student_id: Number(sid), duty_type: dtype }));
        if (!assignments.length) {
          ElMessage.warning("请至少勾选一名学生");
          return;
        }
        await window.api.post("/api/duty/set-day", {
          class_id: store.currentClassId, weekday: editDay.value, assignments });
        ElMessage.success("值日安排已更新");
        dialogVisible.value = false;
        load();
      }

      // ---------------- 下周轮换 ----------------
      async function rotate() {
        try {
          await ElMessageBox.confirm(
            "下周轮换：本周值日生将顺延至下一组，模板永久更新。确定吗？",
            "下周自动轮换", { type: "warning" });
        } catch (e) { return; }
        await window.api.post("/api/duty/rotate", { class_id: store.currentClassId });
        ElMessage.success("已轮换至下一组");
        load();
      }

      async function onExport() {
        await window.api.download("/api/duty/export", {
          class_id: store.currentClassId, week_offset: weekOffset.value,
        }, `值日表_第${weekOffset.value + 1}周.xlsx`);
      }

      return {
        store, weekOffset, view, loading, editDay, editDate, selected, allStudents,
        dialogVisible, weekdayCN, todayWeekday, weekRangeText, openEditDay, saveDay,
        rotate, onExport,
      };
    },
    template: `
    <div>
      <div class="page-card">
        <div class="page-toolbar">
          <el-button-group>
            <el-button :icon="'ArrowLeft'" :disabled="weekOffset === -52"
                       @click="weekOffset--; load()">上一周</el-button>
            <el-button @click="weekOffset = 0; load()">回到本周</el-button>
            <el-button :icon="'ArrowRight'" :disabled="weekOffset === 52"
                       @click="weekOffset++; load()">下一周</el-button>
          </el-button-group>
          <span style="color:#7a8194">{{ weekRangeText() }}</span>
          <div style="flex:1"></div>
          <el-button type="primary" @click="rotate">下周自动轮换（顺延一组）</el-button>
          <el-button :icon="'Download'" @click="onExport">导出为Excel</el-button>
        </div>

        <div v-loading="loading" class="duty-week-grid">
          <div v-for="wd in 7" :key="wd" class="duty-day" :class="{ today: wd === todayWeekday }">
            <div class="d-head">
              <span>{{ weekdayCN[wd] }}</span>
              <span style="font-size:12px">{{ view?.week_dates[String(wd)] || '' }}</span>
            </div>
            <div class="d-body">
              <el-empty v-if="!view?.days[String(wd)]?.length" description="未安排" :image-size="50" />
              <template v-for="item in view?.days[String(wd)] || []" :key="item.id + '-' + item.duty_type">
                <div class="duty-item">
                  <span>{{ item.name }}</span>
                  <span class="d-type">{{ item.duty_type }}</span>
                </div>
              </template>
              <el-button size="small" type="primary" plain style="width:100%;margin-top:6px"
                         @click="openEditDay(wd)">编辑当天</el-button>
            </div>
          </div>
        </div>
        <div style="color:#909399;font-size:12px;margin-top:10px">
          高亮显示当天值日生。点击某天可批量勾选学生；「下周自动轮换」将本周值日生顺延至下一组。
        </div>
      </div>

      <!-- 编辑某天值日 -->
      <el-dialog v-model="dialogVisible" :title="'编辑 ' + weekdayCN[editDay] + ' 值日（' + editDate + '）'"
                 width="720px">
        <el-alert type="info" :closable="false" show-icon style="margin-bottom:12px"
                  title="勾选学生并指定值日类型，保存后覆盖当天安排" />
        <el-table :data="allStudents" border max-height="400" size="small">
          <el-table-column prop="student_no" label="学号" width="100" />
          <el-table-column prop="name" label="姓名" width="100" />
          <el-table-column label="值日类型" min-width="280">
            <template #default="{ row }">
              <el-select v-model="selected[String(row.id)]" placeholder="不参与" clearable
                         style="width:100%">
                <el-option v-for="t in ['扫地','擦黑板','擦窗','擦桌椅','倒垃圾']" :key="t"
                           :label="t" :value="t" />
              </el-select>
            </template>
          </el-table-column>
        </el-table>
        <template #footer>
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" @click="saveDay">保存当天安排</el-button>
        </template>
      </el-dialog>
    </div>
    `,
  };
})();
