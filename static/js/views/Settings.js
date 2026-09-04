/**
 * 班级学期与设置：班级管理（多班级可扩展）、学期管理（激活切换）、修改密码。
 */
(function () {
  const { ref, reactive, onMounted } = Vue;

  window.SettingsView = {
    name: "SettingsView",
    setup() {
      const store = window.useMainStore();
      const classDialog = ref(false);
      const classForm = reactive({ grade: "", name: "", academic_year: "" });
      const semesterDialog = ref(false);
      const semesterForm = reactive({ class_id: null, name: "", start_date: "", end_date: "", is_active: false });
      const pwdDialog = ref(false);
      const pwdForm = reactive({ old_password: "", new_password: "" });
      const profileDialog = ref(false);
      const profileForm = reactive({ display_name: "" });
      const saving = ref(false);

      async function addClass() {
        if (!classForm.name || !classForm.grade || !classForm.academic_year) {
          ElMessage.warning("请填写 年级/班级名称/学年");
          return;
        }
        saving.value = true;
        try {
          await window.api.post("/api/classes", classForm);
          ElMessage.success("班级创建成功，已自动生成两个学期");
          classDialog.value = false;
          Object.assign(classForm, { grade: "", name: "", academic_year: "" });
          await store.loadClasses();
        } finally {
          saving.value = false;
        }
      }

      function openSemesterDialog() {
        semesterForm.class_id = store.currentClassId;
        semesterDialog.value = true;
      }

      async function addSemester() {
        if (!semesterForm.name || !semesterForm.start_date || !semesterForm.end_date) {
          ElMessage.warning("请完整填写学期信息");
          return;
        }
        saving.value = true;
        try {
          await window.api.post("/api/classes/semesters", semesterForm);
          ElMessage.success("学期创建成功");
          semesterDialog.value = false;
          Object.assign(semesterForm, { name: "", start_date: "", end_date: "", is_active: false });
          await store.loadSemesters();
        } finally {
          saving.value = false;
        }
      }

      async function activateSemester(sem) {
        await window.api.post(`/api/classes/${store.currentClassId}/semesters/activate`,
          { semester_id: sem.id });
        ElMessage.success(`已切换为「${sem.name}」`);
        await store.loadSemesters();
      }

      async function deleteClass(row) {
        try {
          await ElMessageBox.confirm(
            `确定删除班级「${row.name}」吗？该班级将从工作台隐藏，学生和历史数据仍会保留。`,
            "删除班级", { type: "warning", confirmButtonText: "删除" });
        } catch (e) { return; }
        await window.api.del(`/api/classes/${row.id}`);
        ElMessage.success("班级已删除");
        await store.loadClasses();
      }

      async function deleteSemester(row) {
        try {
          await ElMessageBox.confirm(
            `确定删除学期「${row.name}」吗？该学期将被隐藏，关联的考试、座次和课表历史仍会保留。`,
            "删除学期", { type: "warning", confirmButtonText: "删除" });
        } catch (e) { return; }
        await window.api.del(`/api/classes/${store.currentClassId}/semesters/${row.id}`);
        ElMessage.success("学期已删除");
        await store.loadClasses();
      }

      function openProfileDialog() {
        profileForm.display_name = store.user?.display_name || "";
        profileDialog.value = true;
      }

      async function updateProfile() {
        const displayName = profileForm.display_name.trim();
        if (!displayName) {
          ElMessage.warning("用户名称不能为空");
          return;
        }
        saving.value = true;
        try {
          const user = await window.api.put("/api/auth/profile", { display_name: displayName });
          store.user = user;
          profileDialog.value = false;
          ElMessage.success("用户名称已修改");
        } finally {
          saving.value = false;
        }
      }

      async function changePassword() {
        if (!pwdForm.old_password || !pwdForm.new_password) {
          ElMessage.warning("请填写原密码和新密码");
          return;
        }
        if (pwdForm.new_password.length < 6) {
          ElMessage.warning("新密码至少 6 位");
          return;
        }
        saving.value = true;
        try {
          await window.api.post("/api/auth/change-password", pwdForm);
          ElMessage.success("密码修改成功，下次登录请使用新密码");
          pwdDialog.value = false;
          pwdForm.old_password = "";
          pwdForm.new_password = "";
        } finally {
          saving.value = false;
        }
      }

      onMounted(() => { store.loadClasses(); });

      return { store, classDialog, classForm, semesterDialog, semesterForm, pwdDialog,
               pwdForm, profileDialog, profileForm, saving, addClass, openSemesterDialog,
               addSemester, activateSemester, deleteClass, deleteSemester,
               openProfileDialog, updateProfile, changePassword };
    },
    template: `
    <div>
      <!-- 班级管理 -->
      <div class="page-card">
        <div class="page-toolbar">
          <span style="font-weight:600;font-size:15px">班级管理（默认预设 3 个班级，可扩展）</span>
          <div style="flex:1"></div>
          <el-button type="primary" :icon="'Plus'" @click="classDialog = true">新增班级</el-button>
        </div>
        <el-table :data="store.classes" border>
          <el-table-column prop="name" label="班级名称" width="140" />
          <el-table-column prop="grade" label="年级" width="120" />
          <el-table-column prop="academic_year" label="学年" width="120" />
          <el-table-column prop="student_count" label="学生数" width="100" align="center" />
          <el-table-column label="当前选中" width="120" align="center">
            <template #default="{ row }">
              <el-tag v-if="store.currentClassId === row.id" type="success" size="small">工作台当前班级</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="180" align="center">
            <template #default="{ row }">
              <el-button link type="primary" @click="store.switchClass(row.id)">切换使用</el-button>
              <el-button link type="danger" @click="deleteClass(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <!-- 学期管理 -->
      <div class="page-card">
        <div class="page-toolbar">
          <span style="font-weight:600;font-size:15px">学期管理（{{ store.currentClass?.name || '—' }}）</span>
          <div style="flex:1"></div>
          <el-button :icon="'Plus'" @click="openSemesterDialog">新增学期</el-button>
        </div>
        <el-table :data="store.semesters" border>
          <el-table-column prop="name" label="学期名称" width="140" />
          <el-table-column prop="start_date" label="开始日期" width="130" />
          <el-table-column prop="end_date" label="结束日期" width="130" />
          <el-table-column label="状态" width="120" align="center">
            <template #default="{ row }">
              <el-tag v-if="row.is_active" type="success" size="small">已激活（唯一）</el-tag>
              <el-tag v-else type="info" size="small">未激活</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="180" align="center">
            <template #default="{ row }">
              <el-button v-if="!row.is_active" link type="primary"
                         @click="activateSemester(row)">设为激活</el-button>
              <el-button link type="danger" @click="deleteSemester(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div style="color:#909399;font-size:12px;margin-top:8px">
          同一班级最多一个激活学期（数据库部分唯一索引兜底）。所有模块的数据均按「班级 + 学期」两个维度关联。
        </div>
      </div>

      <!-- 账号与备份 -->
      <div class="page-card">
        <div style="font-weight:600;font-size:15px;margin-bottom:12px">账号与数据安全</div>
        <div style="display:flex;gap:12px;align-items:center">
          <el-button :icon="'User'" @click="openProfileDialog">修改用户名称</el-button>
          <el-button :icon="'Lock'" @click="pwdDialog = true">修改登录密码</el-button>
          <span style="color:#7a8194;font-size:13px">
            当前账号：{{ store.user?.username }}（{{ store.user?.display_name }}）
            · 每日凌晨自动备份数据库到 ./backup 目录，保留最近 30 份
          </span>
        </div>
      </div>

      <!-- 新增班级 -->
      <el-dialog v-model="classDialog" title="新增班级" width="440px">
        <el-form label-width="90px">
          <el-form-item label="年级"><el-input v-model="classForm.grade" placeholder="如：2024级" /></el-form-item>
          <el-form-item label="班级名称"><el-input v-model="classForm.name" placeholder="如：2024级3班" /></el-form-item>
          <el-form-item label="学年"><el-input v-model="classForm.academic_year" placeholder="如：2024-2025" /></el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="classDialog = false">取消</el-button>
          <el-button type="primary" :loading="saving" @click="addClass">创建</el-button>
        </template>
      </el-dialog>

      <!-- 新增学期 -->
      <el-dialog v-model="semesterDialog" title="新增学期" width="440px">
        <el-form label-width="90px">
          <el-form-item label="学期名称"><el-input v-model="semesterForm.name" placeholder="如：第三学期" /></el-form-item>
          <el-form-item label="开始日期">
            <el-date-picker v-model="semesterForm.start_date" type="date" value-format="YYYY-MM-DD" style="width:100%" />
          </el-form-item>
          <el-form-item label="结束日期">
            <el-date-picker v-model="semesterForm.end_date" type="date" value-format="YYYY-MM-DD" style="width:100%" />
          </el-form-item>
          <el-form-item label="设为激活">
            <el-switch v-model="semesterForm.is_active" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="semesterDialog = false">取消</el-button>
          <el-button type="primary" :loading="saving" @click="addSemester">创建</el-button>
        </template>
      </el-dialog>

      <!-- 修改用户显示名称 -->
      <el-dialog v-model="profileDialog" title="修改用户名称" width="420px">
        <el-form label-width="90px">
          <el-form-item label="登录账号">
            <el-input :model-value="store.user?.username" disabled />
          </el-form-item>
          <el-form-item label="显示名称" required>
            <el-input v-model="profileForm.display_name" maxlength="64" show-word-limit
                      placeholder="例如：张老师" @keyup.enter="updateProfile" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="profileDialog = false">取消</el-button>
          <el-button type="primary" :loading="saving" @click="updateProfile">保存</el-button>
        </template>
      </el-dialog>

      <!-- 修改密码 -->
      <el-dialog v-model="pwdDialog" title="修改登录密码" width="420px">
        <el-form label-width="90px">
          <el-form-item label="原密码">
            <el-input v-model="pwdForm.old_password" type="password" show-password />
          </el-form-item>
          <el-form-item label="新密码">
            <el-input v-model="pwdForm.new_password" type="password" show-password placeholder="至少 6 位" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="pwdDialog = false">取消</el-button>
          <el-button type="primary" :loading="saving" @click="changePassword">确认修改</el-button>
        </template>
      </el-dialog>
    </div>
    `,
  };
})();
