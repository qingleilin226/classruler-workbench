/**
 * 模块5：班委名单
 * 职位卡片墙 + 任职起止日期 + 一键导出任职证明（HTML 打印版）
 */
(function () {
  const { ref, reactive, onMounted, watch } = Vue;

  window.CommitteeView = {
    name: "CommitteeView",
    setup() {
      const store = window.useMainStore();
      const list = ref([]);
      const loading = ref(false);
      const dialogVisible = ref(false);
      const students = ref([]);
      const form = reactive({ id: null, student_id: null, position: "班长", start_date: "", end_date: "" });
      const editing = ref(false);

      const POSITIONS = ["班长", "副班长", "学习委员", "纪律委员", "卫生委员", "体育委员",
        "文艺委员", "生活委员", "宣传委员", "心理委员"];

      async function load() {
        if (!store.currentClassId) {
          list.value = [];
          return;
        }
        loading.value = true;
        try {
          list.value = await window.api.get("/api/committee", { class_id: store.currentClassId });
        } finally {
          loading.value = false;
        }
      }

      onMounted(load);
      watch(() => store.currentClassId, load);

      async function openAdd() {
        students.value = await window.api.get("/api/students", { class_id: store.currentClassId });
        if (!students.value.length) {
          ElMessage.warning("本班还没有学生，请先导入学生名单");
          return;
        }
        Object.assign(form, { id: null, student_id: null, position: "班长", start_date: "", end_date: "" });
        editing.value = false;
        dialogVisible.value = true;
      }

      function openEdit(row) {
        Object.assign(form, {
          id: row.id, student_id: row.student_id, position: row.position,
          start_date: row.start_date, end_date: row.end_date,
        });
        editing.value = true;
        dialogVisible.value = true;
      }

      async function save() {
        if (!form.student_id || !form.position) {
          ElMessage.warning("请选择学生和职位");
          return;
        }
        const payload = {
          class_id: store.currentClassId, student_id: form.student_id,
          position: form.position, start_date: form.start_date || undefined,
          end_date: form.end_date || undefined,
        };
        if (editing.value) {
          await window.api.put(`/api/committee/${form.id}`, payload);
          ElMessage.success("任职信息已更新");
        } else {
          await window.api.post("/api/committee", payload);
          ElMessage.success("任命成功");
        }
        dialogVisible.value = false;
        load();
      }

      async function remove(row) {
        try {
          await ElMessageBox.confirm(
            `确定免去 ${row.student_name} 的「${row.position}」职务吗？（软删除）`,
            "免职确认", { type: "warning", confirmButtonText: "免职" });
        } catch (e) { return; }
        await window.api.del(`/api/committee/${row.id}`);
        ElMessage.success("已免职");
        load();
      }

      async function printCertificate(row) {
        const res = await fetch(`/api/committee/${row.id}/certificate`, {
          headers: { Authorization: "Bearer " + window.api.getToken() },
        });
        if (!res.ok) {
          ElMessage.error("生成任职证明失败");
          return;
        }
        const html = await res.text();
        window.utils.openPrintWindow(html);
      }

      return { store, list, loading, dialogVisible, students, form, editing, POSITIONS,
               openAdd, openEdit, save, remove, printCertificate };
    },
    template: `
    <div>
      <div class="page-card">
        <div class="page-toolbar">
          <div style="flex:1"></div>
          <el-button type="primary" :icon="'Plus'" @click="openAdd">任命班委</el-button>
        </div>

        <el-empty v-if="!list.length" description="还没有班委记录，点击右上角「任命班委」" />

        <div class="committee-wall">
          <div v-for="row in list" :key="row.id" class="committee-card">
            <div class="c-actions">
              <el-tooltip content="编辑">
                <el-button size="small" :icon="'Edit'" circle @click="openEdit(row)" />
              </el-tooltip>
              <el-tooltip content="免职">
                <el-button size="small" type="danger" :icon="'Delete'" circle @click="remove(row)" />
              </el-tooltip>
              <el-tooltip content="导出任职证明">
                <el-button size="small" type="warning" :icon="'Document'" circle
                           @click="printCertificate(row)" />
              </el-tooltip>
            </div>
            <div class="c-position">{{ row.position }}</div>
            <div class="c-name">{{ row.student_name }}</div>
            <div class="c-period">
              任职期：{{ row.start_date }} 至 {{ row.end_date || '（至今）' }}
            </div>
          </div>
        </div>
      </div>

      <el-dialog v-model="dialogVisible" :title="editing ? '编辑任职信息' : '任命班委'" width="480px">
        <el-form label-width="90px">
          <el-form-item label="学生">
            <el-select v-model="form.student_id" filterable style="width:100%">
              <el-option v-for="s in students" :key="s.id"
                         :label="s.name + '（' + s.student_no + '）'" :value="s.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="职位">
            <el-select v-model="form.position" style="width:100%">
              <el-option v-for="p in POSITIONS" :key="p" :label="p" :value="p" />
            </el-select>
          </el-form-item>
          <el-form-item label="开始日期">
            <el-date-picker v-model="form.start_date" type="date" value-format="YYYY-MM-DD"
                            style="width:100%" placeholder="任职开始日期" />
          </el-form-item>
          <el-form-item label="结束日期">
            <el-date-picker v-model="form.end_date" type="date" value-format="YYYY-MM-DD"
                            style="width:100%" placeholder="留空表示至今" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" @click="save">{{ editing ? '保存修改' : '确认任命' }}</el-button>
        </template>
      </el-dialog>
    </div>
    `,
  };
})();
