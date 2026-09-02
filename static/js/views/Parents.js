/**
 * 模块6：家长联系方式（隐私保护）
 * 默认显示姓名、关系；手机号中间4位 ****；
 * 点击「显示号码」→ 输入当前登录密码（二次确认）→ 方可查看完整号码。
 */
(function () {
  const { ref, onMounted, watch } = Vue;

  window.ParentsView = {
    name: "ParentsView",
    setup() {
      const store = window.useMainStore();
      const list = ref([]);
      const loading = ref(false);
      const passwordDialog = ref(false);
      const password = ref("");
      const verifying = ref(false);

      async function load() {
        if (!store.currentClassId) {
          list.value = [];
          return;
        }
        loading.value = true;
        try {
          list.value = await window.api.get("/api/parents", { class_id: store.currentClassId });
        } finally {
          loading.value = false;
        }
      }

      onMounted(load);
      watch(() => store.currentClassId, load);

      async function verifyAndReveal() {
        if (!password.value) {
          ElMessage.warning("请输入当前登录密码");
          return;
        }
        verifying.value = true;
        try {
          await window.api.post("/api/auth/verify-password", { password: password.value });
          // 密码正确 → 拉取明文
          const data = await window.api.post(
            `/api/parents/reveal?class_id=${store.currentClassId}`,
            { password: password.value });
          list.value = data;
          passwordDialog.value = false;
          password.value = "";
          ElMessage.success("验证通过，已显示完整号码（请勿外泄）");
        } catch (e) { /* 密码错误 Toast 已提示 */ } finally {
          verifying.value = false;
        }
      }

      function closeDialog() {
        passwordDialog.value = false;
        password.value = "";
      }

      function copyPhone(row) {
        if (!row.revealed) {
          ElMessage.warning("请先验证密码查看完整号码");
          return;
        }
        navigator.clipboard.writeText(row.phone);
        ElMessage.success("号码已复制到剪贴板");
      }

      async function onExport() {
        await window.api.download("/api/parents/export", {
          class_id: store.currentClassId,
        }, `家长联系方式_${store.currentClass?.name || ""}.xlsx`);
      }

      return { store, list, loading, passwordDialog, password, verifying, load,
               verifyAndReveal, closeDialog, copyPhone, onExport };
    },
    template: `
    <div>
      <div class="page-card">
        <div class="page-toolbar">
          <el-alert type="info" show-icon :closable="false" style="flex:1"
                    title="隐私保护：手机号默认显示为 138****0000，查看完整号码必须输入当前登录密码二次确认。" />
          <el-button type="primary" :icon="'View'" @click="passwordDialog = true">显示号码（需密码）</el-button>
          <el-button :icon="'Download'" @click="onExport">导出为Excel（脱敏）</el-button>
        </div>

        <el-table v-loading="loading" :data="list" border stripe>
          <el-table-column prop="student_no" label="学号" width="110" />
          <el-table-column prop="student_name" label="学生姓名" width="120" />
          <el-table-column prop="guardian_name" label="监护人（关系）" min-width="130" />
          <el-table-column label="手机号" min-width="200">
            <template #default="{ row }">
              <template v-if="row.revealed">
                <b style="color:#2b5da8">{{ row.phone }}</b>
                <el-tag size="small" type="success" style="margin-left:8px">已验证显示</el-tag>
                <el-button link type="primary" size="small" style="margin-left:6px"
                           @click="copyPhone(row)">复制</el-button>
              </template>
              <template v-else>
                <span style="letter-spacing:1px">{{ row.phone }}</span>
              </template>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="110" align="center">
            <template #default="{ row }">
              <el-button size="small" type="primary" plain :disabled="row.revealed"
                         @click="passwordDialog = true">显示号码</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div style="color:#909399;font-size:12px;margin-top:8px">
          共 {{ list.length }} 位家长联系方式。导出文件中的号码为脱敏格式，防止数据外泄。
        </div>
      </div>

      <!-- 二次确认弹窗 -->
      <el-dialog v-model="passwordDialog" title="隐私验证：查看完整号码" width="420px" :close-on-click-modal="false">
        <el-alert type="warning" show-icon :closable="false" style="margin-bottom:14px"
                  title="请输入当前登录密码以验证身份" />
        <el-input v-model="password" type="password" placeholder="登录密码" size="large"
                  show-password @keyup.enter="verifyAndReveal" />
        <template #footer>
          <el-button @click="closeDialog">取消</el-button>
          <el-button type="primary" :loading="verifying" @click="verifyAndReveal">验证并显示</el-button>
        </template>
      </el-dialog>
    </div>
    `,
  };
})();
