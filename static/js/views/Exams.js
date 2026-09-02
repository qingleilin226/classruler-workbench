/**
 * 模块4：成绩分析（数据看板）
 * 上：筛选（考试、科目）；下三部分：① 统计卡片 ② ECharts 分数分布柱状图 ③ 学生明细表
 * 支持 Excel 多Sheet导入（列名→科目）、手动逐行录入。
 */
(function () {
  const { ref, reactive, computed, onMounted, watch, nextTick } = Vue;

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
      const addDialog = ref(false);
      const addForm = reactive({ name: "", exam_date: "", subjects: "语文,数学,英语" });
      const manualDialog = ref(false);
      const manualForm = reactive({ student_id: null, subject: "", score: null });
      const students = ref([]);
      const subjectsOfExam = ref([]);

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

      onMounted(loadExams);
      watch(() => [store.currentClassId, store.currentSemesterId], loadExams);
      watch([examId, subject], loadAnalysis);
      window.addEventListener("resize", () => chart && chart.resize());

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
        if (!addForm.name) {
          ElMessage.warning("请输入考试名称");
          return;
        }
        await window.api.post("/api/exams", {
          class_id: store.currentClassId,
          semester_id: store.currentSemesterId,
          name: addForm.name,
          exam_date: addForm.exam_date || undefined,
          subjects: addForm.subjects.split(/[,，、]/).map((s) => s.trim()).filter(Boolean),
        });
        ElMessage.success("考试创建成功，可手动录入或导入成绩");
        addDialog.value = false;
        addForm.name = "";
        loadExams();
      }

      async function loadStudents() {
        students.value = await window.api.get("/api/students", {
          class_id: store.currentClassId });
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
        addDialog, addForm, manualDialog, manualForm, students, subjectsOfExam,
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
          <el-button :icon="'Upload'" @click="importVisible = true">导入成绩（Excel）</el-button>
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

      <!-- 添加考试 -->
      <el-dialog v-model="addDialog" title="添加考试成绩（考试）" width="480px">
        <el-form label-width="90px">
          <el-form-item label="考试名称">
            <el-input v-model="addForm.name" placeholder="如：期中考试" />
          </el-form-item>
          <el-form-item label="考试日期">
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
            <el-input-number v-model="manualForm.score" :min="0" :max="200" style="width:100%" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="manualDialog = false">取消</el-button>
          <el-button type="primary" @click="saveManualScore">保存并计算排名</el-button>
        </template>
      </el-dialog>

      <!-- 成绩导入（Excel 多Sheet，列名→科目） -->
      <import-modal v-model="importVisible" target="exam_scores"
                    :extra="{ class_id: store.currentClassId, semester_id: store.currentSemesterId, exam_id: examId }"
                    title="导入考试成绩" @success="loadExams" />
    </div>
    `,
  };
})();
