/**
 * 模块4：成绩分析（数据看板）
 * 上：筛选（考试、科目）；下三部分：① 统计卡片 ② ECharts 分数分布柱状图 ③ 学生明细表
 * 支持 Excel 多Sheet导入（列名→科目）、手动逐行录入。
 */
(function () {
  const { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } = Vue;

  window.ExamsView = {
    name: "ExamsView",
    components: { ImportModal: window.ImportModal },
    setup() {
      const store = window.useMainStore();
      const exams = ref([]);
      const examId = ref(null);
      const subject = ref("");
      const analysis = ref(null);
      const loading = ref(false);
      const chartEl = ref(null);
      let chart = null;
      const importVisible = ref(false);
      const importSetupDialog = ref(false);
      const importMode = ref("new");
      const importForm = reactive({ exam_id: null, name: "", exam_date: "" });
      const importExtra = computed(() => importMode.value === "existing"
        ? {
            class_id: store.currentClassId,
            semester_id: store.currentSemesterId,
            exam_id: importForm.exam_id,
          }
        : {
            class_id: store.currentClassId,
            semester_id: store.currentSemesterId,
            exam_id: null,
            exam_name: importForm.name.trim(),
            exam_date: importForm.exam_date,
          });
      const addDialog = ref(false);
      const addForm = reactive({ name: "", exam_date: "", subjects: "语文,数学,英语" });
      const manualDialog = ref(false);
      const manualForm = reactive({ student_id: null, subject: "", score: null });
      const students = ref([]);
      const subjectsOfExam = ref([]);
      const personalDialog = ref(false);
      const personalLoading = ref(false);
      const personalStudentId = ref(null);
      const personalSubject = ref("");
      const personalData = ref(null);
      const personalChartEl = ref(null);
      let personalChart = null;

      async function loadExams() {
        if (!store.currentClassId || !store.currentSemesterId) {
          exams.value = [];
          return;
        }
        exams.value = await window.api.get("/api/exams", {
          class_id: store.currentClassId, semester_id: store.currentSemesterId });
        if (exams.value.length && !exams.value.find((e) => e.id === examId.value)) {
          examId.value = exams.value[0].id;
        }
        if (examId.value) await loadAnalysis();
      }

      async function loadAnalysis() {
        if (!examId.value) {
          analysis.value = null;
          return;
        }
        loading.value = true;
        try {
          analysis.value = await window.api.get("/api/exams/analysis", {
            exam_id: examId.value, subject: subject.value });
          subjectsOfExam.value = analysis.value.subjects || [];
          nextTick(() => renderChart());
        } finally {
          loading.value = false;
        }
      }

      function renderChart() {
        if (typeof echarts === "undefined" || !chartEl.value || !analysis.value) return;
        if (!chart) chart = echarts.init(chartEl.value);
        const dist = analysis.value.distribution || [];
        chart.setOption({
          tooltip: { trigger: "axis" },
          grid: { left: 40, right: 20, top: 30, bottom: 30 },
          xAxis: { type: "category", data: dist.map((d) => d.range) },
          yAxis: { type: "value", minInterval: 1 },
          series: [{
            name: "人数", type: "bar", data: dist.map((d) => d.count),
            itemStyle: { color: "#2b5da8", borderRadius: [4, 4, 0, 0] },
            barWidth: 36,
            label: { show: true, position: "top" },
          }],
        });
      }

      const onResize = () => {
        if (chart) chart.resize();
        if (personalChart) personalChart.resize();
      };
      onMounted(() => {
        window.addEventListener("resize", onResize);
        loadExams();
      });
      onUnmounted(() => {
        window.removeEventListener("resize", onResize);
        if (chart) chart.dispose();
        chart = null;
        if (personalChart) personalChart.dispose();
        personalChart = null;
      });
      watch(() => [store.currentClassId, store.currentSemesterId], loadExams);
      watch([examId, subject], loadAnalysis);
      watch(personalSubject, () => nextTick(renderPersonalChart));

      async function onExport() {
        if (!examId.value) {
          ElMessage.warning("请先选择考试");
          return;
        }
        await window.api.download("/api/exams/export", {
          exam_id: examId.value, subject: subject.value,
        }, `成绩分析_${exams.value.find((e) => e.id === examId.value)?.name || ""}.xlsx`);
      }

      async function addExam() {
        if (!addForm.name || !addForm.exam_date) {
          ElMessage.warning("请填写考试名称并选择实际考试日期");
          return;
        }
        await window.api.post("/api/exams", {
          class_id: store.currentClassId,
          semester_id: store.currentSemesterId,
          name: addForm.name,
          exam_date: addForm.exam_date,
          subjects: addForm.subjects.split(/[,，、]/).map((s) => s.trim()).filter(Boolean),
        });
        ElMessage.success("考试创建成功，可手动录入或导入成绩");
        addDialog.value = false;
        addForm.name = "";
        loadExams();
      }

      function openImportSetup() {
        if (!store.currentClassId || !store.currentSemesterId) {
          ElMessage.warning("请先选择班级和学期");
          return;
        }
        importMode.value = "new";
        importForm.exam_id = examId.value;
        importForm.name = "";
        importForm.exam_date = "";
        importSetupDialog.value = true;
      }

      function startImport() {
        if (importMode.value === "new") {
          if (!importForm.name.trim() || !importForm.exam_date) {
            ElMessage.warning("新建考试必须填写考试名称并选择实际考试日期");
            return;
          }
        } else if (!importForm.exam_id) {
          ElMessage.warning("请选择要导入成绩的已有考试");
          return;
        }
        importSetupDialog.value = false;
        nextTick(() => (importVisible.value = true));
      }

      async function loadStudents() {
        students.value = await window.api.get("/api/students", {
          class_id: store.currentClassId });
      }

      async function openPersonalAnalysis() {
        if (!store.currentClassId) {
          ElMessage.warning("请先选择班级");
          return;
        }
        personalStudentId.value = null;
        personalSubject.value = "";
        personalData.value = null;
        personalDialog.value = true;
        await loadStudents();
      }

      async function loadPersonalHistory() {
        if (!personalStudentId.value) {
          personalData.value = null;
          return;
        }
        personalLoading.value = true;
        try {
          personalData.value = await window.api.get("/api/exams/student-history", {
            class_id: store.currentClassId,
            student_id: personalStudentId.value,
          });
          const subjects = personalData.value.subjects || [];
          const preferred = ["六门总分", "总分", "语数英总分"];
          personalSubject.value = preferred.find((item) => subjects.includes(item))
            || subjects.find((item) => item.includes("总分")) || subjects[0] || "";
          nextTick(renderPersonalChart);
        } finally {
          personalLoading.value = false;
        }
      }

      function renderPersonalChart() {
        if (typeof echarts === "undefined" || !personalChartEl.value ||
            !personalData.value || !personalSubject.value) return;
        if (!personalChart) personalChart = echarts.init(personalChartEl.value);
        const records = personalData.value.records || [];
        personalChart.setOption({
          tooltip: { trigger: "axis" },
          grid: { left: 52, right: 24, top: 36, bottom: 58 },
          xAxis: {
            type: "category",
            data: records.map((item) => item.exam_name),
            axisLabel: { interval: 0, rotate: records.length > 5 ? 25 : 0 },
          },
          yAxis: { type: "value", scale: true },
          series: [{
            name: personalSubject.value,
            type: "line",
            smooth: true,
            connectNulls: false,
            symbolSize: 8,
            data: records.map((item) => item.scores[personalSubject.value]?.score ?? null),
            lineStyle: { width: 3, color: "#2b5da8" },
            itemStyle: { color: "#2b5da8" },
            areaStyle: { color: "rgba(43,93,168,.10)" },
          }],
        }, true);
      }

      function closePersonalAnalysis() {
        if (personalChart) personalChart.dispose();
        personalChart = null;
      }

      async function openManual() {
        await loadStudents();
        manualForm.subject = "";
        manualForm.score = null;
        manualDialog.value = true;
      }

      async function saveManualScore() {
        if (!examId.value || !manualForm.student_id || !manualForm.subject ||
            manualForm.score === null || manualForm.score === "") {
          ElMessage.warning("请完整填写 学生/科目/分数");
          return;
        }
        await window.api.post("/api/exams/scores", {
          exam_id: examId.value,
          scores: [{ student_id: manualForm.student_id,
                      subject: manualForm.subject, score: Number(manualForm.score) }],
        });
        ElMessage.success("成绩已录入，排名已自动计算");
        manualDialog.value = false;
        loadAnalysis();
      }

      async function removeExam(row) {
        try {
          await ElMessageBox.confirm(`确定删除考试「${row.name}」及全部成绩吗？（软删除）`,
            "删除确认", { type: "warning", confirmButtonText: "删除" });
        } catch (e) { return; }
        await window.api.del(`/api/exams/${row.id}`);
        ElMessage.success("考试已删除");
        loadExams();
      }

      return {
        store, exams, examId, subject, analysis, loading, chartEl, importVisible,
        importSetupDialog, importMode, importForm, importExtra, openImportSetup, startImport,
        addDialog, addForm, manualDialog, manualForm, students, subjectsOfExam,
        personalDialog, personalLoading, personalStudentId, personalSubject,
        personalData, personalChartEl, openPersonalAnalysis, loadPersonalHistory,
        closePersonalAnalysis,
        loadExams, loadAnalysis, onExport, addExam, openManual, saveManualScore, removeExam,
      };
    },
    template: `
    <div>
      <!-- 筛选区 -->
      <div class="page-card" style="padding:14px 18px">
        <div class="page-toolbar" style="margin-bottom:0">
          <span style="color:#7a8194">考试：</span>
          <el-select v-model="examId" style="width:200px" placeholder="选择考试">
            <el-option v-for="e in exams" :key="e.id" :label="e.name + '（' + e.exam_date + '）'" :value="e.id" />
          </el-select>
          <span style="color:#7a8194;margin-left:12px">科目：</span>
          <el-select v-model="subject" style="width:160px" clearable placeholder="全部科目">
            <el-option v-for="s in subjectsOfExam" :key="s" :label="s" :value="s" />
          </el-select>
          <div style="flex:1"></div>
          <el-button :icon="'Plus'" @click="addDialog = true">添加考试</el-button>
          <el-button :icon="'Upload'" @click="openImportSetup">导入成绩（Excel）</el-button>
          <el-button :icon="'User'" @click="openPersonalAnalysis">个人成绩分析</el-button>
          <el-button type="primary" :icon="'EditPen'" @click="openManual">手动录入成绩</el-button>
          <el-button :icon="'Download'" @click="onExport">导出为Excel</el-button>
        </div>
      </div>

      <div v-loading="loading">
        <el-empty v-if="!analysis" description="暂无成绩数据，请先添加考试或导入成绩" />

        <template v-if="analysis">
          <!-- ① 统计卡片 -->
          <div class="stat-cards">
            <div class="stat-card">
              <div class="label">班级均分</div>
              <div class="value">{{ analysis.stats.avg ?? '-' }}</div>
            </div>
            <div class="stat-card accent-green">
              <div class="label">最高分</div>
              <div class="value green">{{ analysis.stats.max ?? '-' }}</div>
            </div>
            <div class="stat-card accent-orange">
              <div class="label">及格率（≥60分）</div>
              <div class="value orange">{{ analysis.stats.pass_rate ?? '-' }}<small> %</small></div>
            </div>
            <div class="stat-card accent-purple">
              <div class="label">有效分数条数</div>
              <div class="value" style="color:#7d6fd8">{{ analysis.stats.count ?? 0 }}<small> 条</small></div>
            </div>
          </div>

          <!-- ② 分数分布 -->
          <div class="page-card" style="margin-top:16px">
            <div style="font-weight:600;margin-bottom:10px">分数分布（{{ analysis.subject || '全部科目' }}）</div>
            <div ref="chartEl" style="height:300px"></div>
          </div>

          <!-- ③ 学生明细 -->
          <div class="page-card">
            <div style="font-weight:600;margin-bottom:10px">每位学生成绩明细（含班级排名）</div>
            <el-table :data="analysis.detail" border stripe size="small" max-height="460">
              <el-table-column prop="student_no" label="学号" width="100" />
              <el-table-column prop="name" label="姓名" width="100" fixed />
              <el-table-column v-for="sub in analysis.subjects" :key="sub" :label="sub" min-width="110" align="center">
                <template #default="{ row }">
                  <template v-if="row[sub]">
                    <b>{{ row[sub].score }}</b>
                    <span style="color:#7a8194;font-size:11px">（第{{ row[sub].rank }}名）</span>
                  </template>
                  <span v-else style="color:#c0c4cc">—</span>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </template>
      </div>

      <!-- 导入前明确考试及实际日期 -->
      <el-dialog v-model="importSetupDialog" title="设置导入考试信息" width="500px">
        <el-form label-width="100px">
          <el-form-item label="导入方式">
            <el-radio-group v-model="importMode">
              <el-radio-button label="new">新建考试</el-radio-button>
              <el-radio-button label="existing">已有考试</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <template v-if="importMode === 'new'">
            <el-form-item label="考试名称" required>
              <el-input v-model="importForm.name" placeholder="例如：第一次月考" maxlength="64" />
            </el-form-item>
            <el-form-item label="考试日期" required>
              <el-date-picker v-model="importForm.exam_date" type="date" value-format="YYYY-MM-DD"
                              style="width:100%" placeholder="请选择实际考试日期" />
            </el-form-item>
            <el-alert type="info" show-icon :closable="false"
                      title="考试日期必须手动选择，不会使用文件导入当天的日期" />
          </template>
          <el-form-item v-else label="选择考试" required>
            <el-select v-model="importForm.exam_id" style="width:100%" placeholder="请选择已有考试">
              <el-option v-for="e in exams" :key="e.id"
                         :label="e.name + '（' + e.exam_date + '）'" :value="e.id" />
            </el-select>
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="importSetupDialog = false">取消</el-button>
          <el-button type="primary" @click="startImport">下一步：选择文件</el-button>
        </template>
      </el-dialog>

      <!-- 添加考试 -->
      <el-dialog v-model="addDialog" title="添加考试成绩（考试）" width="480px">
        <el-form label-width="90px">
          <el-form-item label="考试名称">
            <el-input v-model="addForm.name" placeholder="如：期中考试" />
          </el-form-item>
          <el-form-item label="考试日期" required>
            <el-date-picker v-model="addForm.exam_date" type="date" value-format="YYYY-MM-DD"
                            style="width:100%" placeholder="选择日期" />
          </el-form-item>
          <el-form-item label="科目列表">
            <el-input v-model="addForm.subjects" placeholder="逗号分隔，如：语文,数学,英语" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="addDialog = false">取消</el-button>
          <el-button type="primary" @click="addExam">创建</el-button>
        </template>
      </el-dialog>

      <!-- 手动录入单科成绩 -->
      <el-dialog v-model="manualDialog" title="手动录入单科成绩" width="480px">
        <el-form label-width="90px">
          <el-form-item label="学生">
            <el-select v-model="manualForm.student_id" filterable placeholder="搜索选择学生" style="width:100%">
              <el-option v-for="s in students" :key="s.id"
                         :label="s.name + '（' + s.student_no + '）'" :value="s.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="科目">
            <el-select v-model="manualForm.subject" filterable allow-create
                       placeholder="选择或输入科目" style="width:100%">
              <el-option v-for="s in subjectsOfExam" :key="s" :label="s" :value="s" />
            </el-select>
          </el-form-item>
          <el-form-item label="分数">
            <el-input-number v-model="manualForm.score" :min="-1000" :max="750" :step="0.1" style="width:100%" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="manualDialog = false">取消</el-button>
          <el-button type="primary" @click="saveManualScore">保存并计算排名</el-button>
        </template>
      </el-dialog>

      <!-- 个人跨考试成绩分析 -->
      <el-dialog v-model="personalDialog" title="个人成绩分析" width="88%"
                 destroy-on-close @closed="closePersonalAnalysis">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px">
          <span style="color:#606266">学生：</span>
          <el-select v-model="personalStudentId" filterable clearable
                     placeholder="输入姓名或学号搜索" style="width:320px"
                     @change="loadPersonalHistory">
            <el-option v-for="s in students" :key="s.id"
                       :label="s.name + '（' + s.student_no + '）'" :value="s.id" />
          </el-select>
          <el-button type="primary" :disabled="!personalStudentId"
                     @click="loadPersonalHistory">查询</el-button>
          <template v-if="personalData?.student">
            <el-tag size="large">{{ personalData.student.name }}</el-tag>
            <span style="color:#7a8194;font-size:13px">学号：{{ personalData.student.student_no }}</span>
            <span style="color:#7a8194;font-size:13px">
              共 {{ personalData.exam_count }} 次考试，{{ personalData.score_count }} 条成绩
            </span>
          </template>
        </div>

        <div v-loading="personalLoading" style="min-height:240px">
          <el-empty v-if="!personalData" description="请按姓名或学号选择学生" />
          <template v-else>
            <el-empty v-if="!personalData.records.length" description="该班级还没有考试记录" />
            <template v-else>
              <div class="page-card" style="margin-bottom:16px;padding:14px 16px">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                  <b>成绩趋势</b>
                  <el-select v-model="personalSubject" style="width:180px"
                             placeholder="选择科目" :disabled="!personalData.subjects.length">
                    <el-option v-for="s in personalData.subjects" :key="s" :label="s" :value="s" />
                  </el-select>
                </div>
                <div v-if="personalData.subjects.length" ref="personalChartEl" style="height:300px"></div>
                <el-empty v-else description="该学生暂时没有成绩数据" :image-size="70" />
              </div>

              <el-table :data="personalData.records" border stripe size="small" max-height="430">
                <el-table-column prop="exam_date" label="考试日期" width="110" fixed />
                <el-table-column prop="semester_name" label="学期" min-width="120" />
                <el-table-column prop="exam_name" label="考试" min-width="150" fixed />
                <el-table-column v-for="sub in personalData.subjects" :key="sub"
                                 :label="sub" min-width="110" align="center">
                  <template #default="{ row }">
                    <template v-if="row.scores[sub]">
                      <b>{{ row.scores[sub].score }}</b>
                      <span v-if="row.scores[sub].rank" style="color:#7a8194;font-size:11px">
                        （第{{ row.scores[sub].rank }}名）
                      </span>
                    </template>
                    <span v-else style="color:#c0c4cc">—</span>
                  </template>
                </el-table-column>
              </el-table>
            </template>
          </template>
        </div>
        <template #footer>
          <el-button @click="personalDialog = false">关闭</el-button>
        </template>
      </el-dialog>

      <!-- 成绩导入（Excel 多Sheet，列名→科目） -->
      <import-modal v-model="importVisible" target="exam_scores"
                    :extra="importExtra"
                    title="导入考试成绩" @success="loadExams" />
    </div>
    `,
  };
})();
