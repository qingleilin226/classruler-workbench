/**
 * 模块1：学生名单（核心基础页）
 * 表格 + 按姓名/学号搜索 + 状态筛选 + 行内编辑（铅笔图标）+ 三步走导入 + 导出Excel
 */
(function () {
  const { ref, reactive, computed, onMounted, watch, nextTick } = Vue;

  window.StudentsView = {
    name: "StudentsView",
    components: { ImportModal: window.ImportModal },
    setup() {
      const store = window.useMainStore();
      const list = ref([]);
      const loading = ref(false);
      const query = reactive({ keyword: "", status: "" });
      const importVisible = ref(false);
      const editRow = ref(null);   // 正在编辑的学生行
      const editForm = reactive({ guardian_phone: "", address: "" });

      // ---- 批量选择 / 批量编辑 ----
      const tableRef = ref(null);  // el-table 实例（clearSelection）
      const selection = ref([]);   // 勾选行，仅由 @selection-change / clearSelection 驱动
      const batchDialog = ref(false);
      const batchField = ref("status");
      const batchValue = ref("在读");
      const FIELD_OPTS = [
        { value: "status", label: "状态" },
        { value: "gender", label: "性别" },
        { value: "guardian_phone", label: "监护人电话" },
        { value: "guardian_name", label: "监护人姓名" },
        { value: "address", label: "家庭住址" },
      ];
      const FIELD_DEFAULTS = { status: "在读", gender: "男", guardian_phone: "", guardian_name: "", address: "" };
      const FIELD_LABELS = { status: "状态", gender: "性别", guardian_phone: "监护人电话", guardian_name: "监护人姓名", address: "家庭住址" };

      const filtered = computed(() => {
        const kw = query.keyword.trim().toLowerCase();
        const st = query.status;
        return list.value.filter((s) => {
          if (st && s.status !== st) return false;
          if (kw && !(s.name.toLowerCase().includes(kw) || (s.student_no || "").toLowerCase().includes(kw))) return false;
          return true;
        });
      });

      async function load() {
        if (!store.currentClassId) {
          list.value = [];
          return;
        }
        loading.value = true;
        try {
          list.value = await window.api.get("/api/students", {
            class_id: store.currentClassId,
            keyword: query.keyword,
            status: query.status,
          });
        } finally {
          loading.value = false;
        }
        // 任何一次重载（搜索/筛选/换班/增删改后）都重置勾选，避免跨筛选残留
        await nextTick();
        clearSel();
      }

      onMounted(load);
      watch(() => store.currentClassId, load);

      // 行内编辑（铅笔）
      function startEdit(row) {
        editRow.value = row;
        editForm.guardian_phone = row.guardian_phone.replace(/\*\*\*\*/g, "");
        editForm.address = row.address;
      }

      async function saveEdit() {
        await window.api.put(`/api/students/${editRow.value.id}`, {
          guardian_phone: editForm.guardian_phone,
          address: editForm.address,
        });
        editRow.value = null;
        ElMessage.success("修改成功（姓名作为关联主键，全模块联动）");
        load();
      }

      function cancelEdit() {
        editRow.value = null;
      }

      async function removeStudent(row) {
        try {
          await ElMessageBox.confirm(
            `确定删除学生「${row.name}」吗？采用软删除，历史记录保留。`, "删除确认",
            { type: "warning", confirmButtonText: "删除", confirmButtonClass: "el-button--danger" });
        } catch (e) { return; }
        await window.api.del(`/api/students/${row.id}`);
        ElMessage.success("已删除（软删除）");
        load();
      }

      // ---- 批量选择 / 批量删除 / 批量编辑 ----
      function onSelectionChange(rows) {
        selection.value = rows;
      }

      function clearSel() {
        if (tableRef.value) tableRef.value.clearSelection();
      }

      function changeBatchField(f) {
        batchValue.value = FIELD_DEFAULTS[f];
      }

      // 行内编辑与批量操作隔离：选中的行里是否有人在行内编辑
      function editingRowSelected() {
        const id = editRow.value && editRow.value.id;
        return !!(id && selection.value.some((r) => r.id === id));
      }

      async function openBatchDelete() {
        if (editingRowSelected()) {
          ElMessage.warning("有正在行内编辑的选中行，请先保存或取消该行");
          return;
        }
        const names = selection.value.map((s) => s.name);
        const preview = names.slice(0, 5).join("、") + (names.length > 5 ? " 等" : "");
        try {
          await ElMessageBox.confirm(
            `确定批量删除选中的 ${selection.value.length} 名学生吗？\n（${preview}）\n采用软删除，历史记录保留。`, "批量删除确认",
            { type: "warning", confirmButtonText: "删除", confirmButtonClass: "el-button--danger" });
        } catch (e) { return; }
        await window.api.post("/api/students/batch-delete", { ids: selection.value.map((s) => s.id) });
        ElMessage.success(`已删除 ${selection.value.length} 名学生（软删除）`);
        clearSel();
        load();
      }

      function openBatchEdit() {
        if (editingRowSelected()) {
          ElMessage.warning("有正在行内编辑的选中行，请先保存或取消该行");
          return;
        }
        batchField.value = "status";
        batchValue.value = "在读";
        batchDialog.value = true;
      }

      async function submitBatchEdit() {
        if (!batchValue.value && (batchField.value === "status" || batchField.value === "gender")) {
          ElMessage.warning("请选择要设置的值");
          return;
        }
        await window.api.post("/api/students/batch-update", {
          ids: selection.value.map((s) => s.id),
          [batchField.value]: batchValue.value,   // 空字符串 = 清空该字段
        });
        ElMessage.success(`已将「${FIELD_LABELS[batchField.value]}」批量更新为「${batchValue.value || "空"}」，共 ${selection.value.length} 人`);
        batchDialog.value = false;
        clearSel();
        load();
      }

      async function onExport() {
        await window.api.download("/api/students/export", {
          class_id: store.currentClassId,
          keyword: query.keyword,
          status: query.status,
        }, `学生名单_${store.currentClass?.name || ""}.xlsx`);
      }

      function onImported() {
        load();
        // 多工作表导入可能导入了多个班级 → 刷新顶部班级列表（人数/下拉）
        if (store.loadClasses) store.loadClasses().catch(() => {});
      }

      return {
        store, list, loading, query, filtered, importVisible, editRow, editForm,
        tableRef, selection, batchDialog, batchField, batchValue,
        FIELD_OPTS, FIELD_LABELS,
        load, startEdit, saveEdit, cancelEdit, removeStudent, onExport, onImported,
        onSelectionChange, clearSel, changeBatchField,
        openBatchDelete, openBatchEdit, submitBatchEdit,
      };
    },
    template: `
    <div>
      <div class="page-card">
        <div class="page-toolbar">
          <el-input v-model="query.keyword" placeholder="按姓名 / 学号搜索" clearable
                    :prefix-icon="'Search'" @input="load" @clear="load" />
          <el-select v-model="query.status" placeholder="按状态筛选" clearable style="width:130px"
                     @change="load">
            <el-option label="在读" value="在读" />
            <el-option label="休学" value="休学" />
            <el-option label="转学" value="转学" />
          </el-select>
          <div style="flex:1"></div>
          <el-button type="primary" :icon="'Plus'" @click="importVisible = true">导入学生</el-button>
          <el-button :icon="'Download'" @click="onExport">导出为Excel</el-button>
        </div>

        <div v-if="selection.length"
             style="display:flex;align-items:center;gap:12px;background:#f5f7fa;border-radius:6px;padding:8px 12px;margin:0 0 10px">
          <span style="color:#2b5da8;font-weight:600">已选 {{ selection.length }} 人</span>
          <el-button type="primary" size="small" @click="openBatchEdit">批量编辑</el-button>
          <el-button type="danger" size="small" @click="openBatchDelete">批量删除</el-button>
          <el-button size="small" @click="clearSel">清空选择</el-button>
          <span style="color:#909399;font-size:12px">勾选表头可全选当前筛选结果；筛选/刷新后自动清空选择</span>
        </div>

        <el-table ref="tableRef" v-loading="loading" :data="filtered" border stripe size="default"
                  @selection-change="onSelectionChange">
          <el-table-column type="selection" width="48"
                           :selectable="(row) => !(editRow && editRow.id === row.id)" />
          <el-table-column prop="student_no" label="学号" width="110" />
          <el-table-column prop="name" label="姓名" width="110" />
          <el-table-column prop="gender" label="性别" width="70" align="center" />
          <el-table-column prop="birth_date" label="出生日期" width="120" />
          <el-table-column prop="status" label="状态" width="90" align="center">
            <template #default="{ row }">
              <el-tag :type="row.status === '在读' ? 'success' : row.status === '休学' ? 'warning' : 'info'" size="small">
                {{ row.status }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="guardian_name" label="监护人" width="110" />
          <el-table-column label="监护人电话（可编辑）" min-width="170">
            <template #default="{ row }">
              <template v-if="editRow && editRow.id === row.id">
                <el-input v-model="editForm.guardian_phone" size="small" placeholder="完整手机号" />
              </template>
              <template v-else>{{ row.guardian_phone || '—' }}</template>
            </template>
          </el-table-column>
          <el-table-column label="家庭住址（备注）" min-width="180">
            <template #default="{ row }">
              <template v-if="editRow && editRow.id === row.id">
                <el-input v-model="editForm.address" size="small" placeholder="家庭住址" />
              </template>
              <template v-else>{{ row.address || '—' }}</template>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="200" align="center" fixed="right">
            <template #default="{ row }">
              <template v-if="editRow && editRow.id === row.id">
                <el-button size="small" type="primary" @click="saveEdit">保存</el-button>
                <el-button size="small" @click="cancelEdit">取消</el-button>
              </template>
              <template v-else>
                <el-tooltip content="编辑联系电话/住址">
                  <el-button size="small" :icon="'Edit'" circle @click="startEdit(row)" />
                </el-tooltip>
                <el-tooltip content="删除（软删除）">
                  <el-button size="small" type="danger" :icon="'Delete'" circle @click="removeStudent(row)" />
                </el-tooltip>
              </template>
            </template>
          </el-table-column>
        </el-table>
        <div style="color:#909399;font-size:12px;margin-top:8px">
          共 {{ filtered.length }} 人（含筛选）。姓名作为全模块关联主键，修改后座次/成绩/值日/班委自动联动。
        </div>
      </div>

      <import-modal v-model="importVisible" target="students"
                    :extra="{ class_id: store.currentClassId }"
                    title="导入学生名单"
                    @success="onImported" />

      <el-dialog v-model="batchDialog" title="批量编辑学生" width="480px">
        <div style="color:#7a8194;font-size:13px;margin-bottom:12px">
          为选中的 {{ selection.length }} 名学生统一设置同一字段。监护人电话为覆盖式修改，原号码已脱敏不可见。
        </div>
        <el-form label-width="90px">
          <el-form-item label="选择字段">
            <el-select v-model="batchField" style="width:100%" @change="changeBatchField">
              <el-option v-for="o in FIELD_OPTS" :key="o.value" :label="o.label" :value="o.value" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="batchField === 'status'" label="设置值">
            <el-select v-model="batchValue" style="width:100%">
              <el-option v-for="s in ['在读','休学','转学']" :key="s" :label="s" :value="s" />
            </el-select>
          </el-form-item>
          <el-form-item v-else-if="batchField === 'gender'" label="设置值">
            <el-radio-group v-model="batchValue">
              <el-radio-button label="男">男</el-radio-button>
              <el-radio-button label="女">女</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item v-else-if="batchField === 'guardian_phone'" label="手机号">
            <el-input v-model="batchValue" maxlength="11" clearable
                      placeholder="输入完整手机号，将覆盖所选学生原号码；留空则清空" />
          </el-form-item>
          <el-form-item v-else-if="batchField === 'guardian_name'" label="监护人姓名">
            <el-input v-model="batchValue" maxlength="64" placeholder="输入监护人姓名（留空则清空）" />
          </el-form-item>
          <el-form-item v-else label="家庭住址">
            <el-input v-model="batchValue" type="textarea" :rows="2" maxlength="255"
                      placeholder="输入家庭住址（留空则清空）" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="batchDialog = false">取消</el-button>
          <el-button type="primary" @click="submitBatchEdit">确认批量修改</el-button>
        </template>
      </el-dialog>
    </div>
    `,
  };
})();
