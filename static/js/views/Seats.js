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
      const studentNos = ref({});    // studentId -> 学号
      const students = ref([]);      // 当前班级可用学生
      const planInfo = ref({ plan_id: null, effective_date: "", remark: "" });
      const loading = ref(false);
      const dragId = ref(null);      // 正在拖拽的学生ID
      const hoverId = ref(null);     // 悬停目标
      const remark = ref("");
      const dirty = ref(false);
      const history = ref([]);
      const historyVisible = ref(false);
      const cellDialog = ref(false);
      const editingCell = ref({ row: -1, col: -1 });
      const selectedStudentId = ref(null);

      async function load() {
        if (!store.currentClassId || !store.currentSemesterId) {
          grid.value = [];
          return;
        }
        loading.value = true;
        try {
          const [data, studentList] = await Promise.all([
            window.api.get("/api/seats/current", {
              class_id: store.currentClassId, semester_id: store.currentSemesterId }),
            window.api.get("/api/students", { class_id: store.currentClassId }),
          ]);
          grid.value = data.grid || [];
          students.value = studentList || [];
          const activeNames = {};
          const activeNos = {};
          students.value.forEach((student) => {
            activeNames[student.id] = student.name;
            activeNos[student.id] = student.student_no;
          });
          names.value = { ...(data.student_names || {}), ...activeNames };
          studentNos.value = activeNos;
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
      const seatedIds = computed(() => new Set(grid.value.flat().filter((id) => id != null)));
      const unseatedStudents = computed(() =>
        students.value.filter((student) => !seatedIds.value.has(student.id)));

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

      function onDragStartStudent(studentId) {
        dragId.value = studentId;
        return true;
      }

      function onDrop(targetRow, targetCol) {
        if (dragId.value == null) return;
        let fromR = -1, fromC = -1;
        grid.value.forEach((r, ri) => r.forEach((v, ci) => {
          if (v === dragId.value) { fromR = ri; fromC = ci; }
        }));
        const targetId = grid.value[targetRow]?.[targetCol] ?? null;
        // 已排座学生执行交换；未排座学生放入目标位置，原学生自动回到未排座区。
        if (fromR !== -1) grid.value[fromR][fromC] = targetId;
        if (!grid.value[targetRow]) grid.value[targetRow] = [];
        grid.value[targetRow][targetCol] = dragId.value;
        dragId.value = null;
        dirty.value = true;
        ElMessage.success("已换座，记得点击右下角「保存座次」");
      }

      function addRow() {
        grid.value.push(new Array(maxCols.value || 6).fill(null));
        dirty.value = true;
      }

      async function removeRow() {
        if (grid.value.length <= 1) {
          ElMessage.warning("座次表至少保留一排");
          return;
        }
        const last = grid.value[grid.value.length - 1];
        if (last.some((id) => id != null)) {
          try {
            await ElMessageBox.confirm("最后一排还有学生，删除后这些学生将回到未排座区。继续吗？",
              "删除一排", { type: "warning" });
          } catch (e) { return; }
        }
        grid.value.pop();
        dirty.value = true;
      }

      function addColumn() {
        if (!grid.value.length) grid.value = [new Array(1).fill(null)];
        else grid.value.forEach((row) => row.push(null));
        dirty.value = true;
      }

      async function removeColumn() {
        if (maxCols.value <= 1) {
          ElMessage.warning("座次表至少保留一列");
          return;
        }
        const occupied = grid.value.some((row) => row[row.length - 1] != null);
        if (occupied) {
          try {
            await ElMessageBox.confirm("最后一列还有学生，删除后这些学生将回到未排座区。继续吗？",
              "删除一列", { type: "warning" });
          } catch (e) { return; }
        }
        grid.value.forEach((row) => row.pop());
        dirty.value = true;
      }

      function createBlankGrid() {
        const columns = 6;
        const rows = Math.max(1, Math.ceil(Math.max(students.value.length, 1) / columns));
        grid.value = Array.from({ length: rows }, () => new Array(columns).fill(null));
        dirty.value = true;
      }

      function arrangeByStudentNo() {
        const columns = maxCols.value || 6;
        const ids = students.value.map((student) => student.id);
        const rows = Math.max(1, Math.ceil(Math.max(ids.length, 1) / columns));
        grid.value = Array.from({ length: rows }, (_, row) =>
          Array.from({ length: columns }, (_, col) => ids[row * columns + col] ?? null));
        dirty.value = true;
        ElMessage.success("已按学号顺序生成座次，可继续点击或拖拽调整");
      }

      function openCellEditor(row, col) {
        editingCell.value = { row, col };
        selectedStudentId.value = grid.value[row]?.[col] ?? null;
        cellDialog.value = true;
      }

      function assignSeat() {
        const { row, col } = editingCell.value;
        if (row < 0 || col < 0 || !grid.value[row]) return;
        const oldId = grid.value[row][col] ?? null;
        const newId = selectedStudentId.value ?? null;
        if (newId != null) {
          let fromRow = -1, fromCol = -1;
          grid.value.forEach((items, ri) => items.forEach((id, ci) => {
            if (id === newId) { fromRow = ri; fromCol = ci; }
          }));
          if (fromRow !== -1 && (fromRow !== row || fromCol !== col)) {
            grid.value[fromRow][fromCol] = oldId;
          }
        }
        grid.value[row][col] = newId;
        dirty.value = true;
        cellDialog.value = false;
      }

      function clearSeat(row, col) {
        grid.value[row][col] = null;
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
        store, grid, names, studentNos, students, unseatedStudents,
        planInfo, loading, dragId, hoverId, remark, dirty,
        history, historyVisible, maxCols, seatStudent, onDragStart, onDrop,
        onDragStartStudent, addRow, removeRow, addColumn, removeColumn,
        createBlankGrid, arrangeByStudentNo, cellDialog, editingCell,
        selectedStudentId, openCellEditor, assignSeat, clearSeat,
        savePlan, showHistory, restorePlan, onExport, hasSeats,
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
                  title="当前还没有已排座学生。点击“创建空白座次表”后逐个选择，或按学号顺序生成再拖拽调整。" />

        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0">
          <el-button type="primary" plain @click="createBlankGrid">创建空白座次表</el-button>
          <el-button @click="arrangeByStudentNo">按学号顺序排座</el-button>
          <el-divider direction="vertical" />
          <el-button size="small" @click="addRow">+ 一排</el-button>
          <el-button size="small" :disabled="grid.length <= 1" @click="removeRow">- 一排</el-button>
          <el-button size="small" @click="addColumn">+ 一列</el-button>
          <el-button size="small" :disabled="maxCols <= 1" @click="removeColumn">- 一列</el-button>
          <span style="color:#7a8194;font-size:13px">
            {{ grid.length }} 排 × {{ maxCols }} 列；未排座 {{ unseatedStudents.length }} 人
          </span>
        </div>

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
                   @drop="onDrop(ri, ci); hoverId = null"
                   @click="openCellEditor(ri, ci)">
                <template v-if="sid != null">
                  <div class="s-name">{{ names[sid] }}</div>
                  <div class="s-no">{{ studentNos[sid] || ('ID ' + sid) }}</div>
                  <el-button link type="danger" size="small"
                             style="position:absolute;right:3px;top:1px"
                             @click.stop="clearSeat(ri, ci)">×</el-button>
                </template>
                <template v-else><div style="color:#b8bfcd;font-size:12px">点击选择学生</div></template>
              </div>
            </template>
          </div>
        </div>

        <div class="seat-legend">
          <span>点击座位选择学生，也可拖拽换座</span>
          <span>当前版本：{{ planInfo.effective_date || '未保存' }}（备注：{{ planInfo.remark || '无' }}）</span>
          <el-button link type="primary" size="small" @click="addRow">+ 增加一排</el-button>
          <span style="flex:1"></span>
          <el-button type="success" :disabled="!dirty" @click="savePlan">保存座次（新版本）</el-button>
        </div>

        <div v-if="unseatedStudents.length" style="margin-top:14px;padding-top:12px;border-top:1px solid #ebeef5">
          <div style="font-size:13px;color:#606266;margin-bottom:8px">未排座学生（可拖到座位）：</div>
          <div style="display:flex;gap:7px;flex-wrap:wrap">
            <el-tag v-for="student in unseatedStudents" :key="student.id" draggable="true"
                    style="cursor:grab" @dragstart="onDragStartStudent(student.id)"
                    @dragend="dragId = null">
              {{ student.name }}（{{ student.student_no }}）
            </el-tag>
          </div>
        </div>
      </div>

      <!-- 点击座位手工选择学生 -->
      <el-dialog v-model="cellDialog" title="编辑座位" width="420px">
        <el-form label-width="80px">
          <el-form-item label="位置">
            第 {{ editingCell.row + 1 }} 排，第 {{ editingCell.col + 1 }} 列
          </el-form-item>
          <el-form-item label="学生">
            <el-select v-model="selectedStudentId" filterable clearable
                       placeholder="输入姓名或学号搜索；留空为空位" style="width:100%">
              <el-option v-for="student in students" :key="student.id"
                         :label="student.name + '（' + student.student_no + '）'"
                         :value="student.id" />
            </el-select>
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="cellDialog = false">取消</el-button>
          <el-button type="primary" @click="assignSeat">确定</el-button>
        </template>
      </el-dialog>

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
