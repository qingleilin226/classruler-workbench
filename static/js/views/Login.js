/**
 * 登录页：默认账号 admin / admin123（见 .env 可修改）。
 */
(function () {
  const { ref, reactive } = Vue;

  window.LoginView = {
    name: "LoginView",
    setup() {
      const store = window.useMainStore();
      const form = reactive({ username: "admin", password: "" });
      const loading = ref(false);

      async function onLogin() {
        if (!form.username || !form.password) {
          ElMessage.warning("请输入用户名和密码");
          return;
        }
        loading.value = true;
        try {
          const data = await window.api.post("/api/auth/login", form);
          store.token = data.token;
          store.user = { username: data.username, display_name: data.display_name };
          window.api.setToken(data.token);
          await store.loadClasses();
          location.hash = "/dashboard";
          ElMessage.success("欢迎回来，班主任！");
        } catch (e) { /* Toast 已提示 */ } finally {
          loading.value = false;
        }
      }

      return { form, loading, onLogin };
    },
    template: `
    <div class="login-page">
      <div class="login-card">
        <div class="login-title">班主任工作台</div>
        <div class="login-sub">班级日常事务一体化管理系统 · 私有化部署</div>
        <el-form @submit.prevent="onLogin">
          <el-form-item>
            <el-input v-model="form.username" placeholder="用户名" size="large"
                      :prefix-icon="'User'" />
          </el-form-item>
          <el-form-item>
            <el-input v-model="form.password" type="password" placeholder="密码" size="large"
                      :prefix-icon="'Lock'" show-password @keyup.enter="onLogin" />
          </el-form-item>
          <el-button type="primary" size="large" style="width:100%;font-weight:600"
                     :loading="loading" @click="onLogin">
            登 录
          </el-button>
        </el-form>
        <div style="margin-top:16px;font-size:12px;color:#909399;text-align:center">
          默认账号：admin　密码：admin123（可在 .env 中修改）
        </div>
      </div>
    </div>
    `,
  };
})();
