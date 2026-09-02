/**
 * 模块1：学生名单（核心基础页）
 * 表格 + 按姓名/学号搜索 + 状态筛选 + 行内编辑（铅笔图标）+ 三步走导入 + 导出Excel
 */
(function () {
  const { ref, reactive, computed, onMounted, watch } = Vue;

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

      async function onExport() {
        await window.api.download("/api/students/export", {
          class_id: store.currentClassId,
          keyword: query.keyword,
          status: query.status,
        }, `学生名单_${store.currentClass?.name || ""}.xlsx`);
      }

      function onImported() {
        load();
      }

      return {
        store, list, loading, query, filtered, importVisible, editRow, editForm,
        load, startEdit, saveEdit, cancelEdit, removeStudent, onExport, onImported,
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

        <el-table v-loading="loading" :data="filtered" border stripe size="default">
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
    </div>
    `,
  };
})();
