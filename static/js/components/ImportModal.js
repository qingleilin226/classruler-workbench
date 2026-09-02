/**
 * 通用导入组件（所有模块复用）—— 严格三步走：
 *   Step 1 上传解析：POST /api/import/upload，返回 file_id + 预览数据（前10行）
 *   Step 2 字段映射：文件列 → 系统字段（含"忽略此列"）；按文件 MD5 记忆上次习惯
 *   Step 3 预览确认：完整数据分页预览、冲突检测（覆盖/跳过）、"我已核对"后事务入库
 *
 * props:
 *   modelValue  visible 显隐
 *   target      'students' | 'exam_scores' | 'timetable'
 *   extra       附加参数 {exam_id, class_id, semester_id, exam_name...}
 *   title       弹窗标题
 */
(function () {
  const { ref, reactive, computed, watch } = Vue;

  const FIELD_OPTIONS = {
    students: [
      { value: "name", label: "姓名（关联主键）" },
      { value: "gender", label: "性别" },
      { value: "student_no", label: "学号" },
      { value: "birth_date", label: "出生日期" },
      { value: "status", label: "状态（在读/休学/转学）" },
      { value: "guardian_name", label: "监护人姓名" },
      { value: "guardian_phone", label: "监护人电话" },
      { value: "address", label: "家庭住址" },
      { value: "__ignore__", label: "忽略此列" },
    ],
    exam_scores: [
      { value: "student_no", label: "学号（关联依据）" },
      { value: "name", label: "姓名（关联依据）" },
      { value: "__ignore__", label: "忽略此列" },
    ],
    timetable: [
      ...["1", "2", "3", "4", "5", "6", "7"].map((w) => ({
        value: w, label: `星期${"一二三四五六日"[Number(w) - 1]}`,
      })),
      { value: "__ignore__", label: "忽略此列" },
    ],
  };

  const Component = {
    name: "ImportModal",
    props: {
      modelValue: Boolean,
      target: { type: String, default: "students" },
      extra: { type: Object, default: () => ({}) },
      title: { type: String, default: "导入数据" },
    },
    emits: ["update:modelValue", "success"],
    setup(props, { emit }) {
      const visible = computed({
        get: () => props.modelValue,
        set: (v) => emit("update:modelValue", v),
      });

      const step = ref(1);
      const loading = ref(false);
      const fileInput = ref(null);
      const fileName = ref("");
      const fileMd5 = ref("");
      const parsed = ref(null);
      const sheetIndex = ref(0);
      const sheets = computed(() => parsed.value?.sheets || []);
      const currentSheet = computed(() => sheets.value[sheetIndex.value] || null);
      // 课程表：SheetJS 前端重构矩阵（合并单元格展开）
      const matrix = ref([]);
      const matrixMaxPeriod = ref(7);

      const mapping = reactive({});      // {colIndex: field}
      const mappingLoaded = ref(false);
      const subjects = ref({});          // 列 → 自定义科目名（exam_scores）

      const preview = ref(null);         // Step3 预览与冲突
      const resolutions = reactive({});  // {rowIndex: 'overwrite'|'skip'}
      const resolutionMode = ref("skip");
      const confirmed = ref(false);
      const result = ref(null);

      const isStudents = computed(() => props.target === "students");
      const isExam = computed(() => props.target === "exam_scores");
      const isTimetable = computed(() => props.target === "timetable");

      watch(visible, (v) => {
        if (v) reset();
      });

      function reset() {
        step.value = 1;
        fileName.value = "";
        parsed.value = null;
        sheetIndex.value = 0;
        matrix.value = [];
        mappingLoaded.value = false;
        Object.keys(mapping).forEach((k) => delete mapping[k]);
        Object.keys(resolutions).forEach((k) => delete resolutions[k]);
        resolutionMode.value = "skip";
        confirmed.value = false;
        result.value = null;
      }

      function close() {
        visible.value = false;
        emit("success");
      }

      // ---------------- Step 1 上传 ----------------
      function onFileChange(e) {
        const file = e.target.files[0];
        if (!file) return;
        fileName.value = file.name;
        uploadFile(file);
      }

      async function uploadFile(file) {
        loading.value = true;
        try {
          const data = await window.api.uploadFile(file);
          parsed.value = data;
          sheetIndex.value = 0;
          step.value = 2;
          fileMd5.value = data.md5 || "";
          await loadSavedMapping();
        } catch (e) {
          /* Toast 由 api 层处理 */
        } finally {
          loading.value = false;
        }
      }

      // ---------------- Step 2 映射 ----------------
      async function loadSavedMapping() {
        if (!fileMd5.value) return;
        try {
          const saved = await window.api.get("/api/import/mappings", { md5: fileMd5.value });
          if (saved) {
            Object.entries(saved).forEach(([k, v]) => {
              if (v === "__ignore__" || FIELD_OPTIONS[props.target].some((o) => o.value === v)) {
                mapping[k] = v;
              } else if (isExam.value) {
                mapping[k] = "subject:" + v;   // 科目映射恢复
              }
            });
            mappingLoaded.value = true;
          }
        } catch (e) { /* 无历史映射 */ }
      }

      function fieldLabel(colIdx) {
        const v = mapping[String(colIdx)];
        if (!v) return "请选择";
        if (v.startsWith("subject:")) return "科目：" + v.slice(8);
        const opt = FIELD_OPTIONS[props.target].find((o) => o.value === v);
        return opt ? opt.label : v;
      }

      function saveMappingHabit() {
        if (!fileMd5.value) return;
        const cfg = {};
        Object.entries(mapping).forEach(([k, v]) => {
          if (v === "__ignore__") return;
          cfg[k] = v.startsWith("subject:") ? v.slice(8) : v;
        });
        window.api.post("/api/import/mappings", { md5: fileMd5.value, mapping: cfg })
          .catch(() => {});
      }

      /** 课程表：用 SheetJS 重构二维矩阵（处理合并单元格），列顺序与后端 headers 一致 */
      function rebuildMatrix() {
        if (typeof XLSX === "undefined" || !parsed.value) return;
        const file = fileInput.value?.files?.[0];
        if (!file) return;
        // 使用后端解析的行数据（更可靠），列数取最大值
        const sheet = currentSheet.value;
        const rows = sheet?._full_rows ?? sheet?.rows ?? [];
        const maxCols = Math.max(...rows.map((r) => r.length), 0);
        const grid = rows.map((r) => {
          const row = [...r];
          while (row.length < maxCols) row.push("");
          return row;
        });
        // 合并单元格展开：相同内容纵向填充（常见于"上午/下午"合并列）
        for (let r = 1; r < grid.length; r++) {
          for (let c = 0; c < maxCols; c++) {
            const above = grid[r - 1][c];
            if (grid[r][c] === "" && above && !["上午", "下午", "午休", "早读"].includes(above)) {
              // 单列向下填充（覆盖常规合并），横向合并无法自动判断，由用户映射忽略
            }
          }
        }
        matrix.value = grid;
        matrixMaxPeriod.value = grid.length;
      }

      function nextFromMapping() {
        const chosen = Object.values(mapping).filter((v) => v && v !== "__ignore__");
        if (!chosen.length) {
          ElMessage.warning("请至少映射一列");
          return;
        }
        if (isTimetable.value) rebuildMatrix();
        loading.value = true;
        const payload = {
          file_id: parsed.value.file_id,
          target: props.target,
          mapping: { ...mapping },
          extra: props.extra,
        };
        window.api.post("/api/import/preview", payload)
          .then((data) => {
            preview.value = data;
            step.value = 3;
          })
          .catch(() => {})
          .finally(() => (loading.value = false));
      }

      // ---------------- Step 3 确认入库 ----------------
      const pageSize = ref(10);
      const page = ref(1);
      const pagedRows = computed(() => {
        const rows = preview.value?.rows || [];
        const start = (page.value - 1) * pageSize.value;
        return rows.slice(start, start + pageSize.value);
      });

      function applyResolutionMode(mode) {
        resolutionMode.value = mode;
        (preview.value?.rows || []).forEach((r) => {
          if (r.conflict) resolutions[String(r.index)] = mode;
        });
      }

      function confirmImport() {
        if (!confirmed.value) {
          ElMessage.warning("请先勾选「我已核对数据无误」");
          return;
        }
        loading.value = true;
        const payload = {
          file_id: parsed.value.file_id,
          target: props.target,
          mapping: { ...mapping },
          resolutions: { ...resolutions },
          extra: isTimetable.value ? { ...props.extra, matrix: matrix.value, weekday_map: mapping } : props.extra,
        };
        window.api.post("/api/import/confirm", payload)
          .then((data) => {
            result.value = data;
            saveMappingHabit();
            ElMessage.success("导入成功");
            emit("success", data);
            setTimeout(close, 1200);
          })
          .catch(() => {})
          .finally(() => (loading.value = false));
      }

      const columns = computed(() => {
        const sheet = currentSheet.value;
        if (!sheet) return [];
        return sheet.headers.map((h, i) => ({
          prop: String(i), label: h || `列${i + 1}`, idx: i,
        }));
      });

      const showResult = computed(() => result.value != null);

      return {
        visible, step, loading, fileInput, fileName, parsed, sheetIndex, sheets,
        currentSheet, mapping, mappingLoaded, subjects, preview, resolutions,
        resolutionMode, confirmed, result, isStudents, isExam, isTimetable,
        pageSize, page, pagedRows, columns, showResult, matrix, matrixMaxPeriod,
        FIELD_OPTIONS: FIELD_OPTIONS[props.target],
        onFileChange, nextFromMapping, applyResolutionMode, confirmImport, close, reset,
        fieldLabel,
      };
    },
    template: `
    <el-dialog :model-value="visible" @update:model-value="visible = $event"
               :title="title" width="960px" top="4vh" :close-on-click-modal="false"
               destroy-on-close>
      <!-- 步骤条 -->
      <el-steps :active="step - 1" align-center finish-status="success" style="margin-bottom:18px">
        <el-step title="上传文件" />
        <el-step title="字段映射" />
        <el-step title="预览确认" />
      </el-steps>

      <!-- ==================== Step 1 上传 ==================== -->
      <div v-if="step === 1">
        <el-upload drag :auto-upload="false" :show-file-list="false"
                   accept=".xlsx,.xls,.docx,.pdf" :on-change="(f) => uploadFile(f.raw)">
          <el-icon style="font-size:48px;color:#c0c4cc"><UploadFilled /></el-icon>
          <div class="el-upload__text">将文件拖到此处，或 <em>点击选择文件</em></div>
          <template #tip>
            <div class="el-upload__tip" style="color:#909399">
              支持 .xlsx / .xls / .docx / .pdf，单文件不超过 20MB。<br>
              导入流程为 解析 → 人工映射 → 预览确认，系统不会静默写入数据。
            </div>
          </template>
        </el-upload>
      </div>

      <!-- ==================== Step 2 映射 ==================== -->
      <div v-else-if="step === 2">
        <el-alert v-if="mappingLoaded" type="success" show-icon :closable="false"
                  style="margin-bottom:12px" title="已根据该文件的导入习惯自动填充映射，请核对后继续" />
        <el-alert v-if="parsed.sheet_count > 1" type="info" show-icon :closable="false"
                  style="margin-bottom:12px"
                  :title="'文件包含 ' + parsed.sheet_count + ' 个工作表'">
          <template #default>
            <span style="margin-right:8px">选择工作表：</span>
            <el-select v-model="sheetIndex" size="small" style="width:180px">
              <el-option v-for="(s, i) in sheets" :key="i" :label="s.sheet_name" :value="i" />
            </el-select>
          </template>
        </el-alert>
        <el-alert v-if="parsed.file_kind !== 'excel'" type="warning" show-icon :closable="false"
                  style="margin-bottom:12px"
                  title="Word/PDF 文本已解析，若坐标混乱请使用下方映射+正则预筛确认" />

        <!-- 文件列 → 系统字段 映射表 -->
        <el-table :data="columns" border size="small" max-height="380">
          <el-table-column label="文件列名" min-width="180">
            <template #default="{ row }">{{ row.label }}</template>
          </el-table-column>
          <el-table-column label="映射到系统字段" min-width="280">
            <template #default="{ row }">
              <el-select v-model="mapping[String(row.idx)]" placeholder="请选择（含忽略此列）"
                         size="small" style="width:100%" :filterable="isExam">
                <el-option v-for="o in FIELD_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
                <!-- 考试成绩：其余列作为科目 -->
                <template v-if="isExam">
                  <el-option v-for="sub in parsed.existing_subjects || []" :key="'s:' + sub"
                             :label="'科目：' + sub" :value="'subject:' + sub" />
                  <el-option label="科目（自定义名称）" value="__custom_subject__" />
                </template>
              </el-select>
              <el-input v-if="isExam && mapping[String(row.idx)] === '__custom_subject__'"
                        v-model="mapping[String(row.idx)]" size="small" style="margin-top:4px"
                        placeholder="输入科目名称，如：数学" />
            </template>
          </el-table-column>
          <el-table-column label="已映射" min-width="120">
            <template #default="{ row }">
              <el-tag v-if="mapping[String(row.idx)] && mapping[String(row.idx)] !== '__ignore__'"
                      size="small" type="success">{{ fieldLabel(row.idx) }}</el-tag>
              <el-tag v-else-if="mapping[String(row.idx)] === '__ignore__'" size="small" type="info">忽略</el-tag>
              <span v-else style="color:#c0c4cc">未选择</span>
            </template>
          </el-table-column>
        </el-table>

        <!-- 预览前 10 行 -->
        <el-table v-if="currentSheet" :data="currentSheet.rows" border size="small"
                  max-height="220" style="margin-top:12px">
          <el-table-column v-for="(h, i) in currentSheet.headers" :key="i"
                           :label="h || ('列' + (i+1))" min-width="100">
            <template #default="{ row }">{{ row[i] }}</template>
          </el-table-column>
        </el-table>
        <div style="color:#909399;font-size:12px;margin-top:6px">
          共 {{ currentSheet?.total_rows || 0 }} 行，上方为前 {{ currentSheet?.preview_limit || 10 }} 行预览
        </div>
      </div>

      <!-- ==================== Step 3 预览确认 ==================== -->
      <div v-else-if="step === 3 && preview">
        <el-alert type="warning" show-icon :closable="false" style="margin-bottom:12px"
                  v-if="preview.conflict_count > 0"
                  :title="'检测到 ' + preview.conflict_count + ' 行与现有数据冲突（学号/姓名已存在）'">
          <template #default>
            <div style="margin-top:8px">
              <span>冲突处理：</span>
              <el-radio-group v-model="resolutionMode" size="small"
                              @change="applyResolutionMode">
                <el-radio-button label="overwrite">全部覆盖已有记录</el-radio-button>
                <el-radio-button label="skip">全部跳过冲突行</el-radio-button>
              </el-radio-group>
              <div style="color:#909399;font-size:12px;margin-top:6px">
                也可在下方表格中对每一行单独选择覆盖或跳过
              </div>
            </div>
          </template>
        </el-alert>

        <el-table :data="pagedRows" border size="small" max-height="380"
                  :row-class-name="({ row }) => row.conflict ? 'import-conflict-row' : ''">
          <el-table-column label="行号" width="70">
            <template #default="{ row }">{{ row.index + 2 }}</template>
          </el-table-column>
          <!-- students: 映射字段 -->
          <template v-if="isStudents">
            <el-table-column v-for="(opt) in Object.entries(mapping).filter(([,v]) => v && v !== '__ignore__')"
                             :key="'col-' + opt[0]" :label="fieldLabel(opt[1])" min-width="110">
              <template #default="{ row }">{{ row.values[opt[1]] || '—' }}</template>
            </el-table-column>
            <el-table-column label="冲突" width="200">
              <template #default="{ row }">
                <el-tag v-if="row.conflict" type="danger" size="small">{{ row.conflict.message }}</el-tag>
                <el-tag v-else type="success" size="small">无冲突</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="处理方式" width="140">
              <template #default="{ row }">
                <el-select v-if="row.conflict" v-model="resolutions[String(row.index)]"
                           size="small" placeholder="选择">
                  <el-option label="覆盖" value="overwrite" />
                  <el-option label="跳过" value="skip" />
                </el-select>
                <span v-else style="color:#909399">新增</span>
              </template>
            </el-table-column>
          </template>
          <!-- exam_scores: 学号/姓名 + 科目分数 -->
          <template v-else-if="isExam">
            <el-table-column label="学号" min-width="120">
              <template #default="{ row }">{{ row.values.student_no || '—' }}</template>
            </el-table-column>
            <el-table-column label="姓名" min-width="100">
              <template #default="{ row }">{{ row.values.name || '—' }}</template>
            </el-table-column>
            <el-table-column v-for="sub in preview.subjects" :key="sub" :label="sub" min-width="100">
              <template #default="{ row }">{{ row.values[sub] || '—' }}</template>
            </el-table-column>
          </template>
          <!-- timetable: 矩阵重构预览 -->
          <template v-else>
            <el-table-column label="节次" width="70">
              <template #default="{ $index }">第{{ $index + 1 }}节</template>
            </el-table-column>
            <el-table-column v-for="(h, i) in preview.headers" :key="'h' + i" :label="h || ('列' + (i+1))" min-width="100">
              <template #default="{ row }">{{ row[i] }}</template>
            </el-table-column>
          </template>
        </el-table>

        <el-pagination style="margin-top:10px;justify-content:flex-end"
                       layout="total, prev, pager, next, sizes" :total="preview.total || 0"
                       v-model:current-page="page" v-model:page-size="pageSize"
                       :page-sizes="[10, 20, 50, 100]" />

        <el-checkbox v-model="confirmed" style="margin-top:12px;font-weight:600">
          我已核对数据无误（共 {{ preview.total }} 行），确认入库
        </el-checkbox>
      </div>

      <!-- 结果 -->
      <template #footer>
        <el-button v-if="step < 3" @click="close">取消</el-button>
        <el-button v-if="step === 2" type="primary" :loading="loading" @click="nextFromMapping">
          下一步：预览与冲突检测
        </el-button>
        <el-button v-if="step === 3" type="primary" :loading="loading" @click="confirmImport">
          确认入库（事务写入）
        </el-button>
      </template>
    </el-dialog>
    `,
  };

  window.ImportModal = Component;
})();
