/**
 * 模块2：座次表（可视化交互核心）
 * Div 矩阵展示 + 拖拽换座 + 保存为新版本（不覆盖历史）+ 历史版本回溯 + 导出
 */
(function () {
  const { ref, reactive, computed, onMounted, watch } = Vue;

  window.SeatsView = {
    name: "SeatsView",
    setup() {
      const store = window.useMainStore();
      const grid = ref([]);          // [[studentId|null]]
      const names = ref({});         // studentId -> 姓名
      const planInfo = ref({ plan_id: null, effective_date: "", remark: "" });
      const loading = ref(false);
      const dragId = ref(null);      // 正在拖拽的学生ID
      const hoverId = ref(null);     // 悬停目标
      const remark = ref("");
      const dirty = ref(false);
      const history = ref([]);
      const historyVisible = ref(false);

      async function load() {
        if (!store.currentClassId || !store.currentSemesterId) {
          grid.value = [];
          return;
        }
        loading.value = true;
        try {
          const data = await window.api.get("/api/seats/current", {
            class_id: store.currentClassId, semester_id: store.currentSemesterId });
          grid.value = data.grid || [];
          names.value = data.student_names || {};
          planInfo.value = {
            plan_id: data.plan_id, effective_date: data.effective_date,
            remark: data.remark || "",
          };
          remark.value = data.remark || "";
          dirty.value = false;
        } finally {
          loading.value = false;
        }
      }

      onMounted(load);
      watch(() => [store.currentClassId, store.currentSemesterId], load);

      const maxCols = computed(() => Math.max(...grid.value.map((r) => r.length), 0));

      function seatStudent(row, col) {
        const id = grid.value[row]?.[col];
        return id ? names.value[id] : "";
      }

      // ---------------- 拖拽换座 ----------------
      function onDragStart(row, col) {
        const id = grid.value[row]?.[col];
        if (id == null) return false;
        dragId.value = id;
        return true;
      }

      function onDrop(targetRow, targetCol) {
        if (dragId.value == null) return;
        let fromR = -1, fromC = -1;
        grid.value.forEach((r, ri) => r.forEach((v, ci) => {
          if (v === dragId.value) { fromR = ri; fromC = ci; }
        }));
        if (fromR === -1) return;
        // 交换
        const targetId = grid.value[targetRow]?.[targetCol] ?? null;
        grid.value[fromR][fromC] = targetId;
        if (!grid.value[targetRow]) grid.value[targetRow] = [];
        grid.value[targetRow][targetCol] = dragId.value;
        dragId.value = null;
        dirty.value = true;
        ElMessage.success("已换座，记得点击右下角「保存座次」");
      }

      function addRow() {
        grid.value.push(new Array(maxCols.value).fill(null));
        dirty.value = true;
      }

      async function savePlan() {
        if (!store.currentClassId || !store.currentSemesterId) return;
        loading.value = true;
        try {
          await window.api.post("/api/seats/save", {
            class_id: store.currentClassId,
            semester_id: store.currentSemesterId,
            grid: grid.value,
            remark: remark.value || `第${(await loadHistoryCount()) + 1}版座次`,
          });
          ElMessage.success("座次已保存为新版本（历史版本保留，可回溯）");
          dirty.value = false;
          load();
        } finally {
          loading.value = false;
        }
      }

      async function loadHistoryCount() {
        const data = await window.api.get("/api/seats/history", {
          class_id: store.currentClassId, semester_id: store.currentSemesterId });
        history.value = data;
        return data.length;
      }

      async function showHistory() {
        await loadHistoryCount();
        historyVisible.value = true;
      }

      async function restorePlan(planId) {
        const data = await window.api.get(`/api/seats/history/${planId}`);
        grid.value = data.grid;
        names.value = data.student_names;
        planInfo.value = { plan_id: planId, effective_date: data.effective_date, remark: data.remark };
        historyVisible.value = false;
        dirty.value = true;
        ElMessage.info("已载入历史方案，确认后请保存为新版本");
      }

      async function onExport() {
        await window.api.download("/api/seats/export", {
          class_id: store.currentClassId, semester_id: store.currentSemesterId,
        }, `座次表_${store.currentClass?.name || ""}.xlsx`);
      }

      function hasSeats() {
        return grid.value.some((r) => r.some((v) => v != null));
      }

      return {
        store, grid, names, planInfo, loading, dragId, hoverId, remark, dirty,
        history, historyVisible, maxCols, seatStudent, onDragStart, onDrop,
        addRow, savePlan, showHistory, restorePlan, onExport, hasSeats,
      };
    },
    template: `
    <div>
      <div class="page-card">
        <div class="page-toolbar">
          <el-select v-model="store.currentSemesterId" style="width:140px"
                     @change="store.switchSemester($event)">
            <el-option v-for="s in store.semesters" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
          <el-input v-model="remark" placeholder="本版备注（如：期中后排布）" style="width:220px" clearable />
          <div style="flex:1"></div>
          <el-button @click="showHistory" :icon="'Clock'">历史版本（{{ history.length }}）</el-button>
          <el-button :icon="'Download'" @click="onExport">导出为Excel</el-button>
        </div>

        <el-alert v-if="!hasSeats()" type="info" show-icon :closable="false"
                  title="当前班级/学期还没有座次方案。可从 Word/PDF 排座文本导入，或点击下方「+ 增加一排」后拖拽布置。" />

        <div class="seat-grid-wrap">
          <div class="seat-grid" :style="{ gridTemplateColumns: 'repeat(' + maxCols + ', 1fr)' }">
            <template v-for="(row, ri) in grid" :key="'r' + ri">
              <div v-for="(sid, ci) in row" :key="ri + '-' + ci"
                   class="seat-cell"
                   :class="{ dragging: dragId === sid, empty: sid == null,
                             'drop-target': hoverId === ri + '-' + ci && dragId != null }"
                   :draggable="sid != null"
                   @dragstart="onDragStart(ri, ci)"
                   @dragend="dragId = null"
                   @dragover.prevent="hoverId = ri + '-' + ci"
                   @dragleave="hoverId = null"
                   @drop="onDrop(ri, ci); hoverId = null">
                <template v-if="sid != null">
                  <div class="s-name">{{ names[sid] }}</div>
                  <div class="s-no">{{ sid }}</div>
                </template>
                <template v-else><div style="color:#b8bfcd;font-size:12px">空位</div></template>
              </div>
            </template>
          </div>
        </div>

        <div class="seat-legend">
          <span>👆 拖拽学生卡片即可换座</span>
          <span>当前版本：{{ planInfo.effective_date || '未保存' }}（备注：{{ planInfo.remark || '无' }}）</span>
          <el-button link type="primary" size="small" @click="addRow">+ 增加一排</el-button>
          <span style="flex:1"></span>
          <el-button type="success" :disabled="!dirty" @click="savePlan">保存座次（新版本）</el-button>
        </div>
      </div>

      <!-- 历史版本弹窗 -->
      <el-dialog v-model="historyVisible" title="座次历史版本" width="560px">
        <el-table :data="history" border>
          <el-table-column prop="effective_date" label="生效日期" width="130" />
          <el-table-column prop="remark" label="备注" min-width="140" />
          <el-table-column prop="student_count" label="人数" width="80" align="center" />
          <el-table-column label="操作" width="100" align="center">
            <template #default="{ row }">
              <el-button size="small" type="primary" link @click="restorePlan(row.id)">载入</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-dialog>
    </div>
    `,
  };
})();
