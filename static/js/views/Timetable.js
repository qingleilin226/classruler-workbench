/**
 * 模块7：课程表
 * 传统矩阵（行=星期，列=节次）+ 合并单元格Excel导入（前端重构二维数组）+ 临时调课
 * 调课后：原位置置灰（删除线），新位置置顶并标记「调」。
 */
(function () {
  const { ref, reactive, computed, onMounted, watch } = Vue;

  window.TimetableView = {
    name: "TimetableView",
    components: { ImportModal: window.ImportModal },
    setup() {
      const store = window.useMainStore();
      const grid = ref([]);        // grid[period-1][weekday-1] = {course, teacher, changed, change}
      const changes = ref([]);
      const changeDate = ref(new Date().toISOString().slice(0, 10));
      const loading = ref(false);
      const importVisible = ref(false);
      const adjustDialog = ref(false);
      const adjust = reactive({
        old_weekday: null, old_period: null, course_name: "",
        new_weekday: null, new_period: null, change_date: changeDate.value,
      });
      const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

      async function load() {
        if (!store.currentClassId || !store.currentSemesterId) {
          grid.value = [];
          return;
        }
        loading.value = true;
        try {
          const data = await window.api.get("/api/timetable", {
            class_id: store.currentClassId, semester_id: store.currentSemesterId,
            change_date: changeDate.value,
          });
          grid.value = data.grid || [];
          changes.value = data.changes || [];
        } finally {
          loading.value = false;
        }
      }

      onMounted(load);
      watch(() => [store.currentClassId, store.currentSemesterId], load);
      watch(changeDate, load);

      const periods = computed(() => grid.value.length);

      function cellClass(cell) {
        if (!cell) return "course-cell";
        if (cell.change?.kind === "from") return "course-cell changed-from";
        if (cell.change?.kind === "to") return "course-cell changed-to";
        return "course-cell";
      }

      function cellText(cell) {
        return cell?.course || "";
      }

      function openAdjust(periodIdx, weekdayIdx) {
        const cell = grid.value[periodIdx]?.[weekdayIdx];
        if (!cell || !cell.course || cell.change?.kind === "from") {
          ElMessage.warning("该位置没有课程，无法调课");
          return;
        }
        Object.assign(adjust, {
          old_weekday: weekdayIdx + 1, old_period: periodIdx + 1,
          course_name: cell.course, new_weekday: null, new_period: null,
          change_date: changeDate.value,
        });
        adjustDialog.value = true;
      }

      async function saveAdjust() {
        if (!adjust.new_weekday || !adjust.new_period) {
          ElMessage.warning("请选择调往的星期和节次");
          return;
        }
        await window.api.post("/api/timetable/adjust", {
          class_id: store.currentClassId, semester_id: store.currentSemesterId,
          change_date: adjust.change_date, course_name: adjust.course_name,
          old_weekday: adjust.old_weekday, old_period: adjust.old_period,
          new_weekday: adjust.new_weekday, new_period: adjust.new_period,
        });
        ElMessage.success("调课成功：原位置已置灰，新位置标记「调」");
        adjustDialog.value = false;
        load();
      }

      async function cancelChange(row) {
        try {
          await ElMessageBox.confirm(
            `取消调课「${row.course_name}」（${row.old} → ${row.new}）？课程将恢复原位。`,
            "取消调课", { type: "warning" });
        } catch (e) { return; }
        await window.api.post("/api/timetable/cancel-change", { change_id: row.id });
        ElMessage.success("调课已取消");
        load();
      }

      async function onExport() {
        await window.api.download("/api/timetable/export", {
          class_id: store.currentClassId, semester_id: store.currentSemesterId,
        }, `课程表_${store.currentClass?.name || ""}.xlsx`);
      }

      return { store, grid, changes, changeDate, loading, importVisible, adjustDialog, adjust,
               WEEKDAYS, periods, cellClass, cellText, openAdjust, saveAdjust, cancelChange, onExport };
    },
    template: `
    <div>
      <div class="page-card">
        <div class="page-toolbar">
          <span style="color:#7a8194">查看日期：</span>
          <el-date-picker v-model="changeDate" type="date" value-format="YYYY-MM-DD"
                          style="width:160px" placeholder="今天" />
          <div style="flex:1"></div>
          <el-button :icon="'Upload'" @click="importVisible = true">导入课程表（Excel）</el-button>
          <el-button :icon="'Download'" @click="onExport">导出为Excel</el-button>
        </div>

        <div v-loading="loading" style="overflow-x:auto">
          <table class="timetable-table">
            <thead>
              <tr>
                <th style="width:70px">节次</th>
                <th v-for="w in WEEKDAYS" :key="w">{{ w }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, pi) in grid" :key="pi">
                <td class="period-label">第{{ pi + 1 }}节</td>
                <td v-for="(cell, wi) in row" :key="wi" :class="cellClass(cell)"
                    @click="openAdjust(pi, wi)">
                  <template v-if="cellText(cell)">
                    {{ cellText(cell) }}
                    <span v-if="cell.change?.kind === 'to'" class="change-tag">调</span>
                    <div v-if="cell.teacher" style="font-size:11px;color:#7a8194">{{ cell.teacher }}</div>
                  </template>
                  <span v-else style="color:#c0c4cc">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div style="color:#909399;font-size:12px;margin-top:10px">
          点击任意有课的位置可发起<b>临时调课</b>；调课后原位置课程置灰（删除线），新位置标「调」。
          {{ changes.length ? '当日调课 ' + changes.length + ' 条：' : '' }}
          <el-tag v-for="c in changes" :key="c.id" size="small" style="margin:0 4px"
                  closable @close="cancelChange(c)">
            {{ c.course_name }}（{{ c.old }} → {{ c.new }}）
          </el-tag>
        </div>
      </div>

      <!-- 临时调课 -->
      <el-dialog v-model="adjustDialog" title="临时调课" width="480px">
        <el-alert type="warning" show-icon :closable="false" style="margin-bottom:14px"
                  :title="'原课程：' + adjust.course_name + '（' + WEEKDAYS[adjust.old_weekday - 1] + ' 第' + adjust.old_period + '节）'" />
        <el-form label-width="90px">
          <el-form-item label="调往星期">
            <el-select v-model="adjust.new_weekday" style="width:100%">
              <el-option v-for="(w, i) in WEEKDAYS" :key="i" :label="w" :value="i + 1" />
            </el-select>
          </el-form-item>
          <el-form-item label="调往节次">
            <el-select v-model="adjust.new_period" style="width:100%">
              <el-option v-for="p in periods" :key="p" :label="'第' + p + '节'" :value="p" />
            </el-select>
          </el-form-item>
          <el-form-item label="调课日期">
            <el-date-picker v-model="adjust.change_date" type="date" value-format="YYYY-MM-DD"
                            style="width:100%" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="adjustDialog = false">取消</el-button>
          <el-button type="primary" @click="saveAdjust">确认调课</el-button>
        </template>
      </el-dialog>

      <import-modal v-model="importVisible" target="timetable"
                    :extra="{ class_id: store.currentClassId, semester_id: store.currentSemesterId }"
                    title="导入课程表（支持合并单元格）" @success="load" />
    </div>
    `,
  };
})();
