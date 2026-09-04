/**
 * 通用导入组件（所有模块复用）—— 严格三步走：
 *   Step 1 上传解析：POST /api/import/upload，返回 file_id + 预览数据（前10行）
 *   Step 2 字段映射：文件列 → 系统字段（含"忽略此列"）；按文件 MD5 记忆上次习惯（仅单工作表文件）
 *   Step 3 预览确认：完整数据分页预览、冲突检测（覆盖/跳过）、"我已核对"后事务入库
 *
 * 多工作表文件（target=students 且 excel 且 sheet_count>1）走 5 段向导：
 *   上传 → 勾选要导入的工作表 + 每表选择目标班级 → 逐表映射（列名行可调）
 *   → 逐表冲突预览 → 逐表独立事务入库 + 结果汇总（单表失败不影响其他表）
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

  /** 成绩导入：语种标记列（外语类型）的特殊映射值——按行语种把“外语”列拆成 日语/英语 两科 */
  const EXAM_LANG_OPT = { value: "__lang_split__", label: "外语类型（拆 日语/英语）" };

  /** 表头列名 → 系统字段 自动映射关键词（先匹配具体项，再匹配泛化词） */
  const HEADER_KEYWORDS = [
    { kws: ["监护人姓名", "家长姓名", "父亲姓名", "母亲姓名", "妈妈姓名", "爸爸姓名"], f: "guardian_name" },
    { kws: ["姓名", "名字"], f: "name" },
    { kws: ["学号", "序号", "编号", "考号"], f: "student_no" },
    { kws: ["性别"], f: "gender" },
    { kws: ["出生", "生日", "年龄"], f: "birth_date" },
    { kws: ["状态", "学籍"], f: "status" },
    { kws: ["电话", "手机", "号码", "联系方式", "q q", "qq"], f: "guardian_phone" },
    { kws: ["住址", "地址", "家庭", "家长住"], f: "address" },
  ];

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
      const store = window.useMainStore();
      const visible = computed({
        get: () => props.modelValue,
        set: (v) => emit("update:modelValue", v),
      });

      // ---------------- 单工作表路径状态（与旧版一致） ----------------
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

      // 表头（列名）所在物理行号：null=用自动探测值；用户改过则随请求发送
      const headerRow = ref(null);
      const viewSheet = computed(() => sheetViewOf(sheetIndex.value));

      const mapping = reactive({});      // {colIndex: field}
      const mappingLoaded = ref(false);
      const subjects = ref({});          // 列 → 自定义科目名（exam_scores）

      const preview = ref(null);         // Step3 预览与冲突（单表）
      const resolutions = reactive({});  // {rowIndex: 'overwrite'|'skip'}
      const resolutionMode = ref("skip");
      const confirmed = ref(false);
      const result = ref(null);

      // ---------------- 多工作表路径状态（students + excel + 多 sheet） ----------------
      const activePane = ref(1);            // 1 上传 / 2 选表选班 / 3 映射 / 4 预览确认 / 5 结果
      const multiMode = computed(() =>
        isStudents.value && parsed.value?.file_kind === "excel"
          && (parsed.value?.sheet_count || 0) > 1);
      const selectedIdx = ref([]);          // 勾选的工作表下标（parsed.sheets 下标）
      const selSheets = computed(() =>
        selectedIdx.value.map((i) => parsed.value?.sheets?.[i]).filter(Boolean));
      const selTab = ref(0);                // 多表映射/预览 tab（selSheets 内下标）
      const sheetClassId = reactive({});    // sheet下标 → 目标班级 id
      const hrBySheet = reactive({});       // sheet下标 → 列名行(1基, null=自动)
      const mapBySheet = reactive({});      // sheet下标 → {colIndex: field}
      const autoMappedBySheet = reactive({}); // sheet下标 → 是否已按列名自动映射
      const previewsBySheet = reactive({}); // sheet下标 → /preview 结果
      const resModeBySheet = reactive({});  // sheet下标 → 默认冲突策略 skip|overwrite
      const resBySheet = reactive({});      // sheet下标 → {rowIndex: policy}
      const resultsBySheet = reactive({});  // sheet下标 → /confirm 结果 | {error}
      const confirmedAll = ref(false);

      const isStudents = computed(() => props.target === "students");
      const isExam = computed(() => props.target === "exam_scores");
      const isTimetable = computed(() => props.target === "timetable");

      // ---------------- 通用工具 ----------------
      function clearObj(obj) {
        Object.keys(obj).forEach((k) => delete obj[k]);
      }

      /** 由原始网格按 1 基列名行重切 → {headers, rows(前10), _full_rows, total_rows}；
       *  与后端 _resolve_sheet 同规则、同数据 → 所见即所得。 */
      function sliceGrid(raw, hr) {
        if (!raw || !raw.length) return null;
        const h = Math.max(1, hr | 0 || 1);
        if (h > raw.length) return null;
        const headers = (raw[h - 1] || []).map((c) => (c == null ? "" : String(c).trim()));
        const data = raw.slice(h);
        return { headers, rows: data.slice(0, 10), _full_rows: data, total_rows: data.length };
      }

      /** 取某 sheet 的视图（默认自动探测值或按 hrBySheet/headerRow 覆盖重切） */
      function sheetViewOf(i) {
        const s = parsed.value?.sheets?.[i];
        if (!s) return null;
        const hr = hrBySheet[i] ?? headerRow.value ?? s._header_row ?? 1;
        if (hr === (s._header_row ?? 1) || !s._raw_grid) return s;
        const v = sliceGrid(s._raw_grid, hr);
        return v ? { ...s, ...v } : s;
      }

      function headerKwMatch(t) {
        for (const item of HEADER_KEYWORDS) {
          if (item.kws.some((kw) => t.includes(kw))) return item.f;
        }
        return null;
      }

      /** 按列名建议映射：识别出的列映射到系统字段，其余忽略 */
      function autoMapFor(sheetObj) {
        const m = {};
        (sheetObj?.headers || []).forEach((h, i) => {
          const t = String(h || "").replace(/\s+/g, "");
          m[String(i)] = headerKwMatch(t) || "__ignore__";
        });
        return m;
      }

      /** 系统字段值（含 subject: 前缀科目）→ 展示名；无法识别的原样返回 */
      function labelOfField(v) {
        if (!v) return "请选择";
        if (v.startsWith("subject:")) return "科目：" + v.slice(8);
        if (v === EXAM_LANG_OPT.value) return EXAM_LANG_OPT.label;
        const opt = FIELD_OPTIONS[props.target].find((o) => o.value === v);
        return opt ? opt.label : v;
      }

      function fieldLabelFor(m, colIdx) {
        return labelOfField(m ? m[String(colIdx)] : null);
      }

      function columnsOf(sheetObj) {
        if (!sheetObj) return [];
        return sheetObj.headers.map((h, i) => ({
          prop: String(i), label: h || `列${i + 1}`, idx: i,
        }));
      }

      // ---------------- 上传 ----------------
      watch(visible, (v) => {
        if (v) reset();
      });

      // 切换工作表 → 表头行号回自动（各表自动探测的列名行可能不同）
      watch(currentSheet, () => {
        headerRow.value = null;
      });

      function reset() {
        step.value = 1;
        activePane.value = 1;
        fileName.value = "";
        parsed.value = null;
        sheetIndex.value = 0;
        selTab.value = 0;
        matrix.value = [];
        headerRow.value = null;
        mappingLoaded.value = false;
        selectedIdx.value = [];
        confirmedAll.value = false;
        clearObj(mapping);
        clearObj(resolutions);
        clearObj(sheetClassId);
        clearObj(hrBySheet);
        clearObj(mapBySheet);
        clearObj(autoMappedBySheet);
        clearObj(previewsBySheet);
        clearObj(resModeBySheet);
        clearObj(resBySheet);
        clearObj(resultsBySheet);
        resolutionMode.value = "skip";
        confirmed.value = false;
        result.value = null;
      }

      function close() {
        visible.value = false;
        emit("success");
      }

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
          headerRow.value = null;
          fileMd5.value = data.md5 || "";
          if (multiMode.value) {
            initMultiState();
            activePane.value = 2;   // 选表选班
          } else {
            step.value = 2;         // 映射
            await loadSavedMapping();
          }
        } catch (e) {
          /* Toast 由 api 层处理 */
        } finally {
          loading.value = false;
        }
      }

      // ---------------- 多表：选表选班 ----------------
      function initMultiState() {
        const n = parsed.value?.sheets?.length || 0;
        if (!selectedIdx.value.length && n) {
          selectedIdx.value = Array.from({ length: n }, (_, i) => i);
        }
        const def = props.extra?.class_id || store.currentClassId
          || store.classes?.[0]?.id || null;
        for (let i = 0; i < n; i++) {
          if (sheetClassId[i] === undefined) sheetClassId[i] = def;
          if (hrBySheet[i] === undefined) hrBySheet[i] = null;
          if (resModeBySheet[i] === undefined) resModeBySheet[i] = "skip";
          if (!mapBySheet[i]) mapBySheet[i] = {};
        }
      }

      function selectAllSheets(on) {
        selectedIdx.value = on
          ? (parsed.value?.sheets || []).map((_, i) => i)
          : [];
      }

      function refreshClasses() {
        return store.loadClasses().then(() => {
          ElMessage.success("班级列表已刷新");
        }).catch(() => {});
      }

      function canLeavePickPane() {
        if (!selectedIdx.value.length) {
          ElMessage.warning("请至少勾选一个要导入的工作表");
          return false;
        }
        const missing = selectedIdx.value.filter((i) => !sheetClassId[i]);
        if (missing.length) {
          ElMessage.warning("还有工作表未选择「导入到班级」，请补全后再继续");
          return false;
        }
        return true;
      }

      // ---------------- 多表：映射准备 ----------------
      function ensureAutoMap(si) {
        if (!autoMappedBySheet[si]) {
          const sv = sheetViewOf(si);
          if (sv && isStudents.value && sv.headers?.length) {
            mapBySheet[si] = autoMapFor(sv);
            autoMappedBySheet[si] = true;
          }
        }
      }

      /** 进入映射步前：为还没映射过的表按列名自动映射（students） */
      function ensureSheetMaps() {
        selectedIdx.value.forEach((si) => ensureAutoMap(si));
      }

      function autoMapSheet(si) {
        const sv = sheetViewOf(si);
        if (!sv || !isStudents.value) return;
        mapBySheet[si] = autoMapFor(sv);
        autoMappedBySheet[si] = true;
        ElMessage.success("已按列名自动映射，请核对（无法识别的列自动忽略）");
      }

      function copyMappingFromFirst(j) {
        if (j <= 0) return;
        const firstSi = selectedIdx.value[0];
        const si = selectedIdx.value[j];
        if (firstSi === undefined || si === undefined) return;
        mapBySheet[si] = { ...(mapBySheet[firstSi] || {}) };
        ElMessage.success("已套用第一张工作表的映射");
      }

      function setHrAuto(si) {
        hrBySheet[si] = null;
      }

      // ---------------- 映射习惯（仅单工作表文件） ----------------
      function applySavedMapping(saved) {
        if (!saved) return false;
        let applied = false;
        Object.entries(saved).forEach(([k, v]) => {
          if (v === "__ignore__" || FIELD_OPTIONS[props.target].some((o) => o.value === v)) {
            mapping[k] = v;
            applied = true;
          } else if (isExam.value) {
            mapping[k] = v;                // 科目映射恢复（科目名即候选值，非 subject: 前缀）
            applied = true;
          }
        });
        return applied;
      }

      async function loadSavedMapping() {
        if (multiMode.value || !fileMd5.value) return;
        try {
          // 优先按“导入类型 + 列名”复用最近一次操作；换文件或调换列顺序也能命中。
          const remembered = await window.api.post("/api/import/mappings/recall", {
            target: props.target,
            headers: viewSheet.value?.headers || [],
          });
          let applied = applySavedMapping(remembered);
          // 兼容旧版本仅按完整文件 MD5 保存的历史记录。
          if (!applied) {
            const legacy = await window.api.get("/api/import/mappings", { md5: fileMd5.value });
            applied = applySavedMapping(legacy);
          }
          mappingLoaded.value = applied;
        } catch (e) { /* 无历史映射 */ }
      }

      function saveMappingHabit() {
        if (multiMode.value || !fileMd5.value) return;
        const cfg = {};
        Object.entries(mapping).forEach(([k, v]) => {
          if (!v) return;
          cfg[k] = v.startsWith("subject:") ? v.slice(8) : v;
        });
        window.api.post("/api/import/mappings", {
          md5: fileMd5.value,
          target: props.target,
          headers: viewSheet.value?.headers || [],
          mapping: cfg,
        })
          .catch(() => {});
      }

      /** 课程表：用 SheetJS 重构二维矩阵（处理合并单元格），列顺序与后端 headers 一致 */
      function rebuildMatrix() {
        if (typeof XLSX === "undefined" || !parsed.value) return;
        const file = fileInput.value?.files?.[0];
        if (!file) return;
        // 使用后端解析的行数据（更可靠），列数取最大值
        const sheet = viewSheet.value || currentSheet.value;
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
        // 用户完成字段选择即记住习惯；即使后续预览报错或取消，也能在下次恢复。
        saveMappingHabit();
        if (isTimetable.value) rebuildMatrix();
        loading.value = true;
        const payload = {
          file_id: parsed.value.file_id,
          target: props.target,
          mapping: { ...mapping },
          sheet_index: sheetIndex.value,
          header_row: headerRow.value,   // null = 后端用自动探测值
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

      // ---------------- 多表：预览与确认 ----------------
      function previewPayloadFor(si) {
        return {
          file_id: parsed.value.file_id,
          target: props.target,
          mapping: { ...(mapBySheet[si] || {}) },
          sheet_index: si,
          header_row: hrBySheet[si] ?? null,
          extra: { ...props.extra, class_id: sheetClassId[si] },
        };
      }

      async function runPreviewMulti() {
        const needMap = selectedIdx.value.filter((si) => {
          const vals = Object.values(mapBySheet[si] || {});
          return !vals.some((v) => v && v !== "__ignore__");
        });
        if (needMap.length) {
          ElMessage.warning(`第 ${needMap.map((i) => (parsed.value?.sheets?.[i]?.sheet_name ?? i + 1)).join("、")} 张表还没有任何列映射`);
          return;
        }
        loading.value = true;
        let failAt = null;
        for (let j = 0; j < selectedIdx.value.length; j++) {
          const si = selectedIdx.value[j];
          try {
            const d = await window.api.post("/api/import/preview", previewPayloadFor(si));
            previewsBySheet[si] = d;
            resModeBySheet[si] = "skip";
            resBySheet[si] = {};
            // 预填与"全部跳过"一致的默认策略，行级仍可单独改
            (d.rows || []).forEach((r) => {
              if (r.conflict) resBySheet[si][String(r.index)] = "skip";
            });
          } catch (e) {
            failAt = j;
            break;
          }
        }
        loading.value = false;
        if (failAt !== null) {
          selTab.value = failAt;
          activePane.value = 3;
          ElMessage.error("有工作表的预览失败，请检查该表的列名行与映射后重试");
        } else {
          selTab.value = 0;
          confirmedAll.value = false;
          activePane.value = 4;
        }
      }

      function confirmPayloadFor(si) {
        const p = previewPayloadFor(si);
        p.resolutions = { ...(resBySheet[si] || {}), default: resModeBySheet[si] || "skip" };
        return p;
      }

      function applyResModeFor(si, mode) {
        resModeBySheet[si] = mode;
        const rows = previewsBySheet[si]?.rows || [];
        rows.forEach((r) => {
          if (r.conflict) resBySheet[si][String(r.index)] = mode;
        });
      }

      function activePaneRowNo(r) {
        const p = previewsBySheet[selectedIdx.value[selTab.value]];
        return r.index + (p?.header_row || 1) + 1;
      }

      async function confirmOne(si) {
        try {
          const d = await window.api.post("/api/import/confirm", confirmPayloadFor(si));
          resultsBySheet[si] = d;
          return true;
        } catch (e) {
          resultsBySheet[si] = { error: (e && e.message) || "导入失败" };
          return false;
        }
      }

      async function confirmImportMulti() {
        loading.value = true;
        for (const si of selectedIdx.value) {
          await confirmOne(si);
        }
        loading.value = false;
        activePane.value = 5;
      }

      async function retrySheet(si) {
        loading.value = true;
        await confirmOne(si);
        loading.value = false;
      }

      function multiFinished() {
        const failed = selectedIdx.value.filter((si) => resultsBySheet[si]?.error);
        return failed.length === 0;
      }

      // ---------------- Step 3 确认入库（单表） ----------------
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

      // exam 预览：把逐行 errors 归并为“同类错误 ×N（首见第 X 行）”，供红色横幅展示
      const examErrorGroups = computed(() => {
        if (!isExam.value || !preview.value) return [];
        const byKey = {};
        (preview.value?.rows || []).forEach((r) => {
          const es = r.errors || [];
          if (!es.length) return;
          const no = r.row_no || (r.index + (preview.value?.header_row || 1) + 1);
          es.forEach((e) => {
            const key = e.message.replace(/(科目「.+?」分数).*/, "$1");
            const g = byKey[key] || (byKey[key] = { text: key, n: 0, first: no });
            g.n += 1;
            if (no < g.first) g.first = no;
          });
        });
        return Object.values(byKey);
      });

      function errCellText(row) {
        const es = row.errors || [];
        if (!es.length) return "正常";
        if (es.length > 1) return `共 ${es.length} 处错误`;
        const t = es[0].message;
        return t.length > 16 ? t.slice(0, 16) + "…" : t;
      }

      function rowNo(r) {
        return r.index + (preview.value?.header_row || 1) + 1;
      }

      function confirmImport() {
        if (isExam.value && preview.value?.error_count > 0) {
          ElMessage.error("预览存在数据错误（问题行已标红），请点「上一步」修正字段映射后重新预览");
          return;
        }
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
          sheet_index: sheetIndex.value,
          header_row: headerRow.value,
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

      const columns = computed(() => columnsOf(viewSheet.value));

      /**
       * 映射候选项（按导入目标）：
       *   - students / timetable：固定字段表
       *   - exam_scores：关联依据(学号/姓名) + 忽略，其余科目候选 = 本文件“文件列名”的全部
       *     列（去空/去重、剔除与关联依据同名的字样）。科目就这几门、列名即科目名，
       *     做成静态候选，无需查询“已有科目”、无需手输科目名。
       */
      const mapOptions = computed(() => {
        const base = FIELD_OPTIONS[props.target];
        if (!isExam.value || !viewSheet.value) return base;
        const skipWords = new Set(["学号", "姓名", "序号", "考号"]);
        const seen = new Set(base.map((o) => o.value));
        const subs = [];
        for (const h of viewSheet.value.headers) {
          const t = String(h || "").trim();
          if (!t || skipWords.has(t) || seen.has(t)) continue;
          seen.add(t);
          subs.push({ value: t, label: t });
        }
        const head = base.filter((o) => o.value !== "__ignore__");
        const ignore = base.find((o) => o.value === "__ignore__");
        return [...head, ...subs, ignore].filter(Boolean);
      });

      /** 本文件是否含“外语类型/语种”标记列（决定是否出现拆分提示与拆分候选） */
      const hasLangTypeCol = computed(() => {
        if (!isExam.value || !viewSheet.value) return false;
        return (viewSheet.value.headers || []).some((h) => {
          const t = String(h || "");
          return /外语/.test(t) && /(类型|语种)/.test(t);
        });
      });

      /** 映射候选：仅对“外语类型/语种”类列名额外提供 拆分日语/英语 选项（其余列照旧） */
      function optionsFor(headerText) {
        const opts = mapOptions.value;
        if (!isExam.value) return opts;
        const t = String(headerText || "");
        if (!(/外语/.test(t) && /(类型|语种)/.test(t))) return opts;
        const ignore = opts.find((o) => o.value === "__ignore__");
        const rest = opts.filter((o) => o.value !== "__ignore__");
        return [...rest, EXAM_LANG_OPT, ignore];
      }

      const showResult = computed(() => result.value != null);

      const stepTitles = computed(() => multiMode.value
        ? ["上传文件", "选择工作表与班级", "字段映射", "预览确认", "结果"]
        : ["上传文件", "字段映射", "预览确认"]);

      const activeStep = computed(() => (multiMode.value ? activePane.value : step.value));

      const currentPane = computed(() => {
        if (multiMode.value) {
          if (activePane.value === 2) return "pick";
          if (activePane.value === 3) return "mapMulti";
          if (activePane.value === 4) return "previewMulti";
          if (activePane.value === 5) return "result";
          return "upload";
        }
        if (step.value === 2) return "map";
        if (step.value === 3) return "preview";
        return "upload";
      });

      function backPane() {
        if (multiMode.value) {
          if (activePane.value > 1) activePane.value -= 1;
          if (activePane.value === 1) close();
        } else if (step.value > 1) {
          step.value -= 1;
        } else {
          close();
        }
      }

      return {
        visible, step, activePane, loading, fileInput, fileName, parsed, sheetIndex,
        sheets, currentSheet, viewSheet, headerRow, sheetViewOf, columnsOf,
        mapping, mappingLoaded, subjects, preview, resolutions, resolutionMode,
        confirmed, result, isStudents, isExam, isTimetable, multiMode, selSheets,
        selectedIdx, selTab, sheetClassId, hrBySheet, mapBySheet, autoMappedBySheet,
        previewsBySheet, resModeBySheet, resBySheet, resultsBySheet, confirmedAll,
        pageSize, page, pagedRows, columns, showResult, matrix, matrixMaxPeriod,
        examErrorGroups, errCellText,
        FIELD_OPTIONS: FIELD_OPTIONS[props.target],
        stepTitles, activeStep, currentPane, store,
        labelOfField, fieldLabelFor, autoMapFor, mapOptions, optionsFor, hasLangTypeCol,
        onFileChange, uploadFile, selectAllSheets, refreshClasses, canLeavePickPane,
        ensureAutoMap, ensureSheetMaps, autoMapSheet, copyMappingFromFirst, setHrAuto,
        initMultiState, nextFromMapping, runPreviewMulti, previewPayloadFor,
        confirmPayloadFor, applyResModeFor, confirmImportMulti, confirmOne,
        retrySheet, multiFinished, rowNo, activePaneRowNo,
        applyResolutionMode, confirmImport, close, reset,
      };
    },
    template: `
    <el-dialog :model-value="visible" @update:model-value="visible = $event"
               :title="title" width="960px" top="4vh" :close-on-click-modal="false"
               destroy-on-close>
      <!-- 步骤条 -->
      <el-steps :active="activeStep - 1" align-center finish-status="success" style="margin-bottom:18px">
        <el-step v-for="(t, i) in stepTitles" :key="i" :title="t" />
      </el-steps>

      <!-- ==================== Step 1 上传 ==================== -->
      <div v-if="currentPane === 'upload'">
        <el-upload drag :auto-upload="false" :show-file-list="false"
                   accept=".xlsx,.xls,.docx,.pdf" :on-change="(f) => uploadFile(f.raw)">
          <el-icon style="font-size:48px;color:#c0c4cc"><UploadFilled /></el-icon>
          <div class="el-upload__text">将文件拖到此处，或 <em>点击选择文件</em></div>
          <template #tip>
            <div class="el-upload__tip" style="color:#909399">
              支持 .xlsx / .xls / .docx / .pdf，单文件不超过 20MB。<br>
              导入流程为 实时解析 → 人工映射 → 预览确认，系统不会静默写入数据。
              <template v-if="isStudents">多工作表文件（如 501班/502班/… 分表）会提示你勾选要导入的工作表。</template>
            </div>
          </template>
        </el-upload>
      </div>

      <!-- ============ Step 2（多表）选择工作表与目标班级 ============ -->
      <div v-else-if="currentPane === 'pick'">
        <el-alert type="info" show-icon :closable="false" style="margin-bottom:12px"
                  :title="'文件包含 ' + (parsed?.sheet_count || 0) + ' 个工作表（检测为多个班级/名单），勾选要导入的，并为每张表选择目标班级'">
        </el-alert>
        <div style="margin-bottom:8px">
          <el-button size="small" @click="selectAllSheets(true)">全选</el-button>
          <el-button size="small" @click="selectAllSheets(false)">全不选</el-button>
          <span style="font-size:12px;color:#909399;margin-left:8px">已选 {{ selectedIdx.length }} 张表</span>
        </div>
        <el-table :data="sheets" border size="small" max-height="360"
                  :row-key="(r) => r.sheet_name">
          <el-table-column width="50">
            <template #header>
              <el-checkbox :model-value="selectedIdx.length === sheets.length && sheets.length > 0"
                           @change="selectAllSheets" />
            </template>
            <template #default="{ row }">
              <el-checkbox :model-value="selectedIdx.includes(sheets.indexOf(row))"
                           @change="(v) => {
                             const i = sheets.indexOf(row);
                             selectedIdx = v ? [...selectedIdx, i] : selectedIdx.filter((x) => x !== i);
                           }" />
            </template>
          </el-table-column>
          <el-table-column label="工作表（内容预览）" min-width="260">
            <template #default="{ row }">
              <div style="font-weight:600">{{ row.sheet_name }}</div>
              <div style="font-size:12px;color:#909399">
                数据 {{ row.total_rows }} 行<template v-if="row._header_row && row._header_row > 1">，已自动跳过前 {{ row._header_row - 1 }} 行标题</template>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="前 3 行" min-width="280">
            <template #default="{ row }">
              <div style="font-size:12px;color:#606266;line-height:1.6" v-for="(r, i) in row.rows.slice(0, 3)" :key="i">
                {{ (r || []).filter((c) => c !== '' && c != null).join(' | ') || '（空行）' }}
              </div>
            </template>
          </el-table-column>
          <el-table-column label="导入到班级" width="190">
            <template #default="{ row }">
              <el-select v-model="sheetClassId[sheets.indexOf(row)]" size="small" style="width:100%"
                         placeholder="选择班级">
                <el-option v-for="c in store.classes" :key="c.id" :label="c.name" :value="c.id" />
              </el-select>
            </template>
          </el-table-column>
        </el-table>
        <div style="font-size:12px;color:#909399;margin-top:6px">
          目标班级须先存在：可在「设置」页新建，或
          <el-link type="primary" :underline="false" @click="refreshClasses">点此刷新班级列表</el-link>
        </div>
      </div>

      <!-- ==================== Step 2 映射（单表） ==================== -->
      <div v-else-if="currentPane === 'map'">
        <el-alert v-if="mappingLoaded" type="success" show-icon :closable="false"
                  style="margin-bottom:12px" title="已按列名恢复你上一次的映射选择，可直接继续，也可以修改" />
        <el-alert v-if="parsed.sheet_count > 1" type="info" show-icon :closable="false"
                  style="margin-bottom:12px"
                  :title="'文件包含 ' + parsed.sheet_count + ' 个工作表，本次只导入当前选择的这一张'">
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

        <div v-if="parsed.file_kind === 'excel' && viewSheet" style="margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:12px;color:#606266">列名所在行（自动跳过整行标题）：</span>
          <el-input-number v-model="headerRow" :min="1" :max="Math.max(viewSheet._raw_grid ? viewSheet._raw_grid.length : 1, 1)"
                           size="small" controls-position="right" style="width:120px" />
          <el-button size="small" @click="headerRow = null">恢复自动（第 {{ viewSheet._header_row || 1 }} 行）</el-button>
          <el-button v-if="isStudents" size="small" type="primary" plain @click="mapping = autoMapFor(viewSheet); ElMessage.success('已按列名自动映射，请核对')">
            按列名自动映射
          </el-button>
        </div>

        <!-- 文件列 → 系统字段 映射表 -->
        <div v-if="isExam" style="font-size:12px;color:#909399;margin-bottom:6px">
          左列第 1、2 列选「学号 / 姓名」作关联依据；其余科目列直接选同名列名即可
          （候选来自本文件列名，就这几科，无需手输）；无关列选「忽略此列」。
          <div v-if="hasLangTypeCol" style="margin-top:4px;color:#2b5da8;line-height:1.7">
            检测到本表有「外语类型」列（每行 英语/日语）且外语成绩只占一列：请把「外语类型」列映射为
            <b>外语类型（拆 日语/英语）</b>，「外语」列选「外语」。入库时系统会按每行的语种自动拆成
            <b>日语、英语</b> 两科——成绩分析可按日语、英语分别统计。
          </div>
        </div>
        <el-table :data="columns" border size="small" max-height="300">
          <el-table-column label="文件列名" min-width="180">
            <template #default="{ row }">{{ row.label }}</template>
          </el-table-column>
          <el-table-column label="映射到系统字段" min-width="280">
            <template #default="{ row }">
              <el-select v-model="mapping[String(row.idx)]" placeholder="请选择（含忽略此列）"
                         size="small" style="width:100%">
                <el-option v-for="o in optionsFor(row.label)" :key="o.value" :label="o.label" :value="o.value" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="已映射" min-width="120">
            <template #default="{ row }">
              <el-tag v-if="mapping[String(row.idx)] && mapping[String(row.idx)] !== '__ignore__'"
                      size="small" type="success">{{ fieldLabelFor(mapping, String(row.idx)) }}</el-tag>
              <el-tag v-else-if="mapping[String(row.idx)] === '__ignore__'" size="small" type="info">忽略</el-tag>
              <span v-else style="color:#c0c4cc">未选择</span>
            </template>
          </el-table-column>
        </el-table>

        <!-- 预览前 10 行 -->
        <el-table v-if="viewSheet" :data="viewSheet.rows" border size="small"
                  max-height="220" style="margin-top:12px">
          <el-table-column v-for="(h, i) in viewSheet.headers" :key="i"
                           :label="h || ('列' + (i+1))" min-width="100">
            <template #default="{ row }">{{ row[i] }}</template>
          </el-table-column>
        </el-table>
        <div style="color:#909399;font-size:12px;margin-top:6px">
          共 {{ viewSheet?.total_rows || 0 }} 行，上方为前 {{ viewSheet?.preview_limit || 10 }} 行预览
          <template v-if="viewSheet?._header_row && viewSheet._header_row > 1">
            （已自动跳过前 {{ viewSheet._header_row - 1 }} 行整行标题/说明行）
          </template>
          <template v-if="headerRow !== null">
            ，列名行已手动设为第 {{ headerRow }} 行
          </template>
        </div>
      </div>

      <!-- ==================== Step 3 映射（多表，逐表 tabs） ==================== -->
      <div v-else-if="currentPane === 'mapMulti'">
        <el-tabs v-model="selTab">
          <el-tab-pane v-for="(s, j) in selSheets" :key="s.sheet_name"
                       :name="String(j)" :label="s.sheet_name">
            <template #default>
              <div style="margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span style="font-size:12px;color:#606266">列名所在行：</span>
                <el-input-number v-model="hrBySheet[selectedIdx[j]]" :min="1"
                                 :max="Math.max(s._raw_grid ? s._raw_grid.length : 1, 1)"
                                 size="small" controls-position="right" style="width:120px" />
                <el-button size="small" @click="setHrAuto(selectedIdx[j])">恢复自动</el-button>
                <template v-if="isStudents">
                  <el-button size="small" type="primary" plain @click="autoMapSheet(selectedIdx[j])">按列名自动映射</el-button>
                  <el-button v-if="j > 0" size="small" @click="copyMappingFromFirst(j)">套用第一张表的映射</el-button>
                  <el-tag v-if="autoMappedBySheet[selectedIdx[j]]" size="small" type="success">已自动映射，请核对</el-tag>
                </template>
              </div>

              <el-table :data="columnsOf(sheetViewOf(selectedIdx[j]))" border size="small" max-height="280">
                <el-table-column label="文件列名" min-width="150">
                  <template #default="{ row }">{{ row.label }}</template>
                </el-table-column>
                <el-table-column label="映射到系统字段" min-width="220">
                  <template #default="{ row }">
                    <el-select v-model="mapBySheet[selectedIdx[j]][String(row.idx)]" size="small"
                               placeholder="请选择（含忽略此列）" style="width:100%">
                      <el-option v-for="o in FIELD_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column label="已映射" min-width="110">
                  <template #default="{ row }">
                    <el-tag v-if="mapBySheet[selectedIdx[j]][String(row.idx)] && mapBySheet[selectedIdx[j]][String(row.idx)] !== '__ignore__'"
                            size="small" type="success">{{ fieldLabelFor(mapBySheet[selectedIdx[j]], row.idx) }}</el-tag>
                    <el-tag v-else-if="mapBySheet[selectedIdx[j]][String(row.idx)] === '__ignore__'"
                            size="small" type="info">忽略</el-tag>
                    <span v-else style="color:#c0c4cc">未选择</span>
                  </template>
                </el-table-column>
              </el-table>

              <el-table v-if="sheetViewOf(selectedIdx[j])" :data="sheetViewOf(selectedIdx[j]).rows"
                        border size="small" max-height="200" style="margin-top:10px">
                <el-table-column v-for="(h, i) in sheetViewOf(selectedIdx[j]).headers" :key="i"
                                 :label="h || ('列' + (i+1))" min-width="90">
                  <template #default="{ row }">{{ row[i] }}</template>
                </el-table-column>
              </el-table>
              <div style="color:#909399;font-size:12px;margin-top:4px">
                导入到：{{ store.classes.find((c) => c.id === sheetClassId[selectedIdx[j]])?.name || '（未选班级）' }}；
                数据 {{ sheetViewOf(selectedIdx[j])?.total_rows || 0 }} 行
              </div>
            </template>
          </el-tab-pane>
        </el-tabs>
      </div>

      <!-- ==================== Step 3 预览确认（单表） ==================== -->
      <div v-else-if="currentPane === 'preview' && preview">
        <el-alert type="warning" show-icon :closable="false" style="margin-bottom:12px"
                  v-if="preview.conflict_count > 0"
                  :title="'检测到 ' + preview.conflict_count + ' 行与现有数据冲突（同班学号已存在）'">
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

        <el-alert v-if="isExam && preview.error_count > 0" type="error" show-icon :closable="false"
                  style="margin-bottom:12px"
                  :title="'共 ' + preview.error_count + ' 条数据错误：现在点确认会被拒绝并整体回滚，不会写入任何数据'">
          <template #default>
            <div v-if="examErrorGroups.length" style="margin-top:8px">
              <el-tag v-for="(g, gi) in examErrorGroups" :key="gi" type="danger" size="small"
                      style="margin:0 6px 6px 0">
                {{ g.text }} ×{{ g.n }}（首见第 {{ g.first }} 行）
              </el-tag>
            </div>
            <div style="margin-top:8px;font-size:12px;line-height:1.9">
              成绩、总分与「进/退」允许范围为 <b>-1000～750</b>，支持小数和负数。
              请点下方「上一步」回到字段映射：需要保存的单科、总分和进/退列可以保留；排名、学考等不需要进入成绩分析的列
              请<b>保持未选择</b>或选「忽略此列」。外语类型列仍选「外语类型（拆 日语/英语）」，然后重新预览。
            </div>
          </template>
        </el-alert>

        <el-table :data="pagedRows" border size="small" max-height="380"
                  :row-class-name="({ row }) => (row.conflict || (row.errors && row.errors.length)) ? 'import-conflict-row' : ''">
          <el-table-column label="行号" width="70">
            <template #default="{ row }">{{ rowNo(row) }}</template>
          </el-table-column>
          <!-- students: 映射字段 -->
          <template v-if="isStudents">
            <el-table-column v-for="(opt) in Object.entries(mapping).filter(([,v]) => v && v !== '__ignore__')"
                             :key="'col-' + opt[0]" :label="labelOfField(opt[1])" min-width="110">
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
            <el-table-column label="检查" width="210" fixed="right">
              <template #default="{ row }">
                <el-tooltip placement="top" :disabled="!(row.errors && row.errors.length > 1)">
                  <template #content>
                    <div v-for="(er, ei) in (row.errors || [])" :key="ei" style="font-size:12px">
                      第 {{ row.row_no || rowNo(row) }} 行：{{ er.message }}
                    </div>
                  </template>
                  <el-tag v-if="row.errors && row.errors.length" type="danger" size="small">
                    {{ errCellText(row) }}
                  </el-tag>
                  <span v-else style="color:#909399">正常</span>
                </el-tooltip>
              </template>
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

        <el-checkbox v-if="!(isExam && preview.error_count > 0)" v-model="confirmed"
                     style="margin-top:12px;font-weight:600">
          我已核对数据无误（共 {{ preview.total }} 行），确认入库
        </el-checkbox>
        <div v-else style="margin-top:12px;color:#f56c6c;font-size:13px">
          还有 {{ preview.error_count }} 条错误未处理，请先「上一步」修正字段映射（问题行已标红、右侧“检查”列可见具体原因）
        </div>
      </div>

      <!-- ==================== Step 4 预览确认（多表） ==================== -->
      <div v-else-if="currentPane === 'previewMulti'">
        <el-tabs v-model="selTab">
          <el-tab-pane v-for="(s, j) in selSheets" :key="s.sheet_name"
                       :name="String(j)"
                       :label="s.sheet_name + (previewsBySheet[selectedIdx[j]]?.conflict_count ? '（冲突 ' + previewsBySheet[selectedIdx[j]].conflict_count + '）' : '')">
            <template #default>
              <el-alert type="info" show-icon :closable="false" style="margin-bottom:10px">
                <template #title>
                  导入到「{{ store.classes.find((c) => c.id === sheetClassId[selectedIdx[j]])?.name || '未选班级' }}」，
                  共 {{ previewsBySheet[selectedIdx[j]]?.total || 0 }} 行
                </template>
              </el-alert>
              <el-alert v-if="previewsBySheet[selectedIdx[j]]?.conflict_count > 0"
                        type="warning" show-icon :closable="false" style="margin-bottom:10px"
                        :title="'检测到 ' + previewsBySheet[selectedIdx[j]].conflict_count + ' 行冲突'">
                <template #default>
                  <span>冲突处理：</span>
                  <el-radio-group size="small" :model-value="resModeBySheet[selectedIdx[j]] || 'skip'"
                                  @change="(m) => applyResModeFor(selectedIdx[j], m)">
                    <el-radio-button label="overwrite">全部覆盖已有记录</el-radio-button>
                    <el-radio-button label="skip">全部跳过冲突行</el-radio-button>
                  </el-radio-group>
                </template>
              </el-alert>
              <el-table :data="previewsBySheet[selectedIdx[j]]?.rows || []" border size="small"
                        max-height="360"
                        :row-class-name="({ row }) => row.conflict ? 'import-conflict-row' : ''">
                <el-table-column label="行号" width="70">
                  <template #default="{ row }">
                    {{ row.index + (previewsBySheet[selectedIdx[j]].header_row || 1) + 1 }}
                  </template>
                </el-table-column>
                <el-table-column v-for="opt in Object.entries(mapBySheet[selectedIdx[j]] || {}).filter(([, v]) => v && v !== '__ignore__')"
                                 :key="'c' + opt[0]" :label="labelOfField(opt[1])" min-width="100">
                  <template #default="{ row }">{{ row.values[opt[1]] || '—' }}</template>
                </el-table-column>
                <el-table-column label="冲突" width="210">
                  <template #default="{ row }">
                    <el-tag v-if="row.conflict" type="danger" size="small">{{ row.conflict.message }}</el-tag>
                    <el-tag v-else type="success" size="small">无冲突</el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="处理方式" width="140">
                  <template #default="{ row }">
                    <el-select v-if="row.conflict" :model-value="resBySheet[selectedIdx[j]]?.[String(row.index)]"
                               size="small" placeholder="选择"
                               @change="(v) => resBySheet[selectedIdx[j]][String(row.index)] = v">
                      <el-option label="覆盖" value="overwrite" />
                      <el-option label="跳过" value="skip" />
                    </el-select>
                    <span v-else style="color:#909399">新增</span>
                  </template>
                </el-table-column>
              </el-table>
            </template>
          </el-tab-pane>
        </el-tabs>
        <el-checkbox v-model="confirmedAll" style="margin-top:12px;font-weight:600">
          我已逐表核对数据无误（共 {{ selectedIdx.length }} 张表），确认入库
        </el-checkbox>
      </div>

      <!-- ==================== Step 5 结果汇总（多表） ==================== -->
      <div v-else-if="currentPane === 'result'">
        <el-alert :type="multiFinished() ? 'success' : 'warning'" show-icon :closable="false"
                  style="margin-bottom:12px"
                  :title="multiFinished() ? '全部工作表已成功导入' : '部分工作表导入失败，其余已正常入库（每表独立事务）'">
        </el-alert>
        <el-table :data="selSheets.map((s, j) => ({ s, j }))" border size="small">
          <el-table-column label="工作表" min-width="130">
            <template #default="{ row }">{{ row.s.sheet_name }}</template>
          </el-table-column>
          <el-table-column label="目标班级" min-width="140">
            <template #default="{ row }">
              {{ store.classes.find((c) => c.id === sheetClassId[selectedIdx[row.j]])?.name || '—' }}
            </template>
          </el-table-column>
          <el-table-column label="结果" min-width="400">
            <template #default="{ row }">
              <template v-if="resultsBySheet[selectedIdx[row.j]]?.error">
                <el-tag type="danger" size="small">失败</el-tag>
                <span style="color:#f56c6c;font-size:12px;margin-left:6px">
                  {{ resultsBySheet[selectedIdx[row.j]].error }}
                </span>
              </template>
              <template v-else-if="resultsBySheet[selectedIdx[row.j]]">
                <el-tag type="success" size="small">成功</el-tag>
                <span style="font-size:12px;color:#606266;margin-left:6px">
                  新增 {{ resultsBySheet[selectedIdx[row.j]].inserted ?? 0 }} 人
                  <template v-if="(resultsBySheet[selectedIdx[row.j]].restored ?? 0)">、恢复 {{ resultsBySheet[selectedIdx[row.j]].restored }} 人</template>
                  <template v-if="(resultsBySheet[selectedIdx[row.j]].updated ?? 0)">、覆盖 {{ resultsBySheet[selectedIdx[row.j]].updated }} 人</template>
                  <template v-if="(resultsBySheet[selectedIdx[row.j]].skipped ?? 0)">、跳过 {{ resultsBySheet[selectedIdx[row.j]].skipped }} 人</template>
                  <template v-if="(resultsBySheet[selectedIdx[row.j]].errors || []).length">
                    、<span style="color:#e6a23c">{{ resultsBySheet[selectedIdx[row.j]].errors.length }} 行提示</span>
                  </template>
                </span>
              </template>
              <span v-else style="color:#c0c4cc">未执行</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="160">
            <template #default="{ row }">
              <el-button v-if="resultsBySheet[selectedIdx[row.j]]?.error" size="small" type="primary"
                         :loading="loading" @click="retrySheet(selectedIdx[row.j])">重试该表</el-button>
              <template v-else-if="(resultsBySheet[selectedIdx[row.j]]?.errors || []).length">
                <el-tooltip placement="top">
                  <template #content>
                    <div v-for="(er, ei) in resultsBySheet[selectedIdx[row.j]].errors" :key="ei"
                         style="font-size:12px">第 {{ er.row }} 行：{{ er.message }}</div>
                  </template>
                  <el-tag type="warning" size="small">有提示</el-tag>
                </el-tooltip>
              </template>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <!-- 结果（单表） -->
      <template #footer>
        <div style="display:flex;justify-content:space-between">
          <div>
            <el-button v-if="currentPane !== 'upload'" @click="backPane">上一步</el-button>
            <el-button v-if="currentPane === 'upload'" @click="close">取消</el-button>
          </div>
          <div v-if="showResult && !multiMode">
            <el-tag type="success" size="large" style="margin-right:8px">
              导入完成：新增 {{ result?.inserted ?? 0 }}、恢复 {{ result?.restored ?? 0 }}、覆盖 {{ result?.updated ?? 0 }}、跳过 {{ result?.skipped ?? 0 }}
            </el-tag>
          </div>
          <div>
            <!-- 多表：选表选班 → 下一步 -->
            <el-button v-if="currentPane === 'pick'" type="primary" @click="canLeavePickPane() && (ensureSheetMaps(), activePane = 3)">
              下一步：配置字段映射
            </el-button>
            <!-- 多表：映射 → 预览 -->
            <el-button v-if="currentPane === 'mapMulti'" type="primary" :loading="loading"
                       @click="runPreviewMulti">
              下一步：预览与冲突检测
            </el-button>
            <!-- 多表：预览 → 确认 -->
            <el-button v-if="currentPane === 'previewMulti'" type="primary" :loading="loading"
                       :disabled="!confirmedAll" @click="confirmImportMulti">
              确认入库（每表独立事务）
            </el-button>
            <!-- 多表：结果 -->
            <template v-if="currentPane === 'result'">
              <el-button v-if="!multiFinished()" @click="activePane = 4">返回预览修正</el-button>
              <el-button type="primary" @click="close">完成并关闭</el-button>
            </template>
            <!-- 单表 -->
            <el-button v-if="currentPane === 'map'" type="primary" :loading="loading"
                       @click="nextFromMapping">
              下一步：预览与冲突检测
            </el-button>
            <el-button v-if="currentPane === 'preview' && !multiMode" type="primary" :loading="loading"
                       @click="confirmImport">
              确认入库（事务写入）
            </el-button>
          </div>
        </div>
      </template>
    </el-dialog>
    `,
  };

  window.ImportModal = Component;
})();
